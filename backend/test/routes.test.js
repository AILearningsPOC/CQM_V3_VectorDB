// Route-level tests: real Express app, real HTTP via fetch, services patched.
const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { makeBuilder, patchSupabase, clearAxiosHandler } = require('./helpers');

const express = require('express');
const kbStore = require('../src/services/kbStore');
const qdrant = require('../src/services/qdrant');

let server, base;
let restoreSupabase = null;
let saved = {};

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/knowledge-base', require('../src/routes/knowledgeBase'));
  app.use('/api/health', require('../src/routes/health'));
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server && server.close());

beforeEach(() => {
  clearAxiosHandler();
  saved = {
    insertKBEntry: kbStore.insertKBEntry,
    deleteKBEntry: kbStore.deleteKBEntry,
    backfillVectors: kbStore.backfillVectors,
    reconcile: kbStore.reconcile,
    ping: qdrant.ping,
    getCapacityStatus: qdrant.getCapacityStatus
  };
});

afterEach(() => {
  Object.assign(kbStore, saved);
  qdrant.ping = saved.ping;
  qdrant.getCapacityStatus = saved.getCapacityStatus;
  if (restoreSupabase) { restoreSupabase(); restoreSupabase = null; }
});

// ── GET /api/knowledge-base ──────────────────────────────────────
test('GET /knowledge-base returns rows incl. v3 sync fields, honors filters', async () => {
  restoreSupabase = patchSupabase(() => {
    const b = makeBuilder({ data: [{ id: '1', title: 'T', qdrant_point_id: '1', vector_synced_at: 'now' }], error: null, count: 1 });
    return b;
  });
  const res = await fetch(`${base}/api/knowledge-base?category=warranty&search=year`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.total, 1);
  assert.equal(body.data[0].qdrant_point_id, '1');
});

test('GET /knowledge-base surfaces Supabase errors as HTTP 500 with the message', async () => {
  restoreSupabase = patchSupabase(() => makeBuilder({ data: null, error: { message: 'db exploded' }, count: null }));
  const res = await fetch(`${base}/api/knowledge-base`);
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /db exploded/);
});

// ── DELETE ───────────────────────────────────────────────────────
test('DELETE /knowledge-base/:id returns success via kbStore', async () => {
  let calledWith = null;
  kbStore.deleteKBEntry = async (id) => { calledWith = id; return true; };
  const res = await fetch(`${base}/api/knowledge-base/abc-1`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).success, true);
  assert.equal(calledWith, 'abc-1');
});

test('DELETE /knowledge-base/:id → 404 for a missing entry', async () => {
  kbStore.deleteKBEntry = async () => { const e = new Error('KB entry not found'); e.notFound = true; throw e; };
  const res = await fetch(`${base}/api/knowledge-base/ghost`, { method: 'DELETE' });
  assert.equal(res.status, 404);
});

test('DELETE /knowledge-base/:id → 500 with actionable message when Qdrant delete fails', async () => {
  kbStore.deleteKBEntry = async () => { throw new Error('Qdrant server error (500) during delete point'); };
  const res = await fetch(`${base}/api/knowledge-base/abc-1`, { method: 'DELETE' });
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /Qdrant server error/);
});

