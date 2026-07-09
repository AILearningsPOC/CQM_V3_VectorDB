const express = require('express');
const router = express.Router();
const supabase = require('../utils/supabase');

router.get('/', async (req, res) => {
  try {
    const { status, retailer, category, sentiment, assigned_to, date_from, date_to, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let query = supabase.from('questions').select('*', { count: 'exact' });
    if (status)      query = query.eq('status', status);
    if (retailer)    query = query.eq('retailer', retailer);
    if (category)    query = query.eq('category', category);
    if (sentiment)   query = query.eq('sentiment', sentiment);
    if (assigned_to) query = query.eq('assigned_to', assigned_to);
    if (date_from)   query = query.gte('date_asked', date_from);
    if (date_to)     query = query.lte('date_asked', date_to + 'T23:59:59');
    const { data, error, count } = await query.order('created_at', { ascending: false }).range(offset, offset + parseInt(limit) - 1);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ data: data || [], total: count || 0, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/export/csv', async (req, res) => {
  try {
    const { data, error } = await supabase.from('questions').select('*').order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    if (!data?.length) return res.status(404).json({ error: 'No questions to export' });
    const XLSX = require('xlsx');
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Questions');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="cqm_questions_export.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('questions').select('*').eq('id', req.params.id).single();
    if (error || !data) return res.status(404).json({ error: 'Not found' });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/:id/approve', async (req, res) => {
  try {
    const { answer, add_to_kb } = req.body;
    const { data: q, error: fe } = await supabase.from('questions').select('*').eq('id', req.params.id).single();
    if (fe || !q) return res.status(404).json({ error: 'Question not found' });
    const finalAnswer = (answer?.trim()) ? answer.trim() : q.ai_answer;
    if (!finalAnswer) return res.status(400).json({ error: 'No answer provided and no AI draft available' });
    const { data, error } = await supabase.from('questions').update({ ai_answer: finalAnswer, status: 'answered', date_answered: new Date().toISOString(), review_reason: null }).eq('id', req.params.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    if (add_to_kb) { try { const { addApprovedAnswerToKB } = require('../services/enrichment'); await addApprovedAnswerToKB(q, finalAnswer, q.category); } catch (e) {} }
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/:id/assign', async (req, res) => {
  try {
    const { assigned_to } = req.body;
    if (!assigned_to) return res.status(400).json({ error: 'assigned_to is required' });
    const { data, error } = await supabase.from('questions').update({ assigned_to }).eq('id', req.params.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Question not found' });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/:id/draft', async (req, res) => {
  try {
    const { answer } = req.body;
    if (answer === undefined) return res.status(400).json({ error: 'answer is required' });
    const { data, error } = await supabase.from('questions').update({ ai_answer: answer }).eq('id', req.params.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Question not found' });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
// BUILD: v2.7.20260706130323
