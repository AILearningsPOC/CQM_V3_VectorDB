const axios = require('axios');
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

async function callGroq(systemPrompt, userPrompt, maxTokens = 500) {
  if (!process.env.GROQ_API_KEY) throw new Error('GROQ_API_KEY not configured');
  try {
    const response = await axios.post(GROQ_URL,
      { model: MODEL, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }], max_tokens: maxTokens, temperature: 0.1 },
      { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` }, timeout: 30000 }
    );
    return response.data.choices[0].message.content;
  } catch (err) {
    const status = err.response?.status;
    const msg = err.response?.data?.error?.message || err.message;
    if (status === 429) throw new Error('Groq rate limit reached.');
    if (status === 401) throw new Error('Groq API key is invalid.');
    if (status === 503) throw new Error('Groq service temporarily unavailable.');
    throw new Error(`Groq API error: ${msg}`);
  }
}

async function enrichQuestion(questionText) {
  if (!questionText?.trim()) return { language: 'English', category: 'other', sentiment: 'neutral', is_english: true };
  const prompt = `Analyze this customer question and return ONLY valid JSON.\nQuestion: "${questionText.slice(0, 500)}"\nReturn exactly: {"language":"English","category":"product_info","sentiment":"neutral","is_english":true}\ncategory must be one of: product_info, pricing, warranty, compatibility, usage, complaints, returns, other\nsentiment must be one of: positive, neutral, negative`;
  try {
    const raw = await callGroq('You are a JSON-only responder. Return only valid JSON, nothing else.', prompt, 200);
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    return {
      language: parsed.language || 'English',
      category: ['product_info','pricing','warranty','compatibility','usage','complaints','returns','other'].includes(parsed.category) ? parsed.category : 'other',
      sentiment: ['positive','neutral','negative'].includes(parsed.sentiment) ? parsed.sentiment : 'neutral',
      is_english: parsed.is_english !== false
    };
  } catch (err) {
    console.error('[enrichQuestion] Failed:', err.message);
    return { language: 'English', category: 'other', sentiment: 'neutral', is_english: true };
  }
}

async function generateRagAnswer(question, kbContext, productInfo) {
  const hasContext = kbContext && !kbContext.includes('No relevant context found');
  const system = `You are a Hisense customer support specialist. Answer using the knowledge base context. Be concise and helpful.

End your response with exactly: CONFIDENCE: [number]

Confidence scoring rules (be accurate, not generous):
- 0-30:  No relevant KB context found, question is unanswerable from available data (e.g. real-time stock/pricing), or highly speculative
- 31-69: Partial KB context, some uncertainty, general answer only
- 70-100: Strong KB match, specific answer grounded in provided context`;
  const user = `Product Info:\n${productInfo}\n\nKnowledge Base Context:\n${kbContext}\n\nQuestion: ${question}\n\nProvide your answer, then on a new line write:\nCONFIDENCE: [0-100]`;
  const raw = await callGroq(system, user, 600);
  const match = raw.match(/CONFIDENCE:\s*(\d+)/i);
  const confidence = match ? Math.min(100, Math.max(0, parseInt(match[1]))) : 50;
  const answer = raw.replace(/CONFIDENCE:\s*\d+/i, '').trim();
  if (!answer) throw new Error('Empty answer from Groq');
  return { answer, confidence };
}

module.exports = { callGroq, enrichQuestion, generateRagAnswer };
// BUILD: v2.7.20260706130323
