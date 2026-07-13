// Enrichment assignment ordering tests — isolated file so the supabase.from
// patch is applied before the Express server or any other module caches it.
require('./helpers');

const assert = require('node:assert');
const { test } = require('node:test');

const supabase = require('../src/utils/supabase');
const groqSvc = require('../src/services/groq');
const ragSvc  = require('../src/services/rag');

// Force fresh require of enrichment so it picks up patched dependencies
delete require.cache[require.resolve('../src/services/enrichment')];
const { processQuestion } = require('../src/services/enrichment');

test('auto-approved (>=70%): assigned_to=AI, status=answered', async () => {
  const savedEnrich = groqSvc.enrichQuestion;
  const savedAnswer = ragSvc.answerQuestion;
  const savedFrom   = supabase.from;

  groqSvc.enrichQuestion = async () => ({ language: 'English', category: 'product_info', sentiment: 'neutral', is_english: true });
  ragSvc.answerQuestion  = async () => ({ answer: 'It supports 4K.', confidence: 85 });

  let savedRow = null;
  let call = 0;
  supabase.from = () => {
    call++;
    if (call === 1) {
      // question fetch
      return {
        select: function() { return this; },
        eq:     function() { return this; },
        single: function() { return this; },
        then: (res) => res({ data: { id: 'q1', question_text: 'Does it support 4K?', product_name: 'U6', retailer: 'bestbuy' }, error: null })
      };
    }
    // update
    return {
      update: function(row) { savedRow = row; return this; },
      eq:     function() { return this; },
      then:   (res) => res({ data: null, error: null })
    };
  };

  await processQuestion('q1');

  assert.equal(savedRow?.assigned_to, 'AI', 'auto-approved must be assigned to AI');
  assert.equal(savedRow?.status, 'answered');
  assert.equal(savedRow?.review_reason, null);

  groqSvc.enrichQuestion = savedEnrich;
  ragSvc.answerQuestion  = savedAnswer;
  supabase.from = savedFrom;
});

test('low-confidence (<70%): assigned to human agent, status=review', async () => {
  const savedEnrich = groqSvc.enrichQuestion;
  const savedAnswer = ragSvc.answerQuestion;
  const savedFrom   = supabase.from;

  groqSvc.enrichQuestion = async () => ({ language: 'English', category: 'warranty', sentiment: 'neutral', is_english: true });
  ragSvc.answerQuestion  = async () => ({ answer: 'Not sure.', confidence: 40 });

  let savedRow = null;
  let call = 0;
  supabase.from = () => {
    call++;
    if (call === 1) return {
      select: function() { return this; }, eq: function() { return this; }, single: function() { return this; },
      then: (res) => res({ data: { id: 'q2', question_text: 'Warranty details?', product_name: 'U6', retailer: 'bestbuy' }, error: null })
    };
    if (call === 2) return {
      select: function() { return this; }, eq: function() { return this; }, contains: function() { return this; },
      then: (res) => res({ data: [{ name: 'Jamie Agent', skills: ['warranty'], is_active: true, role: 'agent' }], error: null })
    };
    if (call === 3) return {
      select: function() { return this; }, eq: function() { return this; }, in: function() { return this; },
      then: (res) => res({ data: null, error: null, count: 1 })
    };
    return {
      update: function(row) { savedRow = row; return this; }, eq: function() { return this; },
      then: (res) => res({ data: null, error: null })
    };
  };

  await processQuestion('q2');

  assert.notEqual(savedRow?.assigned_to, 'AI', 'low-confidence must not be assigned to AI');
  assert.equal(savedRow?.assigned_to, 'Jamie Agent');
  assert.equal(savedRow?.status, 'review');
  assert.match(savedRow?.review_reason, /Low confidence/);

  groqSvc.enrichQuestion = savedEnrich;
  ragSvc.answerQuestion  = savedAnswer;
  supabase.from = savedFrom;
});

test('non-English question: assigned to human agent, review_reason mentions Non-English', async () => {
  const savedEnrich = groqSvc.enrichQuestion;
  const savedAnswer = ragSvc.answerQuestion;
  const savedFrom   = supabase.from;

  groqSvc.enrichQuestion = async () => ({ language: 'Spanish', category: 'other', sentiment: 'neutral', is_english: false });
  ragSvc.answerQuestion  = async () => ({ answer: 'Respuesta.', confidence: 80 });

  let savedRow = null;
  let call = 0;
  supabase.from = () => {
    call++;
    if (call === 1) return {
      select: function() { return this; }, eq: function() { return this; }, single: function() { return this; },
      then: (res) => res({ data: { id: 'q3', question_text: '¿Tiene garantía?', product_name: 'U6', retailer: 'bestbuy' }, error: null })
    };
    if (call === 2) return {
      select: function() { return this; }, eq: function() { return this; }, contains: function() { return this; },
      then: (res) => res({ data: [], error: null }) // no agent with 'other' skill
    };
    return {
      update: function(row) { savedRow = row; return this; }, eq: function() { return this; },
      then: (res) => res({ data: null, error: null })
    };
  };

  await processQuestion('q3');

  assert.notEqual(savedRow?.assigned_to, 'AI');
  assert.equal(savedRow?.status, 'review');
  assert.match(savedRow?.review_reason, /Non-English/);

  groqSvc.enrichQuestion = savedEnrich;
  ragSvc.answerQuestion  = savedAnswer;
  supabase.from = savedFrom;
});
