// CQM v3 — RAG: vector search now hits Qdrant instead of pgvector.
// Keyword fallback (Supabase text search) is preserved from v2 so answers
// still work when Qdrant/HuggingFace are down — degraded, never silent.
const supabase = require('../utils/supabase');
const embeddingSvc = require('./embedding');
const groqSvc = require('./groq');
const qdrant = require('./qdrant');

async function searchKB(questionText, topK = 5) {
  // 1) Vector search via Qdrant
  try {
    const embedding = await embeddingSvc.generateEmbedding(questionText);
    const hits = await qdrant.searchPoints(embedding, topK);
    if (hits.length > 0) return hits;
    console.warn('[searchKB] Qdrant returned 0 hits — falling back to keyword search');
  } catch (err) {
    console.warn('[searchKB] Vector search failed, trying keyword fallback:', err.message);
  }
  // 2) Keyword fallback (unchanged from v2)
  try {
    const keywords = questionText.split(' ').filter(w => w.length > 3).slice(0, 3).join(' | ');
    if (!keywords) return [];
    const { data, error } = await supabase.from('knowledge_base').select('content,category,title').textSearch('content', keywords).limit(topK);
    if (error) throw new Error(error.message);
    return data || [];
  } catch (err) {
    console.warn('[searchKB] Keyword fallback failed:', err.message);
    return [];
  }
}

async function answerQuestion(question) {
  let kbResults = [];
  try { kbResults = await searchKB(question.question_text); } catch (err) { console.warn('[answerQuestion] KB search failed:', err.message); }
  const kbContext = kbResults.length > 0
    ? kbResults.map((r, i) => `[${i + 1}] ${r.title || r.category}: ${r.content}`).join('\n\n')
    : 'No relevant context found in knowledge base.';
  const productInfo = [question.product_name && `Product: ${question.product_name}`, question.retailer && `Retailer: ${question.retailer}`].filter(Boolean).join('\n') || 'No product info available';
  return groqSvc.generateRagAnswer(question.question_text, kbContext, productInfo);
}

module.exports = { searchKB, answerQuestion };
// BUILD: v3.0