// ── RECONCILE + BACKFILL ─────────────────────────────────────────
test('POST /knowledge-base/reconcile defaults to dry run', async () => {
  let fixArg = 'unset';
  kbStore.reconcile = async ({ fix }) => { fixArg = fix; return { consistent: true, fixed: null }; };
  const res = await fetch(`${base}/api/knowledge-base/reconcile`, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal(fixArg, false);
});

test('POST /knowledge-base/reconcile?fix=true triggers repairs', async () => {
  let fixArg = 'unset';
  kbStore.reconcile = async ({ fix }) => { fixArg = fix; return { consistent: false, fixed: { points_deleted: 1, rows_resynced: 0, failures: [] } }; };
  const res = await fetch(`${base}/api/knowledge-base/reconcile?fix=true`, { method: 'POST' });
  assert.equal((await res.json()).fixed.points_deleted, 1);
  assert.equal(fixArg, true);
});

test('POST /knowledge-base/backfill-embeddings keeps the v2 endpoint contract', async () => {
  kbStore.backfillVectors = async () => ({ done: 3, total: 3, failures: [], message: '3/3 vectors synced to Qdrant' });
  const res = await fetch(`${base}/api/knowledge-base/backfill-embeddings`, { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.done, 3); // frontend reads r.done / r.total — unchanged
  assert.equal(body.total, 3);
});

test('POST /knowledge-base/backfill-embeddings surfaces total failure as 500', async () => {
  kbStore.backfillVectors = async () => { throw new Error('Backfill query failed: db down'); };
  const res = await fetch(`${base}/api/knowledge-base/backfill-embeddings`, { method: 'POST' });
  assert.equal(res.status, 500);
});

// ── UPLOAD-PDF (negative paths; positive path covered in kbStore tests) ─
test('POST /knowledge-base/upload-pdf without a file → 400', async () => {
  const res = await fetch(`${base}/api/knowledge-base/upload-pdf`, { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=x' }, body: '--x--\r\n' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /No PDF uploaded/);
});

test('POST /knowledge-base/upload-pdf with a corrupt PDF → 400, nothing stored', async () => {
  kbStore.insertKBEntry = async () => { throw new Error('must not store anything for a corrupt PDF'); };
  const boundary = 'testboundary';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="pdf"; filename="bad.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
    Buffer.from('this is not a real pdf at all'),
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
  const res = await fetch(`${base}/api/knowledge-base/upload-pdf`, {
    method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Could not extract text/);
});

// ── ROUTE ORDERING (fixed paths must not be shadowed by /:id) ────
test('fixed-path routes are not shadowed by GET /:id', async () => {
  // If /reconcile were swallowed by /:id it would hit Supabase single() and 404.
  kbStore.reconcile = async () => ({ consistent: true, fixed: null });
  restoreSupabase = patchSupabase(() => { throw new Error('GET /:id handler must not run for /reconcile'); });
  const res = await fetch(`${base}/api/knowledge-base/reconcile`, { method: 'POST' });
  assert.equal(res.status, 200);
});

// ── HEALTH ───────────────────────────────────────────────────────
test('GET /health reports Qdrant status and capacity alongside Supabase', async () => {
  qdrant.ping = async () => ({ connected: true, points_count: 24 });
  qdrant.getCapacityStatus = async () => ({ points_count: 24, estimated_usage_pct: 0.1, warning: null });
  restoreSupabase = patchSupabase(() => makeBuilder({ data: null, error: null, count: 5 }));
  const res = await fetch(`${base}/api/health`);
  const body = await res.json();
  assert.equal(body.version, '3.0.0');
  assert.equal(body.qdrant.connected, true);
  assert.equal(body.qdrant_capacity.points_count, 24);
  assert.equal(body.qdrant_configured, true);
});

test('GET /health stays 200 and reports errors when both stores are down', async () => {
  qdrant.ping = async () => ({ connected: false, error: 'Qdrant unreachable (ECONNREFUSED)' });
  restoreSupabase = patchSupabase(() => makeBuilder(Promise.reject(new Error('supabase down'))));
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200, 'health must never 500 — it is the diagnostics endpoint');
  const body = await res.json();
  assert.equal(body.db_connected, false);
  assert.equal(body.qdrant.connected, false);
  assert.match(body.qdrant.error, /unreachable/);
});

// ── ENRICHMENT approve→KB flow ───────────────────────────────────
test('addApprovedAnswerToKB routes through kbStore and never throws to caller', async () => {
  const { addApprovedAnswerToKB } = require('../src/services/enrichment');
  let inserted = null;
  kbStore.insertKBEntry = async (entry) => { inserted = entry; return { id: 'x', vectorized: true, warning: null }; };
  await addApprovedAnswerToKB({ question_text: 'Does it support HDMI 2.1?' }, 'Yes, on ports 1-2.', 'compatibility');
  assert.equal(inserted.source, 'approved_answer');
  assert.match(inserted.content, /^Q: Does it support HDMI 2\.1\?\nA: Yes/);

  // total two-store failure must be logged, not thrown (auto-approve flow must not break)
  kbStore.insertKBEntry = async () => { throw new Error('both stores down'); };
  await assert.doesNotReject(() => addApprovedAnswerToKB({ question_text: 'q' }, 'a', 'other'));
});
