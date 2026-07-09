// CQM v3 — Qdrant vector DB client (REST, via axios)
// Design notes:
//  * Every call has an explicit timeout (default 15s) — Qdrant is an external
//    network hop, unlike v2's in-process pgvector SQL.
//  * Retries (max 3, exponential backoff) ONLY on transient failures:
//    network errors, timeouts, HTTP 429/5xx. Never on 4xx (except 429) —
//    retrying a bad request or bad key just burns time.
//  * Errors are classified into actionable messages (auth / not-found /
//    capacity / network) — no silent failures, no generic "request failed".
const axios = require('axios');

const COLLECTION = process.env.QDRANT_COLLECTION || 'cqm_kb';
const VECTOR_DIM = 384; // all-MiniLM-L6-v2
const TIMEOUT_MS = parseInt(process.env.QDRANT_TIMEOUT_MS || '15000');
const MAX_RETRIES = 3;
// Qdrant Cloud free tier = 1GB. Rough per-point cost: 384 floats * 4 bytes
// + payload (~1KB content) + index overhead ≈ 3KB. Warn well before the cliff.
const FREE_TIER_BYTES = 1 * 1024 * 1024 * 1024;
const EST_BYTES_PER_POINT = 3 * 1024;
const CAPACITY_WARN_RATIO = 0.8;

function assertConfigured() {
  if (!process.env.QDRANT_URL) throw new Error('QDRANT_URL not configured');
  if (!process.env.QDRANT_API_KEY) throw new Error('QDRANT_API_KEY not configured');
}

function baseUrl() {
  return process.env.QDRANT_URL.replace(/\/+$/, '');
}

function headers() {
  return { 'api-key': process.env.QDRANT_API_KEY, 'Content-Type': 'application/json' };
}

