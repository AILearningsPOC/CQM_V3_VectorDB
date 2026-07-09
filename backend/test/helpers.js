// Shared test helpers — sets safe fake env BEFORE any module loads,
// intercepts ALL axios traffic via a custom adapter (works even though
// modules captured the axios reference at require time), and provides a
// chainable Supabase query-builder mock.
process.env.SUPABASE_URL = 'https://fake-v3.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'fake-service-key';
process.env.QDRANT_URL = 'https://fake-cluster.qdrant.io:6333';
process.env.QDRANT_API_KEY = 'fake-qdrant-key';
process.env.QDRANT_COLLECTION = 'cqm_kb_test';
process.env.QDRANT_TIMEOUT_MS = '200';
process.env.HF_API_KEY = 'hf_fake';
process.env.GROQ_API_KEY = 'fake-groq';

const axios = require('axios');

// ── axios adapter interception ───────────────────────────────────
// handler(config) may:
//   return { status, data }            → normal HTTP response (any status)
//   throw  netError('ECONNABORTED')    → network/timeout failure
// Unhandled requests throw loudly so nothing passes silently.
let currentHandler = null;
axios.defaults.adapter = async (config) => {
  if (!currentHandler) throw new Error(`Unexpected axios request in test (no handler): ${config.method} ${config.url}`);
  const out = await currentHandler(config);
  const status = out.status ?? 200;
  const response = { status, statusText: String(status), data: out.data ?? {}, headers: {}, config, request: {} };
  if (status < 200 || status >= 300) {
    // Custom adapters must reject non-2xx themselves (axios core doesn't re-validate)
    const err = new Error(`Request failed with status code ${status}`);
    err.response = response;
    err.config = config;
    throw err;
  }
  return response;
};

function setAxiosHandler(fn) { currentHandler = fn; }
function clearAxiosHandler() { currentHandler = null; }

function netError(code) {
  const err = new Error(code === 'ECONNABORTED' ? 'timeout of 200ms exceeded' : code);
  err.code = code;
  return err;
}

// ── Chainable Supabase query-builder mock ────────────────────────
// makeBuilder({data, error, count}) — chain methods return the builder;
// awaiting it (or .single()) resolves the given result. __calls records
// every method call for assertions.
function makeBuilder(result) {
  const b = { __calls: [] };
  const chain = ['select', 'insert', 'update', 'delete', 'eq', 'gte', 'lte', 'is', 'in', 'contains',
    'order', 'range', 'limit', 'ilike', 'textSearch', 'single', 'head'];
  for (const m of chain) b[m] = (...args) => { b.__calls.push([m, args]); return b; };
  b.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return b;
}

// Patch the shared supabase client instance's .from (call-time property access).
function patchSupabase(fromImpl) {
  const supabase = require('../src/utils/supabase');
  const orig = supabase.from;
  supabase.from = fromImpl;
  return () => { supabase.from = orig; };
}

module.exports = { setAxiosHandler, clearAxiosHandler, netError, makeBuilder, patchSupabase };
