const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { makeBuilder, patchSupabase, clearAxiosHandler } = require('./helpers');

const embeddingSvc = require('../src/services/embedding');
const qdrant = require('../src/services/qdrant');
const kbStore = require('../src/services/kbStore');

const VEC = new Array(384).fill(0.2);
let restoreSupabase = null;
let saved = {};

beforeEach(() => {
  clearAxiosHandler();
  saved = {
    generateEmbedding: embeddingSvc.generateEmbedding,
    upsertPoint: qdrant.upsertPoint,
    deletePoint: qdrant.deletePoint,
    listAllPointIds: qdrant.listAllPointIds
  };
  embeddingSvc.generateEmbedding = async () => VEC;
  qdrant.upsertPoint = async (id) => id;
  qdrant.deletePoint = async () => true;
  qdrant.listAllPointIds = async () => [];
});

afterEach(() => {
  Object.assign(embeddingSvc, { generateEmbedding: saved.generateEmbedding });
  Object.assign(qdrant, { upsertPoint: saved.upsertPoint, deletePoint: saved.deletePoint, listAllPointIds: saved.listAllPointIds });
  if (restoreSupabase) { restoreSupabase(); restoreSupabase = null; }
});

// ── INSERT: happy path ───────────────────────────────────────────
test('insert: writes Qdrant FIRST, then Supabase, with matching UUIDs', async () => {
  const order = [];
  let insertedRow = null;
  qdrant.upsertPoint = async (id, vector, payload) => { order.push('qdrant'); assert.equal(vector.length, 384); assert.equal(payload.supabase_id, id); return id; };
  restoreSupabase = patchSupabase((table) => {
    assert.equal(table, 'knowledge_base');
    order.push('supabase');
    const b = makeBuilder({ data: null, error: null });
    const origInsert = b.insert;
    b.insert = (row) => { insertedRow = row; return origInsert(row); };
    return b;
  });

  const result = await kbStore.insertKBEntry({ title: 'T', content: 'hello world', category: 'usage', source: 'manual' });
  assert.deepEqual(order, ['qdrant', 'supabase'], 'Qdrant must be written before Supabase');
  assert.equal(result.vectorized, true);
  assert.equal(result.warning, null);
  assert.equal(insertedRow.id, result.id);
  assert.equal(insertedRow.qdrant_point_id, result.id, 'row id and point id are the same UUID');
  assert.ok(insertedRow.vector_synced_at);
});

// ── INSERT: failure mode 1 — Qdrant fails ────────────────────────
test('insert: Qdrant failure degrades to keyword-only row (no orphaned vector)', async () => {
  qdrant.upsertPoint = async () => { throw new Error('Qdrant unreachable during upsert (ECONNREFUSED)'); };
  let insertedRow = null;
  restoreSupabase = patchSupabase(() => {
    const b = makeBuilder({ data: null, error: null });
    const origInsert = b.insert;
    b.insert = (row) => { insertedRow = row; return origInsert(row); };
    return b;
  });

  const result = await kbStore.insertKBEntry({ title: 'T', content: 'content here', category: 'other', source: 'manual' });
  assert.equal(result.vectorized, false);
  assert.match(result.warning, /keyword search only/i, 'failure must be surfaced, not silent');
  assert.equal(insertedRow.qdrant_point_id, null);
  assert.equal(insertedRow.vector_synced_at, null);
});

// ── INSERT: failure mode 2 — Supabase fails after Qdrant succeeded ─
test('insert: Supabase failure triggers compensating Qdrant delete (no orphan)', async () => {
  let deletedPointId = null;
  qdrant.deletePoint = async (id) => { deletedPointId = id; return true; };
  restoreSupabase = patchSupabase(() => makeBuilder({ data: null, error: { message: 'connection lost' } }));

  await assert.rejects(() => kbStore.insertKBEntry({ title: 'T', content: 'abc', category: 'x', source: 'manual' }), /KB insert failed: connection lost/);
  assert.ok(deletedPointId, 'compensating delete must have run');
});

test('insert: compensating delete failure logs a loud ORPHAN error but still surfaces the insert failure', async () => {
  qdrant.deletePoint = async () => { throw new Error('also down'); };
  restoreSupabase = patchSupabase(() => makeBuilder({ data: null, error: { message: 'connection lost' } }));

  const errors = [];
  const origError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    await assert.rejects(() => kbStore.insertKBEntry({ title: 'T', content: 'abc', category: 'x', source: 'manual' }), /KB insert failed/);
  } finally { console.error = origError; }
  assert.ok(errors.some(e => e.includes('ORPHANED QDRANT POINT')), 'orphan must be logged loudly with the point id');
});

// ── INSERT: embedding fails ──────────────────────────────────────
test('insert: embedding failure stores keyword-only row and never calls Qdrant', async () => {
  embeddingSvc.generateEmbedding = async () => { throw new Error('HF down'); };
  qdrant.upsertPoint = async () => { throw new Error('Qdrant must not be called without a vector'); };
  restoreSupabase = patchSupabase(() => makeBuilder({ data: null, error: null }));

  const result = await kbStore.insertKBEntry({ title: 'T', content: 'abc', category: 'x', source: 'manual' });
  assert.equal(result.vectorized, false);
  assert.match(result.warning, /Embedding failed/);
});

test('insert: empty content is rejected before touching any store', async () => {
  await assert.rejects(() => kbStore.insertKBEntry({ title: 'T', content: '   ' }), /content is required/);
});

