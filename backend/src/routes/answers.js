const express = require('express');
const router = express.Router();
const supabase = require('../utils/supabase');

router.get('/', async (req, res) => {
  try {
    const { retailer, category, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query = supabase.from('questions')
      .select('*', { count: 'exact' })
      .eq('status', 'answered');

    if (retailer) query = query.eq('retailer', retailer);
    if (category) query = query.eq('category', category);

    const { data, error, count } = await query
      .order('date_answered', { ascending: false })
      .range(offset, offset + parseInt(limit) - 1);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ data: data || [], total: count || 0 });
  } catch (err) {
    console.error('[answers.GET /]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
// CQM v2.0 - 2026-06-25 - Build: final
// BUILD: v2.7.20260706130323
