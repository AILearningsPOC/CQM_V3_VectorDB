const supabase = require('../utils/supabase');
const groqSvc = require('./groq');
const ragSvc = require('./rag');

// Assign agent ONLY for review-queue questions, matched by category skill.
// Auto-approved questions are labelled "AI" — no human agent assigned.
async function autoAssignAgent(category) {
  try {
    const { data: agents } = await supabase.from('agents')
      .select('*').eq('is_active', true).eq('role', 'agent').contains('skills', [category]);
    if (!agents || agents.length === 0) return null;
    // Pick the agent with the fewest open questions (load balancing)
    const counts = await Promise.all(agents.map(async (agent) => {
      try {
        const { count } = await supabase.from('questions')
          .select('*', { count: 'exact', head: true })
          .eq('assigned_to', agent.name).in('status', ['pending', 'review']);
        return { agent, count: count || 0 };
      } catch { return { agent, count: 0 }; }
    }));
    counts.sort((a, b) => a.count - b.count);
    return counts[0].agent.name;
  } catch (err) { console.error('[autoAssignAgent]', err.message); return null; }
}

async function processQuestion(questionId) {
  // 1) Fetch question
  let question;
  try {
    const { data, error } = await supabase.from('questions').select('*').eq('id', questionId).single();
    if (error || !data) { console.error(`[processQuestion] Not found: ${questionId}`); return; }
    question = data;
  } catch (err) { console.error(`[processQuestion] Fetch error:`, err.message); return; }

  // 2) Enrich (category, sentiment, language)
  let enrichment = { language: 'English', category: 'other', sentiment: 'neutral', is_english: true };
  try { enrichment = await groqSvc.enrichQuestion(question.question_text); }
  catch (err) { console.error(`[processQuestion] Enrichment failed:`, err.message); }

  // 3) Generate AI answer + confidence score
  let answer = null, confidence = 0;
  try {
    const result = await ragSvc.answerQuestion(question);
    answer = result.answer;
    confidence = result.confidence;
  } catch (err) {
    console.error(`[processQuestion] RAG failed:`, err.message);
    // RAG failure → route to review, assign an agent, no AI label
    const assignedTo = await autoAssignAgent(enrichment.category).catch(() => null);
    await supabase.from('questions').update({
      language: enrichment.language, category: enrichment.category, sentiment: enrichment.sentiment,
      assigned_to: assignedTo,
      status: 'review',
      review_reason: `AI answer generation failed: ${err.message}`,
      processed_at: new Date().toISOString()
    }).eq('id', questionId);
    return;
  }

  // 4) Route by confidence — assignment happens HERE, after score is known
  const isAutoApproved = confidence >= 70 && enrichment.is_english;
  const now = new Date().toISOString();

  let assignedTo;
  if (isAutoApproved) {
    // High confidence + English → answered by AI, no human agent needed
    assignedTo = 'AI';
  } else {
    // Low confidence or non-English → assign to best-matching human agent
    assignedTo = await autoAssignAgent(enrichment.category).catch(() => null);
  }

  // 5) Persist
  try {
    await supabase.from('questions').update({
      language: enrichment.language,
      category: enrichment.category,
      sentiment: enrichment.sentiment,
      assigned_to: assignedTo,
      ai_answer: answer,
      confidence,
      status: isAutoApproved ? 'answered' : 'review',
      review_reason: !enrichment.is_english
        ? 'Non-English question — requires human review'
        : confidence < 70
          ? `Low confidence (${confidence}%) — requires human review`
          : null,
      date_answered: isAutoApproved ? now : null,
      processed_at: now
    }).eq('id', questionId);
  } catch (err) { console.error(`[processQuestion] DB update failed:`, err.message); return; }

  // Auto-KB removed: answers only go to KB via manual "Approve + Add to KB"
}

async function addApprovedAnswerToKB(question, answer, category) {
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
// BUILD: v3.0
