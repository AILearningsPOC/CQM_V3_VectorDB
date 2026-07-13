const express = require('express');
const router = express.Router();
const supabase = require('../utils/supabase');
const { scrapeAll, scrapeTarget } = require('../services/scraper');
const { restartScheduler } = require('../services/scheduler');

// POST /api/scrape/now
// Scrapes all ACTIVE targets, then auto-disables each one and re-runs RAG
// on ALL questions for that target (new + existing) with the current KB.
router.post('/now', async (req, res) => {
  try {
    const { data: config } = await supabase.from('config').select('value').eq('key', 'scraping_config').single();
    const engine = config?.value?.engine || process.env.SCRAPING_ENGINE || 'scraperapi';
    const result = await scrapeAll(engine);
    res.json(result);
  } catch (err) {
    console.error('[scrape.POST /now]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/scrape/target/:id
router.post('/target/:id', async (req, res) => {
  try {
    const { data: target, error: fetchErr } = await supabase.from('scrape_targets').select('*').eq('id', req.params.id).single();
    if (fetchErr || !target) return res.status(404).json({ error: 'Target not found' });
    const { data: config } = await supabase.from('config').select('value').eq('key', 'scraping_config').single();
    const engine = config?.value?.engine || 'scraperapi';
    const log = await scrapeTarget(target, engine);
    res.json(log);
  } catch (err) {
    console.error('[scrape.POST /target/:id]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/scrape/logs
router.get('/logs', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const { data, error } = await supabase.from('scrape_logs').select('*').order('scraped_at', { ascending: false }).limit(limit);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) {
    console.error('[scrape.GET /logs]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/scrape/config
router.post('/config', async (req, res) => {
  try {
    const { auto_enabled, interval_minutes, engine } = req.body;
    if (interval_minutes !== undefined && parseInt(interval_minutes) < 5) {
      return res.status(400).json({ error: 'interval_minutes must be at least 5' });
    }
    await supabase.from('config').upsert({
      key: 'scraping_config',
      value: { auto_enabled, interval_minutes, engine }
    }, { onConflict: 'key' });
    try { await restartScheduler(); }
    catch (schedErr) { console.error('[scrape.config] Scheduler restart failed:', schedErr.message); }
    res.json({ success: true });
  } catch (err) {
    console.error('[scrape.POST /config]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
// BUILD: v3.0
