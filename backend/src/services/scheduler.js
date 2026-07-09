const cron = require('node-cron');
const supabase = require('../utils/supabase');
const { scrapeAll } = require('./scraper');
const { processQuestion } = require('./enrichment');

let scrapeJob = null;

async function getConfig() {
  try {
    const { data } = await supabase.from('config').select('value').eq('key', 'scraping_config').single();
    return data?.value || { auto_enabled: true, interval_minutes: 10, engine: 'apify' };
  } catch { return { auto_enabled: true, interval_minutes: 10, engine: 'apify' }; }
}

async function runScrapeAndEnrich() {
  try {
    const config = await getConfig();
    if (!config.auto_enabled) return;
    console.log(`[Scheduler] Running with engine: ${config.engine}`);
    try {
      const result = await scrapeAll(config.engine);
      console.log(`[Scheduler] Scraped ${result.scraped || 0} targets`);
    } catch (err) { console.error('[Scheduler] Scrape failed:', err.message); return; }
    try {
      const { data: pending } = await supabase.from('questions').select('id').eq('status', 'pending').is('processed_at', null).limit(20);
      if (pending?.length) {
        console.log(`[Scheduler] Processing ${pending.length} pending questions`);
        for (const q of pending) { try { await processQuestion(q.id); } catch (e) { console.error(`[Scheduler] processQuestion failed for ${q.id}:`, e.message); } }
      }
    } catch (err) { console.error('[Scheduler] Processing failed:', err.message); }
  } catch (err) { console.error('[Scheduler] runScrapeAndEnrich error:', err.message); }
}

async function startScheduler() {
  try {
    const config = await getConfig();
    const interval = Math.max(config.interval_minutes || 10, 5);
    if (scrapeJob) { try { scrapeJob.stop(); } catch (e) {} }
    scrapeJob = cron.schedule(`*/${interval} * * * *`, () => runScrapeAndEnrich().catch(err => console.error('[Scheduler] Cron error:', err.message)));
    console.log(`[Scheduler] Started — every ${interval} minutes, engine: ${config.engine}`);
  } catch (err) { console.error('[Scheduler] startScheduler failed:', err.message); }
}

async function restartScheduler() { await startScheduler(); }

startScheduler().catch(err => console.error('[Scheduler] Boot failed:', err.message));

setTimeout(async () => {
  try {
    const { data: pending } = await supabase.from('questions').select('id').eq('status', 'pending').is('processed_at', null).limit(20);
    if (pending?.length) { for (const q of pending) { try { await processQuestion(q.id); } catch (e) {} } }
  } catch (err) { console.error('[Startup] Pending processing failed:', err.message); }
}, 5000);

module.exports = { restartScheduler };
// BUILD: v2.7.20260706130323
