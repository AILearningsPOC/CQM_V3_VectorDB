// CQM v3 — knowledge_base routes.
// Public contracts unchanged from v2 (frontend untouched), but every KB
// write/delete now goes through kbStore (Qdrant-first two-store strategy).
// New in v3: POST /reconcile — detects/repairs cross-store inconsistencies.
// Still NO plain POST / route: manual KB creation is blocked by design.
const express = require('express');
const router = express.Router();
const multer = require('multer');
const supabase = require('../utils/supabase');
const kbStore = require('../services/kbStore');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// In-memory PDF cache for immediate serving after upload
const pdfCache = new Map();

// GET /api/knowledge-base
router.get('/', async (req, res) => {
  try {
    const { category, source, search, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query = supabase.from('knowledge_base')
      .select('id,title,content,category,source,created_at,has_pdf,pdf_filename,pdf_url,qdrant_point_id,vector_synced_at', { count: 'exact' });
    if (category) query = query.eq('category', category);
    if (source)   query = query.eq('source', source);
    if (search)   query = query.ilike('content', `%${search}%`);

    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .range(offset, offset + parseInt(limit) - 1);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ data: data || [], total: count || 0 });
  } catch (err) {
    console.error('[kb.GET /]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/knowledge-base/reconcile?fix=true
// Detects (and with fix=true, repairs) two-store inconsistencies:
// orphaned Qdrant points and un-synced Supabase rows.
router.post('/reconcile', async (req, res) => {
  try {
    const fix = req.query.fix === 'true' || req.body?.fix === true;
    const report = await kbStore.reconcile({ fix });
    res.json(report);
  } catch (err) {
    console.error('[kb.POST /reconcile]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/knowledge-base/backfill-embeddings
// Same endpoint contract as v2 (frontend button unchanged) — now embeds and
// upserts into Qdrant for every row with qdrant_point_id IS NULL.
router.post('/backfill-embeddings', async (req, res) => {
  try {
    const result = await kbStore.backfillVectors(50);
    res.json(result);
  } catch (err) {
    console.error('[kb.POST /backfill-embeddings]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/knowledge-base/upload-pdf
router.post('/upload-pdf', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No PDF uploaded' });

    const pdfParse = require('pdf-parse');
    let text = '';
    try {
      const parsed = await pdfParse(req.file.buffer);
      text = parsed.text.replace(/\s+/g, ' ').trim();
    } catch (parseErr) {
      return res.status(400).json({ error: 'Could not extract text from PDF. Ensure it is a text-based (not scanned) PDF.' });
    }

    if (text.length < 50) return res.status(400).json({ error: 'Could not extract meaningful text from PDF' });

    const filename = `${Date.now()}_${req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

    // ── STORAGE UPLOAD (unchanged from v2) ─────────────────────────
    let pdfUrl = null;
    let storageSuccess = false;
    try {
      console.log(`[KB] Uploading PDF to storage: ${filename}`);
      const { data: uploadData, error: uploadError } = await supabase.storage
        .from('manuals')
        .upload(filename, req.file.buffer, { contentType: 'application/pdf', upsert: true, cacheControl: '3600' });
      if (uploadError) {
        console.error('[KB] Storage upload error:', uploadError.message, uploadError);
      } else {
        console.log('[KB] Storage upload success:', uploadData);
        const { data: urlData } = supabase.storage.from('manuals').getPublicUrl(filename);
        pdfUrl = urlData?.publicUrl || null;
        storageSuccess = true;
        console.log('[KB] Public URL:', pdfUrl);
      }
    } catch (storageErr) {
      console.error('[KB] Storage exception:', storageErr.message);
    }

    // ── CACHE PDF BUFFER in memory for immediate streaming ─────────
    pdfCache.set(filename, {
      buffer: req.file.buffer,
      contentType: 'application/pdf',
      originalName: req.file.originalname,
      uploadedAt: Date.now()
    });
    console.log(`[KB] PDF cached in memory: ${filename} (${req.file.buffer.length} bytes)`);

    const previewUrl = pdfUrl || null;

    // ── CHUNK AND STORE via kbStore (Qdrant first, Supabase second) ─
    const chunkSize = 500;
    const chunks = [];
    for (let i = 0; i < text.length; i += chunkSize) chunks.push(text.slice(i, i + chunkSize));

    const title = req.file.originalname.replace(/\.pdf$/i, '');
    const maxChunks = Math.min(chunks.length, 50);
    const inserted = [];
    const chunkWarnings = [];
    const chunkFailures = [];

    for (let i = 0; i < maxChunks; i++) {
      try {
        const result = await kbStore.insertKBEntry({
          title: `${title} (part ${i + 1}/${maxChunks})`,
          content: chunks[i],
          category: req.body.category || 'product_info',
          source: 'pdf_manual',
          has_pdf: true,
          pdf_filename: filename,
          pdf_url: previewUrl
        });
        inserted.push(result.id);
        if (result.warning) chunkWarnings.push({ chunk: i + 1, warning: result.warning });
      } catch (e) {
        console.error(`[KB] Chunk ${i + 1} insert failed in both stores:`, e.message);
        chunkFailures.push({ chunk: i + 1, error: e.message });
      }
    }

    if (inserted.length === 0) {
      return res.status(502).json({
        error: 'PDF processed but no chunks could be stored.',
        chunk_failures: chunkFailures,
        hint: 'Check SUPABASE_URL/SUPABASE_SERVICE_KEY and QDRANT_URL/QDRANT_API_KEY.'
      });
    }

    res.json({
      success: true,
      chunks_stored: inserted.length,
      chunks_failed: chunkFailures.length,
      chunks_without_vector: chunkWarnings.length,
      total_chars: text.length,
      pdf_url: previewUrl,
      filename,
      storage_used: storageSuccess,
      preview_endpoint: `/api/knowledge-base/pdf/${filename}`,
      ...(chunkWarnings.length && { warning: `${chunkWarnings.length} chunk(s) stored without vectors (keyword search only). Run 'Rebuild KB Search Index' to fix.` }),
      ...(chunkFailures.length && { failures: chunkFailures })
    });
  } catch (err) {
    console.error('[kb.POST /upload-pdf]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/knowledge-base/pdf/:filename  (unchanged from v2)
router.get('/pdf/:filename', async (req, res) => {
  const filename = decodeURIComponent(req.params.filename);
  console.log(`[KB] PDF request: ${filename}`);

  const cached = pdfCache.get(filename);
  if (cached) {
    console.log(`[KB] Serving from memory cache: ${filename}`);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${cached.originalName}"`);
    res.setHeader('Content-Length', cached.buffer.length);
    return res.send(cached.buffer);
  }

  try {
    console.log(`[KB] Trying storage download: ${filename}`);
    const { data, error } = await supabase.storage.from('manuals').download(filename);
    if (error) {
      console.error('[KB] Storage download failed:', error.message);
      return res.status(404).json({
        error: 'PDF not found. The file may have expired from cache. Please re-upload the PDF.',
        hint: 'PDFs are cached temporarily. For permanent storage, ensure the Supabase "manuals" bucket is public.'
      });
    }
    const buffer = Buffer.from(await data.arrayBuffer());
    console.log(`[KB] Serving from storage: ${filename} (${buffer.length} bytes)`);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length);
    return res.send(buffer);
  } catch (err) {
    console.error('[kb.GET /pdf/:filename]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/knowledge-base/:id
// Registered AFTER the fixed-path routes so the param route doesn't shadow them.
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('knowledge_base').select('*').eq('id', req.params.id).single();
    if (error || !data) return res.status(404).json({ error: 'Not found' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/knowledge-base/:id — Qdrant point first, Supabase row second
router.delete('/:id', async (req, res) => {
  try {
    await kbStore.deleteKBEntry(req.params.id);
    res.json({ success: true });
  } catch (err) {
    if (err.notFound) return res.status(404).json({ error: 'Not found' });
    console.error('[kb.DELETE /:id]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
// BUILD: v3.0
