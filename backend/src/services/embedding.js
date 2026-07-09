const axios = require('axios');
const HF_URL = 'https://api-inference.huggingface.co/pipeline/feature-extraction/sentence-transformers/all-MiniLM-L6-v2';
const HF_URL_ALT = 'https://api-inference.huggingface.co/models/sentence-transformers/all-MiniLM-L6-v2';

async function generateEmbedding(text) {
  if (!process.env.HF_API_KEY) throw new Error('HF_API_KEY not configured');
  if (!text?.trim()) throw new Error('Text is required for embedding');
  const cleanText = text.replace(/\s+/g, ' ').trim().slice(0, 512);
  for (const url of [HF_URL, HF_URL_ALT]) {
    try {
      const response = await axios.post(url,
        { inputs: cleanText, options: { wait_for_model: true, use_cache: true } },
        { headers: { Authorization: `Bearer ${process.env.HF_API_KEY}` }, timeout: 60000 }
      );
      let embedding = response.data;
      if (Array.isArray(embedding) && Array.isArray(embedding[0])) embedding = embedding[0];
      if (Array.isArray(embedding) && Array.isArray(embedding[0])) embedding = embedding[0];
      if (!Array.isArray(embedding)) throw new Error(`Unexpected format: ${typeof embedding}`);
      if (embedding.length !== 384) throw new Error(`Wrong dimensions: ${embedding.length}`);
      return embedding;
    } catch (err) {
      const status = err.response?.status;
      if (status === 401) throw new Error('HuggingFace API key is invalid.');
      if (status === 503) { console.warn('[embedding] Model loading, retry in 20s...'); await sleep(20000); continue; }
      if (status === 429) { console.warn('[embedding] Rate limited, retry in 10s...'); await sleep(10000); continue; }
      console.warn(`[embedding] Failed on ${url}: ${err.message}`);
    }
  }
  throw new Error('HuggingFace embedding failed on all endpoints.');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
module.exports = { generateEmbedding };
// BUILD: v2.7.20260706130323
