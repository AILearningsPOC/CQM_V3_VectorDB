const express = require('express');
const router = express.Router();
const supabase = require('../utils/supabase');
const qdrant = require('../services/qdrant');

router.get('/', async (req, res) => {
  let dbConnected = false, counts = { questions: 0, answered: 0, review: 0, kb_entries: 0, scrape_targets: 0 };
  let dbError = null;
  try {
    const [{ count: questions }, { count: kb }, { count: review }, { count: targets }] = await Promise.all([
      supabase.from('questions').select('*', { count: 'exact', head: true }),
      supabase.from('knowledge_base').select('*', { count: 'exact', head: true }),
      supabase.from('questions').select('*', { count: 'exact', head: true }).eq('status', 'review'),
      supabase.from('scrape_targets').select('*', { count: 'exact', head: true })
    ]);
    dbConnected = true;
    counts = { questions: questions || 0, answered: 0, review: review || 0, kb_entries: kb || 0, scrape_targets: targets || 0 };
  } catch (err) {
    dbError = err.message;
    console.error('[health] Supabase check failed:', err.message);
  }

  // Qdrant status — ping never throws (returns {connected:false, error} on failure)
  let qdrantStatus = { connected: false, error: 'not checked' };
  let qdrantCapacity = null;
  try {
    qdrantStatus = await qdrant.ping();
    if (qdrantStatus.connected) {
      try { qdrantCapacity = await qdrant.getCapacityStatus(); }
      catch (capErr) { console.error('[health] Qdrant capacity check failed:', capErr.message); }
    }
  } catch (err) {
    qdrantStatus = { connected: false, error: err.message };
  }

  res.json({
    status: 'ok', version: '3.0.0',
    db_connected: dbConnected,
    ...(dbError && { db_error: dbError }),
    qdrant: qdrantStatus,
    ...(qdrantCapacity && { qdrant_capacity: qdrantCapacity }),
    ai_configured: !!process.env.GROQ_API_KEY,
    hf_configured: !!process.env.HF_API_KEY,
    qdrant_configured: !!(process.env.QDRANT_URL && process.env.QDRANT_API_KEY),
    scraperapi_configured: !!process.env.SCRAPERAPI_KEY,
    apify_configured: !!process.env.APIFY_API_KEY,
    counts
  });
});

module.exports = router;
// BUILD: v3.0
