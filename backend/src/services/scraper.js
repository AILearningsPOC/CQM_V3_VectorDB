const axios = require('axios');
const supabase = require('../utils/supabase');
const crypto = require('crypto');

// ScraperAPI proxy — rotates IPs to bypass rate limiting
async function proxyRequest(targetUrl, asJson = false) {
  const key = process.env.SCRAPERAPI_KEY;
  if (!key) throw new Error('SCRAPERAPI_KEY not configured');

  const params = new URLSearchParams({
    api_key: key,
    url: targetUrl,
    country_code: 'us',
  });

  if (asJson) {
    // JSON API: no JS rendering needed, but pass headers to get JSON response
    params.append('keep_headers', 'true');
  } else {
    // HTML page: need JS rendering
    params.append('render', 'true');
    params.append('keep_headers', 'true');
  }

  const response = await axios.get('http://api.scraperapi.com?' + params.toString(), {
    timeout: 90000,
    headers: {
      'Accept': asJson ? 'application/json, text/plain, */*' : 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Referer': 'https://www.bestbuy.com',
    },
    decompress: true
  });
  return response.data;
}

// BestBuy — calls JSON API directly (no HTML parsing needed)
async function scrapeBestBuy(url) {
  const skuMatch = url.match(/\/(\d{7,8})(?:\/|$|\?|#)/);
  if (!skuMatch) throw new Error(`Cannot extract SKU from BestBuy URL: ${url}`);
  const sku = skuMatch[1];
  console.log(`[BestBuy] Scraping SKU ${sku} — paginating all pages`);

  const allQuestions = [];
  const pageSize = 30;
  let page = 1;
  let totalResults = null;

  // Paginate through ALL pages to ensure we don't miss unanswered questions
  while (true) {
    const apiUrl = `https://www.bestbuy.com/ugc/v2/questions?page=${page}&pageSize=${pageSize}&sku=${sku}&sort=MOST_RECENT&source=pr`;
    let data;
    try {
      const raw = await proxyRequest(apiUrl, true);
      data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (err) {
      console.warn(`[BestBuy] Page ${page} failed: ${err.message}`);
      break;
    }

    if (totalResults === null) {
      totalResults = data?.totalResults || 0;
      console.log(`[BestBuy] SKU ${sku}: totalResults=${totalResults}`);
    }

    const arr = data?.questions || data?.results || data?.topics || [];
    console.log(`[BestBuy] Page ${page}: got ${arr.length} questions`);

    if (arr.length === 0) break;

    arr.forEach(q => {
      allQuestions.push({
        question_text: (q.questionTitle || q.questionText || q.question || '').trim(),
        existing_answer: q.answersForQuestion?.[0]?.answerText || q.answers?.[0]?.answerText || null,
        answer_status: ((q.answersForQuestion?.length || q.answers?.length || 0) > 0) ? 'answered' : 'unanswered',
        date_asked: q.submissionTime ? new Date(q.submissionTime).toISOString() : null,
        customer_name: q.userNickname || null
      });
    });

    // Stop if we got fewer results than pageSize (last page) or hit totalResults
    if (arr.length < pageSize || allQuestions.length >= totalResults) break;
    const maxPgs = parseInt(process.env.MAX_SCRAPE_PAGES || '5', 10);
    if (page >= maxPgs) { console.warn('[BestBuy] Reached MAX_SCRAPE_PAGES limit: ' + maxPgs); break; }
    page++;
  }

  console.log(`[BestBuy] SKU ${sku}: scraped ${allQuestions.length} total questions across ${page} page(s)`);
  return allQuestions.filter(q => q.question_text.length > 5);
}


// Amazon — HTML scraping with data-hook selectors
async function scrapeAmazon(url) {
  const asinMatch = url.match(/\/(?:dp|asin|ask\/questions\/asin)\/([A-Z0-9]{10})/);
  if (!asinMatch) throw new Error(`Cannot extract ASIN from Amazon URL: ${url}`);
  const asin = asinMatch[1];
  console.log(`[Amazon] Fetching Q&A for ASIN ${asin}`);
  const html = await proxyRequest(`https://www.amazon.com/ask/questions/asin/${asin}/1?isAnswered=false`, false);
  return parseAmazonHTML(html);
}

function parseAmazonHTML(html) {
  if (!html || html.length < 100) return [];
  const hookMatches = [...html.matchAll(/data-hook="ask-btf-question-text"[^>]*>([\s\S]{5,500}?)<\/span>/gi)];
  if (hookMatches.length > 0) {
    const answerHooks = [...html.matchAll(/data-hook="ask-btf-answer-text"[^>]*>([\s\S]{5,500}?)<\/span>/gi)];
    const dateHooks = [...html.matchAll(/data-hook="ask-btf-question-date"[^>]*>([\s\S]{5,100}?)<\/span>/gi)];
    const authorHooks = [...html.matchAll(/data-hook="ask-btf-answer-author"[^>]*>([\s\S]{5,100}?)<\/span>/gi)];
    return hookMatches.map((m, i) => ({
      question_text: stripTags(m[1]).trim(),
      existing_answer: answerHooks[i] ? stripTags(answerHooks[i][1]).trim() : null,
      answer_status: answerHooks[i] ? 'answered' : 'unanswered',
      date_asked: dateHooks[i] ? parseDate(stripTags(dateHooks[i][1]).trim()) : null,
      customer_name: authorHooks[i] ? stripTags(authorHooks[i][1]).trim() : null
    })).filter(q => q.question_text.length > 5);
  }
  return [];
}

// Target — BazaarVoice API
async function scrapeTarget(url) {
  const tcinMatch = url.match(/A-(\d{7,9})(?:\/|$|\?|#)/);
  if (!tcinMatch) throw new Error(`Cannot extract TCIN from Target URL: ${url}`);
  const tcin = tcinMatch[1];
  console.log(`[Target] Fetching Q&A for TCIN ${tcin}`);
  const html = await proxyRequest(url, false);
  const passkeyMatch = html.match(/["']passkey["']\s*[:=]\s*["']([A-Za-z0-9]{20,60})["']/);
  if (passkeyMatch) {
    const res = await axios.get(`https://api.bazaarvoice.com/data/questions.json?passkey=${passkeyMatch[1]}&apiversion=5.4&filter=ProductId:${tcin}&include=Answers&limit=20`, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 });
    return (res.data?.Results || []).map(q => ({ question_text: q.QuestionSummary || '', existing_answer: q.Answers?.[0]?.AnswerText || null, answer_status: q.Answers?.length > 0 ? 'answered' : 'unanswered', date_asked: q.SubmissionTime ? new Date(q.SubmissionTime).toISOString() : null, customer_name: q.UserNickname || null })).filter(q => q.question_text.length > 5);
  }
  return extractQAFromJSON(html);
}

// Build paginated URLs for BestBuy JSON API
async function buildPageUrls(baseUrl) {
  const urls = [];
  const pageSize = 30;
  // First check how many total results exist
  try {
    const raw = await proxyRequest(baseUrl + '&page=1', true);
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const total = data?.totalResults || 0;
    const maxPages = parseInt(process.env.MAX_SCRAPE_PAGES || "5", 10);
    const pages = Math.min(Math.ceil(total / pageSize), maxPages);
    console.log(`[buildPageUrls] total=${total}, pages=${pages}`);
    for (let p = 1; p <= pages; p++) {
      urls.push({ url: baseUrl + `&page=${p}` });
    }
  } catch (e) {
    console.warn('[buildPageUrls] Failed to get total, using page 1 only:', e.message);
    urls.push({ url: baseUrl + '&page=1' });
  }
  return urls.length > 0 ? urls : [{ url: baseUrl + '&page=1' }];
}

// Apify — uses residential IPs to fetch BestBuy/Amazon JSON APIs
// Much faster than HTML rendering — calls JSON API directly through Apify proxy
async function scrapeWithApify(url, retailer) {
  const key = process.env.APIFY_API_KEY;
  if (!key) throw new Error('APIFY_API_KEY not configured');

  // Build the correct API URL to fetch based on retailer
  let apiUrl = url;
  if (retailer === 'bestbuy') {
    const skuMatch = url.match(/\/([0-9]{7,8})(?:\/|$|\?|#)/);
    if (skuMatch) {
      apiUrl = 'https://www.bestbuy.com/ugc/v2/questions?page=1&pageSize=30&sku=' + skuMatch[1] + '&sort=MOST_RECENT&source=pr';
    }
  } else if (retailer === 'amazon') {
    const asinMatch = url.match(/\/(?:dp|asin|ask\/questions\/asin)\/([A-Z0-9]{10})/);
    if (asinMatch) {
      apiUrl = 'https://www.amazon.com/ask/questions/asin/' + asinMatch[1] + '/1?isAnswered=false';
    }
  }

  // pageFunction: use fetch() inside the browser to call the API
  // This uses Apify residential IPs which bypass BestBuy/Amazon IP blocks
  // web-scraper context: jQuery, response, request, log (NO page object)
  const pageFn = `async function pageFunction(context) {
    var request = context.request;
    var log = context.log;
    var $ = context.jQuery;
    log.info('Fetching: ' + request.url);
    
    var bodyText = $('body').text() || $('pre').text() || '';
    log.info('Body length: ' + bodyText.length);
    
    if (!bodyText || bodyText.length < 10) {
      log.warning('Empty body');
      return [];
    }
    
    try {
      var data = JSON.parse(bodyText);
      var arr = data.questions || data.results || data.topics || [];
      log.info('Found ' + arr.length + ' items in JSON');
      
      return arr.filter(function(q) {
        return (q.questionTitle || q.questionText || '').length > 5;
      }).map(function(q) {
        var answers = q.answersForQuestion || q.answers || [];
        return {
          question_text: q.questionTitle || q.questionText || q.question || '',
          existing_answer: answers.length > 0 ? answers[0].answerText : null,
          answer_status: answers.length > 0 ? 'answered' : 'unanswered',
          date_asked: q.submissionTime || null,
          customer_name: q.userNickname || null
        };
      });
    } catch(e) {
      log.warning('Parse error: ' + e.message);
      return [];
    }
  }`;

  console.log('[Apify] Fetching via residential proxy: ' + apiUrl);

  let startRes;
  try {
    startRes = await axios.post(
      'https://api.apify.com/v2/acts/apify~web-scraper/runs',
      {
        startUrls: await buildPageUrls(apiUrl),
        maxRequestsPerCrawl: parseInt(process.env.MAX_SCRAPE_PAGES || "5", 10),
        maxConcurrency: 1,
        pageFunction: pageFn,
        timeoutSecs: 120
      },
      {
        params: { token: key },
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000
      }
    );
  } catch (err) {
    const status = err.response?.status;
    const msg = err.response?.data?.error?.message || err.message;
    if (status === 403) throw new Error('Apify 403: Approve actor permissions at https://console.apify.com/actors/moJRLRc85AitArpNN?approvePermissions=true — ' + msg);
    if (status === 401) throw new Error('Apify 401: Invalid API token. Update APIFY_API_KEY in Render. — ' + msg);
    if (status === 402) throw new Error('Apify 402: No compute units remaining. Check apify.com/billing — ' + msg);
    throw new Error('Apify start failed (' + status + '): ' + msg);
  }

  const runId = startRes.data.data.id;
  console.log('[Apify] Run started: ' + runId);

  // Poll for completion — 90 attempts x 10s = 15 min max
  let finalStatus = 'RUNNING';
  for (let i = 0; i < 90; i++) {
    await sleep(10000);
    try {
      const s = await axios.get('https://api.apify.com/v2/actor-runs/' + runId, { params: { token: key } });
      finalStatus = s.data.data.status;
      const elapsed = ((i + 1) * 10);
      console.log('[Apify] Poll ' + (i+1) + '/90 (' + elapsed + 's elapsed) — status: ' + finalStatus);
      if (finalStatus === 'SUCCEEDED') break;
      if (['FAILED','ABORTED','TIMED-OUT'].includes(finalStatus)) throw new Error('Apify run ' + finalStatus);
    } catch (pollErr) {
      if (pollErr.message.startsWith('Apify run')) throw pollErr;
      console.warn('[Apify] Poll error (non-fatal):', pollErr.message);
    }
  }

  if (finalStatus !== 'SUCCEEDED') throw new Error('Apify run still ' + finalStatus + ' after 15 min — will retry next scheduled scrape');

  const res = await axios.get('https://api.apify.com/v2/actor-runs/' + runId + '/dataset/items', { params: { token: key } });
  const items = [].concat(...(res.data || []));
  console.log('[Apify] Got ' + items.length + ' questions from dataset');
  return items.filter(q => q.question_text && q.question_text.length > 5);
}


// ── MAIN SCRAPE FUNCTION ───────────────────────────────────────────────────
async function scrapeTargetItem(target, engine) {
  const log = {
    target_id: target.id, retailer: target.retailer,
    product_name: target.product_name, url: target.url,
    engine_used: engine, scraped_at: new Date().toISOString(),
    found_count: 0, new_count: 0, error: null
  };

  try {
    let rawQuestions = [];

    if (engine === 'apify') {
      rawQuestions = await scrapeWithApify(target.url, target.retailer).catch(e => {
        log.error = e.message;
        console.error('[scrapeTargetItem] Apify failed:', e.message);
        return [];
      });
    } else {
      try {
        if (target.retailer === 'bestbuy')      rawQuestions = await scrapeBestBuy(target.url);
        else if (target.retailer === 'amazon')  rawQuestions = await scrapeAmazon(target.url);
        else if (target.retailer === 'target')  rawQuestions = await scrapeTarget(target.url);
      } catch (err) {
        log.error = err.message;
        console.error('[scrapeTargetItem] ' + target.retailer + ' failed:', err.message);
      }
    }

    // found_count set after unanswered filter below
    console.log('[scrapeTargetItem] ' + target.product_name + ': found ' + rawQuestions.length + ' questions');

    let newCount = 0;
    // Only scrape unanswered questions — ones without an existing answer on BestBuy
    const unansweredOnly = rawQuestions.filter(q => q.answer_status !== 'answered' && !q.existing_answer);
    console.log('[scrapeTargetItem] ' + rawQuestions.length + ' total, ' + unansweredOnly.length + ' unanswered');
    log.found_count = unansweredOnly.length;

    for (const q of unansweredOnly) {
      if (!q.question_text || q.question_text.trim().length < 5) continue;
      const hash = crypto.createHash('md5').update(q.question_text.toLowerCase().trim()).digest('hex');
      const { data: existing } = await supabase.from('questions').select('id').eq('content_hash', hash).single();
      if (existing) continue;
      const { error: insertErr } = await supabase.from('questions').insert({
        question_text: q.question_text.trim(),
        existing_answer: q.existing_answer || null,
        date_asked: q.date_asked || null,
        customer_name: q.customer_name || null,
        answer_status: q.answer_status || 'unanswered',
        retailer: target.retailer,
        product_name: target.product_name,
        product_url: target.url,
        content_hash: hash,
        status: 'pending',
        source: 'scraper'
      });
      if (insertErr) console.error('[scrapeTargetItem] Insert error:', insertErr.message);
      else newCount++;
    }

    log.new_count = newCount;
    try {
      await supabase.from('scrape_targets').update({
        last_scraped_at: new Date().toISOString(),
        questions_found_total: (target.questions_found_total || 0) + newCount
      }).eq('id', target.id);
    } catch (e) { console.error('[scrapeTargetItem] Update target failed:', e.message); }

  } catch (err) {
    log.error = err.message;
    console.error('[scrapeTargetItem] Top-level error:', err.message);
  }

  try { await supabase.from('scrape_logs').insert(log); } catch (e) {}
  return log;
}

async function scrapeAll(engine) {
  const { data: targets, error } = await supabase.from('scrape_targets').select('*').eq('is_active', true);
  if (error) throw new Error('Failed to fetch scrape targets: ' + error.message);
  if (!targets || targets.length === 0) return { message: 'No active scrape targets', scraped: 0, logs: [] };
  const logs = [];
  for (const target of targets) {
    try {
      logs.push(await scrapeTargetItem(target, engine));
    } catch (err) {
      console.error('[scrapeAll] Failed for ' + target.product_name + ':', err.message);
      logs.push({ product_name: target.product_name, error: err.message, new_count: 0, found_count: 0 });
    }
  }
  return { scraped: targets.length, logs };
}


// ── HELPERS ────────────────────────────────────────────────────────────────
function extractQAFromJSON(obj, depth = 0) {
  if (depth > 10 || !obj || typeof obj !== 'object') return [];
  const results = [];
  if (Array.isArray(obj)) {
    for (const item of obj) results.push(...extractQAFromJSON(item, depth + 1));
  } else {
    const text = obj.questionText || obj.question || obj.text || obj.body;
    if (text && typeof text === 'string' && text.length > 5) {
      results.push({
        question_text: text.trim(),
        existing_answer: obj.answerText || obj.answers?.[0]?.answerText || null,
        answer_status: obj.answers?.length > 0 ? 'answered' : 'unanswered',
        date_asked: obj.submissionTime ? new Date(obj.submissionTime).toISOString() : null,
        customer_name: obj.userNickname || obj.author || null
      });
    }
    for (const key of Object.keys(obj)) {
      if (!['__typename','__ref','extensions','headers'].includes(key)) {
        results.push(...extractQAFromJSON(obj[key], depth + 1));
      }
    }
  }
  return results;
}

function stripTags(html) {
  return (html || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function decodeStr(str) {
  return (str || '')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\n/g, ' ').replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim();
}

function parseDate(str) {
  try { return new Date(str).toISOString(); } catch { return null; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }


module.exports = { scrapeAll, scrapeTarget: scrapeTargetItem };
// BUILD: v2.7.20260706130323
