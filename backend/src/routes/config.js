const express = require('express');
const router = express.Router();
const supabase = require('../utils/supabase');

router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase.from('config').select('*');
    if (error) return res.status(500).json({ error: error.message });
    const config = {};
    (data || []).forEach(row => { config[row.key] = row.value; });
    res.json(config);
  } catch (err) {
    console.error('[config.GET /]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { key, value } = req.body;
    if (!key) return res.status(400).json({ error: 'key is required' });
    const { data, error } = await supabase.from('config')
      .upsert({ key, value }, { onConflict: 'key' }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    console.error('[config.POST /]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
// CQM v2.0 - 2026-06-25 - Build: final
// BUILD: v2.7.20260706130323
