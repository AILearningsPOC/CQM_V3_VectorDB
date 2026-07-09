const express = require('express');
const router = express.Router();
const multer = require('multer');
const XLSX = require('xlsx');
const supabase = require('../utils/supabase');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// GET all scrape targets
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase.from('scrape_targets').select('*').order('added_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) {
    console.error('[scrapeTargets.GET /]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST upload Excel
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    let workbook;
    try {
      workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    } catch (parseErr) {
      return res.status(400).json({ error: 'Invalid Excel file. Please upload a valid .xlsx or .xls file.' });
    }

    if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
      return res.status(400).json({ error: 'Excel file has no sheets' });
    }

    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet);

    const targets = rows
      .filter(r => r.retailer && r.product_name && r.url)
      .map(r => ({
        retailer: r.retailer.toString().toLowerCase().trim(),
        product_name: r.product_name.toString().trim(),
        url: r.url.toString().trim(),
        is_active: r.active?.toString().toLowerCase() !== 'no'
      }));

    if (targets.length === 0) {
      return res.status(400).json({ error: 'No valid rows found. Check columns: retailer, product_name, url, active' });
    }

    const { data, error } = await supabase
      .from('scrape_targets')
      .upsert(targets, { onConflict: 'retailer,url' })
      .select();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ inserted: data.length, targets: data });
  } catch (err) {
    console.error('[scrapeTargets.POST /upload]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET download Excel template
router.get('/template', (req, res) => {
  try {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ['retailer', 'product_name', 'url', 'active'],
      ['bestbuy', 'Hisense 55" U6 Series MiniLED TV',     'https://www.bestbuy.com/site/questions/hisense-55-u6-series/6501890', 'yes'],
      ['bestbuy', 'Hisense 65" U8 Series MiniLED TV',     'https://www.bestbuy.com/site/questions/hisense-65-u8-series/6501891', 'yes'],
      ['amazon',  'Hisense 55" U6 Series MiniLED TV',     'https://www.amazon.com/ask/questions/asin/B0BVWZLMK5',               'yes'],
      ['amazon',  'Hisense 65" U8 Series MiniLED TV',     'https://www.amazon.com/ask/questions/asin/B0BVWZLMK6',               'yes'],
      ['target',  'Hisense 55" 4K UHD Smart Google TV',   'https://www.target.com/p/hisense-55-class-a6-series/-/A-91476601',   'yes'],
      ['target',  'Hisense 65" 4K UHD Smart Google TV',   'https://www.target.com/p/hisense-65-class-a6-series/-/A-91476602',   'yes'],
    ]);
    ws['!cols'] = [{ wch: 10 }, { wch: 42 }, { wch: 65 }, { wch: 8 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Scrape Targets');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="cqm_scrape_targets_template.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    console.error('[scrapeTargets.GET /template]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PATCH activate/deactivate/edit
router.patch('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('scrape_targets').update(req.body).eq('id', req.params.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Scrape target not found' });
    res.json(data);
  } catch (err) {
    console.error('[scrapeTargets.PATCH /:id]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE target
router.delete('/:id', async (req, res) => {
  try {
    const { error } = await supabase.from('scrape_targets').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (err) {
    console.error('[scrapeTargets.DELETE /:id]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
// BUILD: v2.7.20260706130323