function classifyError(err, operation) {
  const status = err.response?.status;
  const detail = err.response?.data?.status?.error || err.response?.data?.detail || err.message;
  if (status === 401 || status === 403) return new Error(`Qdrant auth failed during ${operation}: API key invalid or lacks permission. Check QDRANT_API_KEY.`);
  if (status === 404) { const e = new Error(`Qdrant ${operation}: not found (${detail}). Collection may not exist yet.`); e.notFound = true; return e; }
  if (status === 429) { const e = new Error(`Qdrant rate limited during ${operation}. Free tier throughput exceeded.`); e.transient = true; return e; }
  if (status >= 500) { const e = new Error(`Qdrant server error (${status}) during ${operation}: ${detail}`); e.transient = true; return e; }
  if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) { const e = new Error(`Qdrant timeout after ${TIMEOUT_MS}ms during ${operation}. Cloud cluster may be cold or network is slow.`); e.transient = true; return e; }
  if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === 'ECONNRESET') { const e = new Error(`Qdrant unreachable during ${operation} (${err.code}). Check QDRANT_URL and that the cluster is running.`); e.transient = true; return e; }
  return new Error(`Qdrant ${operation} failed (${status || err.code || 'unknown'}): ${detail}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function request(method, path, data, operation) {
  assertConfigured();
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await axios({ method, url: `${baseUrl()}${path}`, data, headers: headers(), timeout: TIMEOUT_MS });
      return response.data;
    } catch (err) {
      lastErr = classifyError(err, operation);
      if (!lastErr.transient || attempt === MAX_RETRIES) throw lastErr;
      const backoff = 1000 * Math.pow(2, attempt - 1); // 1s, 2s
      console.warn(`[qdrant] ${operation} attempt ${attempt}/${MAX_RETRIES} failed (${lastErr.message}) — retrying in ${backoff}ms`);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

// ── Collection lifecycle ─────────────────────────────────────────
async function ensureCollection() {
  try {
    await request('get', `/collections/${COLLECTION}`, null, 'get collection');
    return { existed: true };
  } catch (err) {
    if (!err.notFound) throw err;
  }
  console.log(`[qdrant] Collection '${COLLECTION}' missing — creating (dim=${VECTOR_DIM}, cosine)`);
  await request('put', `/collections/${COLLECTION}`, { vectors: { size: VECTOR_DIM, distance: 'Cosine' } }, 'create collection');
  return { existed: false };
}

// ── Capacity check (free-tier awareness — see Section 6 of handover) ─
async function getCapacityStatus() {
  const info = await request('get', `/collections/${COLLECTION}`, null, 'get collection info');
  const points = info?.result?.points_count ?? 0;
  const estBytes = points * EST_BYTES_PER_POINT;
  const ratio = estBytes / FREE_TIER_BYTES;
  return {
    collection: COLLECTION,
    points_count: points,
    estimated_bytes: estBytes,
    free_tier_bytes: FREE_TIER_BYTES,
    estimated_usage_pct: Math.round(ratio * 1000) / 10,
    warning: ratio >= CAPACITY_WARN_RATIO
      ? `Qdrant collection is at ~${Math.round(ratio * 100)}% of the estimated 1GB free tier — upserts may start failing soon.`
      : null
  };
}

async function assertCapacity() {
  // Fail loudly BEFORE an upsert if we estimate we're over the free tier,
  // instead of letting Qdrant reject writes with an opaque error later.
  let cap;
  try { cap = await getCapacityStatus(); }
  catch (err) {
    if (err.notFound) return; // collection doesn't exist yet — nothing to exceed
    throw err;
  }
  if (cap.warning) console.warn(`[qdrant] CAPACITY WARNING: ${cap.warning}`);
  if (cap.estimated_bytes >= FREE_TIER_BYTES) {
    throw new Error(`Qdrant free-tier capacity exhausted (~${cap.points_count} points, est. ${(cap.estimated_bytes / 1e6).toFixed(0)}MB). Delete entries or upgrade the cluster before adding more.`);
  }
}

// ── Point operations ─────────────────────────────────────────────
async function upsertPoint(pointId, vector, payload) {
  if (!pointId) throw new Error('upsertPoint: pointId is required');
  if (!Array.isArray(vector) || vector.length !== VECTOR_DIM) throw new Error(`upsertPoint: vector must be an array of ${VECTOR_DIM} numbers, got ${Array.isArray(vector) ? vector.length : typeof vector}`);
  await ensureCollection();
  await assertCapacity();
  const result = await request('put', `/collections/${COLLECTION}/points?wait=true`,
    { points: [{ id: pointId, vector, payload: payload || {} }] }, 'upsert point');
  if (result?.status !== 'ok') throw new Error(`Qdrant upsert returned unexpected status: ${JSON.stringify(result?.status)}`);
  return pointId;
}

async function deletePoint(pointId) {
  if (!pointId) throw new Error('deletePoint: pointId is required');
  try {
    const result = await request('post', `/collections/${COLLECTION}/points/delete?wait=true`, { points: [pointId] }, 'delete point');
    if (result?.status !== 'ok') throw new Error(`Qdrant delete returned unexpected status: ${JSON.stringify(result?.status)}`);
    return true;
  } catch (err) {
    if (err.notFound) return true; // point/collection already gone — treat as deleted
    throw err;
  }
}

async function searchPoints(vector, topK = 5) {
  if (!Array.isArray(vector) || vector.length !== VECTOR_DIM) throw new Error(`searchPoints: vector must be an array of ${VECTOR_DIM} numbers`);
  const result = await request('post', `/collections/${COLLECTION}/points/search`,
    { vector, limit: topK, with_payload: true }, 'search');
  return (result?.result || []).map(hit => ({
    id: hit.id,
    similarity: hit.score,
    title: hit.payload?.title || null,
    content: hit.payload?.content || null,
    category: hit.payload?.category || null,
    source: hit.payload?.source || null
  }));
}

// Scroll all point ids (used by the reconcile job). Paginates internally.
async function listAllPointIds() {
  const ids = [];
  let offset = null;
  do {
    const body = { limit: 250, with_payload: false, with_vector: false };
    if (offset !== null) body.offset = offset;
    const result = await request('post', `/collections/${COLLECTION}/points/scroll`, body, 'scroll points');
    for (const p of result?.result?.points || []) ids.push(String(p.id));
    offset = result?.result?.next_page_offset ?? null;
  } while (offset !== null);
  return ids;
}

async function ping() {
  try {
    assertConfigured();
    const info = await request('get', `/collections/${COLLECTION}`, null, 'ping');
    return { connected: true, points_count: info?.result?.points_count ?? 0 };
  } catch (err) {
    return { connected: false, error: err.message };
  }
}

module.exports = { ensureCollection, upsertPoint, deletePoint, searchPoints, listAllPointIds, getCapacityStatus, assertCapacity, ping, COLLECTION, VECTOR_DIM };
// BUILD: v3.0
