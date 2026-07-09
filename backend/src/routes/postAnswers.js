const express = require('express');
const router = express.Router();
const supabase = require('../utils/supabase');

// GET post-answers config
router.get('/config', async (req, res) => {
  try {
    const { data } = await supabase.from('config').select('value').eq('key', 'posting_enabled').single();
    res.json({ posting_enabled: data?.value === true });
  } catch (err) {
    console.error('[postAnswers.GET /config]', err.message);
    res.json({ posting_enabled: false }); // Safe default
  }
});

// POST toggle posting on/off
router.post('/toggle', async (req, res) => {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }
    await supabase.from('config').upsert({ key: 'posting_enabled', value: enabled }, { onConflict: 'key' });
    res.json({ posting_enabled: enabled });
  } catch (err) {
    console.error('[postAnswers.POST /toggle]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST post a single answer back to retailer
router.post('/:id', async (req, res) => {
  try {
    const { data: config } = await supabase.from('config').select('value').eq('key', 'posting_enabled').single();
    if (config?.value !== true) {
      return res.status(403).json({ error: 'Posting to retailer sites is currently disabled. Enable it in Configuration.' });
    }

    const { data: question, error: fetchErr } = await supabase.from('questions').select('*').eq('id', req.params.id).single();
    if (fetchErr || !question) return res.status(404).json({ error: 'Question not found' });
    if (question.status !== 'answered') return res.status(400).json({ error: 'Question must be answered before posting' });
    if (question.posted_to_retailer) return res.status(409).json({ error: 'Answer already posted to retailer' });

    const { error: updateErr } = await supabase.from('questions').update({
      posted_to_retailer: true,
      posted_at: new Date().toISOString()
    }).eq('id', req.params.id);

    if (updateErr) return res.status(500).json({ error: updateErr.message });

    res.json({ success: true, message: 'Marked as posted (automation not yet implemented for PoC)' });
  } catch (err) {
    console.error('[postAnswers.POST /:id]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
// CQM v2.0 - 2026-06-25 - Build: final
// BUILD: v2.7.20260706130323
