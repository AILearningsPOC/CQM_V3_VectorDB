const supabase = require('../utils/supabase');
const { enrichQuestion } = require('./groq');
const { answerQuestion } = require('./rag');

async function autoAssignAgent(category) {
  try {
    const { data: agents } = await supabase.from('agents').select('*').eq('is_active', true).eq('role', 'agent').contains('skills', [category]);
    if (!agents || agents.length === 0) return null;
    const counts = await Promise.all(agents.map(async (agent) => {
      try {
        const { count } = await supabase.from('questions').select('*', { count: 'exact', head: true }).eq('assigned_to', agent.name).in('status', ['pending', 'review']);
        return { agent, count: count || 0 };
      } catch { return { agent, count: 0 }; }
    }));
    counts.sort((a, b) => a.count - b.count);
    return counts[0].agent.name;
  } catch (err) { console.error('[autoAssignAgent]', err.message); return null; }
}

async function processQuestion(questionId) {
  let question;
  try {
    const { data, error } = await supabase.from('questions').select('*').eq('id', questionId).single();
    if (error || !data) { console.error(`[processQuestion] Not found: ${questionId}`); return; }
    question = data;
  } catch (err) { console.error(`[processQuestion] Fetch error:`, err.message); return; }

  let enrichment = { language: 'English', category: 'other', sentiment: 'neutral', is_english: true };
  try { enrichment = await enrichQuestion(question.question_text); } catch (err) { console.error(`[processQuestion] Enrichment failed:`, err.message); }

  let assignedTo = null;
  try { assignedTo = await autoAssignAgent(enrichment.category); } catch (err) { console.error(`[processQuestion] Assignment failed:`, err.message); }

  let answer = null, confidence = 0;
  try {
    const result = await answerQuestion(question);
    answer = result.answer;
    confidence = result.confidence;
  } catch (err) {
    console.error(`[processQuestion] RAG failed:`, err.message);
    await supabase.from('questions').update({ language: enrichment.language, category: enrichment.category, sentiment: enrichment.sentiment, assigned_to: assignedTo, status: 'review', review_reason: `AI answer generation failed: ${err.message}`, processed_at: new Date().toISOString() }).eq('id', questionId);
    return;
  }

  const isAutoApproved = confidence >= 70 && enrichment.is_english;
  const now = new Date().toISOString();
  try {
    await supabase.from('questions').update({
      language: enrichment.language, category: enrichment.category, sentiment: enrichment.sentiment,
      assigned_to: assignedTo, ai_answer: answer, confidence,
      status: isAutoApproved ? 'answered' : 'review',
      review_reason: !enrichment.is_english ? 'Non-English question — requires human review' : confidence < 70 ? `Low confidence (${confidence}%) — requires human review` : null,
      date_answered: isAutoApproved ? now : null,
      processed_at: now
    }).eq('id', questionId);
  } catch (err) { console.error(`[processQuestion] DB update failed:`, err.message); return; }

  // Auto-KB removed: answers only go to KB via manual "Approve + Add to KB"



}

async function addApprovedAnswerToKB(question, answer, category) {
  // v3: two-store write (Qdrant first, Supabase second) via kbStore.
  const { insertKBEntry } = require('./kbStore');
  const content = `Q: ${question.question_text}\nA: ${answer}`;
  try {
    const result = await insertKBEntry({
      title: question.question_text.slice(0, 100),
      content,
      category: category || 'other',
      source: 'approved_answer'
    });
    if (result.warning) console.warn('[addApprovedAnswerToKB]', result.warning);
  } catch (err) {
    console.error('[addApprovedAnswerToKB] KB insert failed (both stores):', err.message);
  }
}

module.exports = { processQuestion, addApprovedAnswerToKB };
// BUILD: v2.7.20260706130323
