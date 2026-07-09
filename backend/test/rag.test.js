const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { makeBuilder, patchSupabase, clearAxiosHandler } = require('./helpers');

const embeddingSvc = require('../src/services/embedding');
const groqSvc = require('../src/services/groq');
const qdrant = require('../src/services/qdrant');
const rag = require('../src/services/rag');

const VEC = new Array(384).fill(0.3);
let restoreSupabase = null;
let saved = {};

beforeEach(() => {
  clearAxiosHandler();
  saved = {
    generateEmbedding: embeddingSvc.generateEmbedding,
    generateRagAnswer: groqSvc.generateRagAnswer,
    searchPoints: qdrant.searchPoints
  };
  embeddingSvc.generateEmbedding = async () => VEC;
  groqSvc.generateRagAnswer = async (q, ctx) => ({ answer: `ANSWER using: ${ctx.slice(0, 60)}`, confidence: 85 });
  qdrant.searchPoints = async () => [];
});

afterEach(() => {
  embeddingSvc.generateEmbedding = saved.generateEmbedding;
  groqSvc.generateRagAnswer = saved.generateRagAnswer;
  qdrant.searchPoints = saved.searchPoints;
  if (restoreSupabase) { restoreSupabase(); restoreSupabase = null; }
});

test('searchKB: returns Qdrant hits when vector search succeeds', async () => {
  qdrant.searchPoints = async (vec, topK) => {
    assert.equal(vec.length, 384);
    assert.equal(topK, 5);
    return [{ id: 'p1', similarity: 0.9, title: 'Warranty', content: '1 year limited', category: 'warranty', source: 'manual' }];
  };
  restoreSupabase = patchSupabase(() => { throw new Error('keyword fallback must not run when Qdrant succeeds'); });
  const hits = await rag.searchKB('what is the warranty?');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].title, 'Warranty');
});

test('searchKB: falls back to keyword search when Qdrant fails', async () => {
  qdrant.searchPoints = async () => { throw new Error('Qdrant unreachable'); };
  restoreSupabase = patchSupabase((table) => {
    assert.equal(table, 'knowledge_base');
    return makeBuilder({ data: [{ title: 'Warranty', content: '1 year', category: 'warranty' }], error: null });
  });
  const hits = await rag.searchKB('what is the warranty period offered?');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].content, '1 year');
});

test('searchKB: falls back to keyword search when embedding generation fails', async () => {
  embeddingSvc.generateEmbedding = async () => { throw new Error('HF down'); };
  restoreSupabase = patchSupabase(() => makeBuilder({ data: [{ title: 'K', content: 'keyword hit', category: 'other' }], error: null }));
  const hits = await rag.searchKB('television warranty question');
  assert.equal(hits[0].content, 'keyword hit');
});

test('searchKB: returns [] (never throws) when both paths fail', async () => {
  qdrant.searchPoints = async () => { throw new Error('down'); };
  restoreSupabase = patchSupabase(() => { throw new Error('db down too'); });
  const hits = await rag.searchKB('anything at all here');
  assert.deepEqual(hits, []);
});

test('searchKB: short/stop-word-only question returns [] from fallback without querying', async () => {
  qdrant.searchPoints = async () => { throw new Error('down'); };
  restoreSupabase = patchSupabase(() => { throw new Error('must not query with empty keywords'); });
  const hits = await rag.searchKB('is it ok');
  assert.deepEqual(hits, []);
});

test('answerQuestion: passes KB context to Groq when hits exist', async () => {
  qdrant.searchPoints = async () => [{ title: 'Warranty', content: '1 year limited', category: 'warranty' }];
  const result = await rag.answerQuestion({ question_text: 'warranty?', product_name: 'U8 TV', retailer: 'bestbuy' });
  assert.match(result.answer, /Warranty: 1 year limited/);
  assert.equal(result.confidence, 85);
});

test('answerQuestion: still answers (degraded) when KB search finds nothing', async () => {
  qdrant.searchPoints = async () => { throw new Error('down'); };
  restoreSupabase = patchSupabase(() => makeBuilder({ data: [], error: null }));
  const result = await rag.answerQuestion({ question_text: 'what about warranty coverage?', product_name: null, retailer: null });
  assert.match(result.answer, /No relevant context found/);
});
