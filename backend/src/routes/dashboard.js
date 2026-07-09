const express = require('express');
const router = express.Router();
const supabase = require('../utils/supabase');

router.get('/stats', async (req, res) => {
  try {
    const { date_from, date_to, vendor } = req.query;

    // Helper to apply optional filters to any query
    const applyFilters = (q) => {
      if (vendor)    q = q.eq('retailer', vendor);
      if (date_from) q = q.gte('created_at', date_from);
      if (date_to)   q = q.lte('created_at', date_to + 'T23:59:59');
      return q;
    };

    const [
      { count: total },
      { count: answered },
      { count: unanswered },
      { count: review },
      { count: auto_approved },
      { data: by_retailer },
      { data: by_category },
      { data: by_sentiment },
      { data: sla_breached_data },
      { count: kb_entries }
    ] = await Promise.all([
      applyFilters(supabase.from('questions').select('*', { count: 'exact', head: true })),
      applyFilters(supabase.from('questions').select('*', { count: 'exact', head: true }).eq('status', 'answered')),
      applyFilters(supabase.from('questions').select('*', { count: 'exact', head: true }).eq('status', 'pending')),
      applyFilters(supabase.from('questions').select('*', { count: 'exact', head: true }).eq('status', 'review')),
      applyFilters(supabase.from('questions').select('*', { count: 'exact', head: true }).eq('status', 'answered').not('confidence', 'is', null).gte('confidence', 70)),
      applyFilters(supabase.from('questions').select('retailer').neq('retailer', null)),
      applyFilters(supabase.from('questions').select('category').neq('category', null)),
      applyFilters(supabase.from('questions').select('sentiment').neq('sentiment', null)),
      applyFilters(supabase.from('questions').select('id,created_at,assigned_to').in('status', ['pending', 'review']).lt('created_at', new Date(Date.now() - 86400000).toISOString())),
      supabase.from('knowledge_base').select('*', { count: 'exact', head: true })
    ]);

    // Group by retailer
    const retailer_counts = {};
    (by_retailer || []).forEach(r => {
      if (r.retailer) retailer_counts[r.retailer] = (retailer_counts[r.retailer] || 0) + 1;
    });

    // Group by category
    const category_counts = {};
    (by_category || []).forEach(r => {
      if (r.category) category_counts[r.category] = (category_counts[r.category] || 0) + 1;
    });

    // Group by sentiment
    const sentiment_counts = {};
    (by_sentiment || []).forEach(r => {
      if (r.sentiment) sentiment_counts[r.sentiment] = (sentiment_counts[r.sentiment] || 0) + 1;
    });

    const automation_rate = total > 0 ? Math.round((auto_approved / total) * 100) : 0;
    const sla_count = sla_breached_data?.length || 0;

    // AHT calculation — avg minutes from created_at to date_answered
    let aht_mins = null;
    try {
      const { data: aht_data } = await applyFilters(
        supabase.from('questions')
          .select('created_at, date_answered')
          .eq('status', 'answered')
          .not('date_answered', 'is', null)
          .not('created_at', 'is', null)
          .limit(200)
      );
      if (aht_data && aht_data.length > 0) {
        const diffs = aht_data
          .map(q => (new Date(q.date_answered) - new Date(q.created_at)) / 60000)
          .filter(d => d > 0 && d < 10080); // ignore negatives and > 1 week
        if (diffs.length > 0) {
          aht_mins = (diffs.reduce((a, b) => a + b, 0) / diffs.length).toFixed(2);
        }
      }
    } catch (e) { console.error('[dashboard] AHT calc failed:', e.message); }

    // Last 7 days trend
    const { data: trend_data } = await supabase
      .from('questions')
      .select('created_at, status, retailer, category')
      .gte('created_at', new Date(Date.now() - 7 * 86400000).toISOString())
      .order('created_at');

    // Group by day
    const daily = {};
    (trend_data || []).forEach(q => {
      const day = q.created_at?.slice(0, 10);
      if (!day) return;
      if (!daily[day]) daily[day] = { date: day, total: 0, answered: 0 };
      daily[day].total++;
      if (q.status === 'answered') daily[day].answered++;
    });

    const aht_reduction = total > 0 ? Math.round((auto_approved / total) * 100) : 0;

    // Calculate the number of days in the selected period
    let active_days = 30;
    if (date_from && date_to) {
      active_days = Math.max(1, Math.round((new Date(date_to) - new Date(date_from)) / 86400000));
    } else if (date_from) {
      active_days = Math.max(1, Math.round((new Date() - new Date(date_from)) / 86400000));
    }

    res.json({
      total: total || 0,
      answered: answered || 0,
      unanswered: unanswered || 0,
      review: review || 0,
      auto_approved: auto_approved || 0,
      automation_rate,
      aht_mins: aht_mins,
      aht_reduction: aht_reduction,
      active_days: active_days,
      sla_breached: sla_count,
      kb_entries: kb_entries || 0,
      by_retailer: retailer_counts,
      by_category: category_counts,
      by_sentiment: sentiment_counts,
      trend: Object.values(daily).sort((a, b) => a.date.localeCompare(b.date))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
// CQM v2.0 - 2026-06-25 - Build: final
// BUILD: v2.7.20260706130323
