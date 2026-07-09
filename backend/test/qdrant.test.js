const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { setAxiosHandler, clearAxiosHandler, netError } = require('./helpers');
const qdrant = require('../src/services/qdrant');

const VEC = new Array(384).fill(0.1);
const COLL_OK = { status: 200, data: { result: { points_count: 10 } } };
const OP_OK = { status: 200, data: { status: 'ok' } };

beforeEach(() => clearAxiosHandler());
afterEach(() => clearAxiosHandler());

test('upsertPoint succeeds when collection exists and capacity is fine', async () => {
  const calls = [];
  setAxiosHandler((cfg) => {
    calls.push(`${cfg.method} ${cfg.url}`);
    if (cfg.method === 'get') return COLL_OK;                    // ensureCollection + capacity
    if (cfg.url.includes('/points?wait=true')) return OP_OK;      // upsert
    throw new Error(`unexpected: ${cfg.url}`);
  });
  const id = await qdrant.upsertPoint('abc-123', VEC, { content: 'x' });
  assert.equal(id, 'abc-123');
  assert.ok(calls.some(c => c.includes('/points?wait=true')));
});

test('upsertPoint creates the collection when missing (404 → PUT collection)', async () => {
  let created = false;
  let getCount = 0;
  setAxiosHandler((cfg) => {
    if (cfg.method === 'get') {
      getCount++;
      if (!created) return { status: 404, data: { status: { error: 'not found' } } };
      return COLL_OK;
    }
    if (cfg.method === 'put' && cfg.url.endsWith('/collections/cqm_kb_test')) { created = true; return OP_OK; }
    if (cfg.url.includes('/points?wait=true')) return OP_OK;
    throw new Error(`unexpected: ${cfg.method} ${cfg.url}`);
  });
  await qdrant.upsertPoint('abc-123', VEC, {});
  assert.ok(created, 'collection should have been created');
  assert.ok(getCount >= 2, 'should re-check capacity after creation');
});

test('upsertPoint rejects a wrong-dimension vector before any network call', async () => {
  setAxiosHandler(() => { throw new Error('network should not be touched'); });
  await assert.rejects(() => qdrant.upsertPoint('id', [0.1, 0.2], {}), /384/);
});

test('transient 500 errors are retried and then succeed', async () => {
  let attempts = 0;
  setAxiosHandler((cfg) => {
    if (cfg.method === 'get') {
      attempts++;
      if (attempts < 3) return { status: 500, data: { status: { error: 'boom' } } };
      return COLL_OK;
    }
    throw new Error('unexpected');
  });
  const info = await qdrant.getCapacityStatus();
  assert.equal(info.points_count, 10);
  assert.equal(attempts, 3);
});

test('auth errors (401) are NOT retried and give an actionable message', async () => {
  let attempts = 0;
  setAxiosHandler(() => { attempts++; return { status: 401, data: {} }; });
  await assert.rejects(() => qdrant.getCapacityStatus(), /QDRANT_API_KEY/);
  assert.equal(attempts, 1, '4xx must not be retried');
});

test('timeouts are classified transient with an actionable message, retried, then surfaced', async () => {
  let attempts = 0;
  setAxiosHandler(() => { attempts++; throw netError('ECONNABORTED'); });
  await assert.rejects(() => qdrant.getCapacityStatus(), /timeout/i);
  assert.equal(attempts, 3, 'timeouts should be retried up to MAX_RETRIES');
});

test('connection-refused is classified with an actionable message', async () => {
  setAxiosHandler(() => { throw netError('ECONNREFUSED'); });
  await assert.rejects(() => qdrant.getCapacityStatus(), /QDRANT_URL/);
});

test('deletePoint treats an already-missing point/collection as success', async () => {
  setAxiosHandler(() => ({ status: 404, data: { status: { error: 'not found' } } }));
  const ok = await qdrant.deletePoint('ghost-id');
  assert.equal(ok, true);
});

test('deletePoint surfaces non-404 failures', async () => {
  setAxiosHandler(() => ({ status: 500, data: { status: { error: 'exploded' } } }));
  await assert.rejects(() => qdrant.deletePoint('id-1'), /server error/i);
});

test('searchPoints maps Qdrant hits into KB-shaped results', async () => {
  setAxiosHandler((cfg) => {
    assert.ok(cfg.url.includes('/points/search'));
    const body = typeof cfg.data === 'string' ? JSON.parse(cfg.data) : cfg.data;
    assert.equal(body.limit, 5);
    assert.equal(body.with_payload, true);
    return { status: 200, data: { result: [
      { id: 'p1', score: 0.91, payload: { title: 'Warranty', content: '1 year', category: 'warranty', source: 'manual' } },
      { id: 'p2', score: 0.42, payload: {} }
    ] } };
  });
  const hits = await qdrant.searchPoints(VEC, 5);
  assert.equal(hits.length, 2);
  assert.deepEqual(hits[0], { id: 'p1', similarity: 0.91, title: 'Warranty', content: '1 year', category: 'warranty', source: 'manual' });
  assert.equal(hits[1].title, null, 'missing payload fields become null, never undefined surprises');
});

test('capacity check blocks upserts when free tier is estimated exhausted', async () => {
  // 3KB/point estimate → 1GB / 3KB ≈ 349,525 points. Use 400k to exceed.
  setAxiosHandler((cfg) => {
    if (cfg.method === 'get') return { status: 200, data: { result: { points_count: 400000 } } };
    throw new Error('upsert must not be attempted when capacity is exhausted');
  });
  await assert.rejects(() => qdrant.upsertPoint('id-1', VEC, {}), /capacity exhausted/i);
});

test('capacity status reports a warning above 80% usage', async () => {
  setAxiosHandler(() => ({ status: 200, data: { result: { points_count: 300000 } } })); // ~86%
  const cap = await qdrant.getCapacityStatus();
  assert.ok(cap.warning, 'expected a capacity warning');
});

test('listAllPointIds paginates through scroll pages', async () => {
  let call = 0;
  setAxiosHandler((cfg) => {
    assert.ok(cfg.url.includes('/points/scroll'));
    call++;
    if (call === 1) return { status: 200, data: { result: { points: [{ id: 'a' }, { id: 'b' }], next_page_offset: 'cursor-1' } } };
    return { status: 200, data: { result: { points: [{ id: 'c' }], next_page_offset: null } } };
  });
  const ids = await qdrant.listAllPointIds();
  assert.deepEqual(ids, ['a', 'b', 'c']);
  assert.equal(call, 2);
});

test('ping never throws — returns connected:false with the error message', async () => {
  setAxiosHandler(() => { throw netError('ENOTFOUND'); });
  const p = await qdrant.ping();
  assert.equal(p.connected, false);
  assert.match(p.error, /unreachable/i);
});

test('missing QDRANT_URL is caught before any network call', async () => {
  const saved = process.env.QDRANT_URL;
  delete process.env.QDRANT_URL;
  setAxiosHandler(() => { throw new Error('must not reach network'); });
  try {
    await assert.rejects(() => qdrant.getCapacityStatus(), /QDRANT_URL not configured/);
  } finally {
    process.env.QDRANT_URL = saved;
  }
});