// ── DELETE ───────────────────────────────────────────────────────
test('delete: removes Qdrant point FIRST, then the Supabase row', async () => {
  const order = [];
  qdrant.deletePoint = async (id) => { order.push(`qdrant:${id}`); return true; };
  restoreSupabase = patchSupabase(() => {
    const b = makeBuilder({ data: { id: 'row-1', qdrant_point_id: 'row-1' }, error: null });
    const origDelete = b.delete;
    b.delete = (...a) => { order.push('supabase-delete'); return origDelete(...a); };
    return b;
  });
  await kbStore.deleteKBEntry('row-1');
  assert.deepEqual(order, ['qdrant:row-1', 'supabase-delete']);
});

test('delete: aborts (keeps the row) when the Qdrant delete fails', async () => {
  qdrant.deletePoint = async () => { throw new Error('Qdrant server error (500)'); };
  let rowDeleted = false;
  restoreSupabase = patchSupabase(() => {
    const b = makeBuilder({ data: { id: 'row-1', qdrant_point_id: 'row-1' }, error: null });
    const origDelete = b.delete;
    b.delete = (...a) => { rowDeleted = true; return origDelete(...a); };
    return b;
  });
  await assert.rejects(() => kbStore.deleteKBEntry('row-1'), /server error/);
  assert.equal(rowDeleted, false, 'Supabase row must survive if the vector could not be removed');
});

test('delete: entry without a vector skips Qdrant entirely', async () => {
  qdrant.deletePoint = async () => { throw new Error('must not be called'); };
  restoreSupabase = patchSupabase(() => makeBuilder({ data: { id: 'row-2', qdrant_point_id: null }, error: null }));
  const ok = await kbStore.deleteKBEntry('row-2');
  assert.equal(ok, true);
});

test('delete: missing entry throws notFound', async () => {
  restoreSupabase = patchSupabase(() => makeBuilder({ data: null, error: { message: 'No rows' } }));
  await assert.rejects(() => kbStore.deleteKBEntry('ghost'), (err) => err.notFound === true);
});

// ── BACKFILL ─────────────────────────────────────────────────────
test('backfill: vectorizes unsynced rows and reports per-row failures', async () => {
  const rows = [{ id: 'a', content: 'one' }, { id: 'b', content: 'two' }, { id: 'c', content: 'three' }];
  qdrant.upsertPoint = async (id) => { if (id === 'b') throw new Error('capacity exhausted'); return id; };
  let call = 0;
  restoreSupabase = patchSupabase(() => {
    call++;
    if (call === 1) return makeBuilder({ data: rows, error: null }); // the select
    return makeBuilder({ data: null, error: null });                 // the updates
  });
  const result = await kbStore.backfillVectors(50);
  assert.equal(result.total, 3);
  assert.equal(result.done, 2);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].id, 'b');
  assert.match(result.failures[0].error, /capacity/);
});

test('backfill: reports cleanly when nothing needs syncing', async () => {
  restoreSupabase = patchSupabase(() => makeBuilder({ data: [], error: null }));
  const result = await kbStore.backfillVectors(50);
  assert.equal(result.done, 0);
  assert.match(result.message, /already have vectors/);
});

// ── RECONCILE ────────────────────────────────────────────────────
test('reconcile (dry run): detects orphaned points and unsynced rows without fixing', async () => {
  qdrant.listAllPointIds = async () => ['row-1', 'orphan-9'];
  qdrant.deletePoint = async () => { throw new Error('must not fix in dry run'); };
  restoreSupabase = patchSupabase(() => makeBuilder({ data: [
    { id: 'row-1', content: 'x', qdrant_point_id: 'row-1' },   // consistent
    { id: 'row-2', content: 'y', qdrant_point_id: null }        // unsynced
  ], error: null }));

  const report = await kbStore.reconcile({ fix: false });
  assert.equal(report.consistent, false);
  assert.deepEqual(report.orphaned_qdrant_points, ['orphan-9']);
  assert.deepEqual(report.unsynced_supabase_rows, ['row-2']);
  assert.equal(report.fixed, null);
});

test('reconcile (fix): deletes orphaned points and resyncs unsynced rows', async () => {
  const deleted = [];
  const upserted = [];
  qdrant.listAllPointIds = async () => ['row-1', 'orphan-9'];
  qdrant.deletePoint = async (id) => { deleted.push(id); return true; };
  qdrant.upsertPoint = async (id) => { upserted.push(id); return id; };
  let call = 0;
  restoreSupabase = patchSupabase(() => {
    call++;
    if (call === 1) return makeBuilder({ data: [
      { id: 'row-1', content: 'x', qdrant_point_id: 'row-1' },
      { id: 'row-2', content: 'y', qdrant_point_id: null }
    ], error: null });
    return makeBuilder({ data: null, error: null });
  });

  const report = await kbStore.reconcile({ fix: true });
  assert.deepEqual(deleted, ['orphan-9']);
  assert.deepEqual(upserted, ['row-2']);
  assert.equal(report.fixed.points_deleted, 1);
  assert.equal(report.fixed.rows_resynced, 1);
  assert.equal(report.fixed.failures.length, 0);
});

test('reconcile: a row synced to a point that vanished from Qdrant counts as unsynced', async () => {
  qdrant.listAllPointIds = async () => []; // Qdrant lost everything (e.g. collection recreated)
  restoreSupabase = patchSupabase(() => makeBuilder({ data: [
    { id: 'row-1', content: 'x', qdrant_point_id: 'row-1' }
  ], error: null }));
  const report = await kbStore.reconcile({ fix: false });
  assert.deepEqual(report.unsynced_supabase_rows, ['row-1']);
});
