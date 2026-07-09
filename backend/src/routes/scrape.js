const express = require('express');
const router = express.Router();
const supabase = require('../utils/supabase');
const { scrapeAll, scrapeTarget } = require('../services/scraper');
const { processQuestion } = require('../services/enrichment');
const { restartScheduler } = require('../services/scheduler');

// POST /api/scrape/now
router.post('/now', async (req, res) => {
  try {
    const { data: config } = await supabase.from('config').select('value').eq('key', 'scraping_config').single();
    const engine = config?.value?.engine || process.env.SCRAPING_ENGINE || 'scraperapi';

    const result = await scrapeAll(engine);

    const { data: pending } = await supabase
      .from('questions').select('id').eq('status', 'pending').is('processed_at', null).limit(50);

    let processed = 0;
    if (pending?.length) {
      for (const q of pending) {
        try {
          await processQuestion(q.id);
          processed++;
        } catch (pErr) {
          console.error(`[scrape/now] processQuestion failed for ${q.id}:`, pErr.message);
        }
      }
    }

    res.json({ ...result, processed_questions: processed });
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
    const { data, error } = await supabase
      .from('scrape_logs').select('*').order('scraped_at', { ascending: false }).limit(limit);
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

    try {
      await restartScheduler();
    } catch (schedErr) {
      console.error('[scrape.config] Scheduler restart failed:', schedErr.message);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[scrape.POST /config]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
// CQM v2.0 - 2026-06-25 - Build: final
// BUILD: v2.7.20260706130323
