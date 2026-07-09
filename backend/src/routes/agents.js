const express = require('express');
const router = express.Router();
const supabase = require('../utils/supabase');

// GET all agents
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase.from('agents').select('*').order('name');
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) {
    console.error('[agents.GET /]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST create agent
router.post('/', async (req, res) => {
  try {
    const { name, role, skills, retailer_ids } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const { data, error } = await supabase.from('agents').insert({
      name: name.trim(),
      role: role || 'agent',
      skills: skills || [],
      retailer_ids: retailer_ids || [],
      is_active: true
    }).select().single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
  } catch (err) {
    console.error('[agents.POST /]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PATCH update agent
router.patch('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('agents')
      .update(req.body).eq('id', req.params.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Agent not found' });
    res.json(data);
  } catch (err) {
    console.error('[agents.PATCH /:id]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE agent
router.delete('/:id', async (req, res) => {
  try {
    const { error } = await supabase.from('agents').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (err) {
    console.error('[agents.DELETE /:id]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET agent workload summary
router.get('/workload', async (req, res) => {
  try {
    const { data: agents, error } = await supabase.from('agents').select('*').eq('is_active', true);
    if (error) return res.status(500).json({ error: error.message });
    if (!agents || agents.length === 0) return res.json([]);

    const workloads = await Promise.all(agents.map(async (agent) => {
      try {
        const [{ count: open }, { count: answered_today }] = await Promise.all([
          supabase.from('questions').select('*', { count: 'exact', head: true })
            .eq('assigned_to', agent.name).in('status', ['pending', 'review']),
          supabase.from('questions').select('*', { count: 'exact', head: true })
            .eq('assigned_to', agent.name).eq('status', 'answered')
            .gte('date_answered', new Date(Date.now() - 86400000).toISOString())
        ]);

        const { data: sla_breached } = await supabase.from('questions')
          .select('id').eq('assigned_to', agent.name).in('status', ['pending', 'review'])
          .lt('created_at', new Date(Date.now() - 86400000).toISOString());

        return {
          ...agent,
          open_questions: open || 0,
          answered_today: answered_today || 0,
          sla_breached: sla_breached?.length || 0
        };
      } catch (agentErr) {
        console.error(`[agents.workload] Error for agent ${agent.name}:`, agentErr.message);
        return { ...agent, open_questions: 0, answered_today: 0, sla_breached: 0 };
      }
    }));

    res.json(workloads);
  } catch (err) {
    console.error('[agents.GET /workload]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
// CQM v2.0 - 2026-06-25 - Build: final
// BUILD: v2.7.20260706130323
