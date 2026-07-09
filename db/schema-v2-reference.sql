-- ================================================================
-- CQM v2 — Complete Supabase Schema
-- Run this entire script in Supabase SQL Editor
-- ================================================================

-- Enable vector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- ── SCRAPE TARGETS ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scrape_targets (
  id                     UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  retailer               TEXT NOT NULL,
  product_name           TEXT NOT NULL,
  url                    TEXT NOT NULL,
  is_active              BOOLEAN DEFAULT TRUE,
  added_at               TIMESTAMPTZ DEFAULT NOW(),
  last_scraped_at        TIMESTAMPTZ,
  questions_found_total  INTEGER DEFAULT 0,
  UNIQUE(retailer, url)
);

-- ── QUESTIONS ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS questions (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  question_text       TEXT NOT NULL,
  customer_name       TEXT,
  date_asked          TIMESTAMPTZ,
  retailer            TEXT,
  product_name        TEXT,
  product_url         TEXT,
  existing_answer     TEXT,
  answer_status       TEXT DEFAULT 'unanswered',
  content_hash        TEXT UNIQUE,
  source              TEXT DEFAULT 'scraper',    -- scraper | manual

  -- Enrichment
  language            TEXT,
  category            TEXT,
  sentiment           TEXT,
  assigned_to         TEXT,

  -- AI answer
  ai_answer           TEXT,
  confidence          INTEGER,
  status              TEXT DEFAULT 'pending',     -- pending | review | answered
  review_reason       TEXT,
  date_answered       TIMESTAMPTZ,
  processed_at        TIMESTAMPTZ,

  -- Posting
  posted_to_retailer  BOOLEAN DEFAULT FALSE,
  posted_at           TIMESTAMPTZ,

  created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_questions_status    ON questions(status);
CREATE INDEX IF NOT EXISTS idx_questions_retailer  ON questions(retailer);
CREATE INDEX IF NOT EXISTS idx_questions_category  ON questions(category);
CREATE INDEX IF NOT EXISTS idx_questions_assigned  ON questions(assigned_to);
CREATE INDEX IF NOT EXISTS idx_questions_created   ON questions(created_at DESC);

-- ── KNOWLEDGE BASE ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS knowledge_base (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  title        TEXT,
  content      TEXT NOT NULL,
  category     TEXT DEFAULT 'other',
  source       TEXT DEFAULT 'manual',    -- manual | pdf_manual | approved_answer | product_spec
  embedding    vector(384),
  has_pdf      BOOLEAN DEFAULT FALSE,
  pdf_filename TEXT,
  pdf_url      TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_kb_category ON knowledge_base(category);
CREATE INDEX IF NOT EXISTS idx_kb_source   ON knowledge_base(source);

-- IVFFlat index for vector search (run after data exists)
-- CREATE INDEX ON knowledge_base USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- ── AGENTS ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agents (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  role         TEXT DEFAULT 'agent',    -- admin | manager | agent
  skills       TEXT[] DEFAULT '{}',
  retailer_ids TEXT[] DEFAULT '{}',
  is_active    BOOLEAN DEFAULT TRUE,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ── SCRAPE LOGS ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scrape_logs (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  target_id    UUID REFERENCES scrape_targets(id) ON DELETE SET NULL,
  retailer     TEXT,
  product_name TEXT,
  url          TEXT,
  engine_used  TEXT,
  scraped_at   TIMESTAMPTZ DEFAULT NOW(),
  found_count  INTEGER DEFAULT 0,
  new_count    INTEGER DEFAULT 0,
  error        TEXT
);

CREATE INDEX IF NOT EXISTS idx_scrape_logs_scraped ON scrape_logs(scraped_at DESC);

-- ── CONFIG ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS config (
  key        TEXT PRIMARY KEY,
  value      JSONB,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Default config rows
INSERT INTO config (key, value) VALUES
  ('scraping_config',  '{"auto_enabled": true, "interval_minutes": 10, "engine": "apify"}'::jsonb),
  ('posting_enabled',  'false'::jsonb),
  ('active_role',      '"admin"'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ── SEED AGENTS ──────────────────────────────────────────────────
INSERT INTO agents (name, role, skills, retailer_ids) VALUES
  ('Admin User',    'admin',   ARRAY['product_info','pricing','warranty','compatibility','usage','complaints','returns','other'], ARRAY['bestbuy','amazon']),
  ('Sarah Manager', 'manager', ARRAY['product_info','pricing','warranty','compatibility','usage','complaints','returns','other'], ARRAY['bestbuy','amazon']),
  ('Alex Agent',    'agent',   ARRAY['product_info','pricing','compatibility','usage'], ARRAY['bestbuy','amazon']),
  ('Jamie Agent',   'agent',   ARRAY['warranty','complaints','returns','other'],        ARRAY['bestbuy','amazon'])
ON CONFLICT (name) DO NOTHING;

-- ── SEED KNOWLEDGE BASE ──────────────────────────────────────────
INSERT INTO knowledge_base (title, content, category, source) VALUES
  ('Hisense U6 Series Overview',
   'The Hisense U6 Series 55" MiniLED QLED 4K TV features 4K QLED display with MiniLED backlight technology, ULED X image processing, Dolby Vision, HDR10+, and HLG support. It runs Google TV OS with built-in Alexa and Google Assistant.',
   'product_info', 'product_spec'),

  ('Hisense U8 Series Overview',
   'The Hisense U8 Series 65" MiniLED QLED 4K TV features 1000+ local dimming zones, 144Hz refresh rate for gaming, ALLM and VRR support, Dolby Atmos audio with 2.1.2 channel sound system, and 4K upscaling engine.',
   'product_info', 'product_spec'),

  ('Hisense Warranty Policy',
   'Hisense products come with a standard 1-year limited warranty covering manufacturing defects and hardware failures under normal use. Extended warranty options are available through authorized retailers. Warranty does not cover physical damage, water damage, or unauthorized modifications.',
   'warranty', 'manual'),

  ('Return Policy',
   'Most retailers accept returns within 15-30 days of purchase. Items must be in original packaging with all accessories. Best Buy offers a 15-day return window for televisions. Amazon offers 30-day returns for most electronics. Contact the retailer where purchased for specific return instructions.',
   'returns', 'manual'),

  ('TV Setup Instructions',
   'To set up your Hisense TV: 1) Attach the stand or mount the TV on wall bracket. 2) Connect power cable. 3) Press power button on TV or remote. 4) Follow on-screen setup wizard to connect to WiFi. 5) Sign into your Google/Apple account for streaming apps. 6) Run picture calibration wizard for optimal image quality.',
   'usage', 'manual'),

  ('HDMI and Compatibility',
   'Hisense U6 and U8 Series TVs include HDMI 2.1 ports supporting 4K@144Hz, 8K@60Hz pass-through, eARC on HDMI 1, and ALLM/VRR for gaming. Compatible with PlayStation 5, Xbox Series X/S, and PC gaming. HDMI 2.0 ports available for standard 4K@60Hz devices.',
   'compatibility', 'manual'),

  ('Pricing and Availability',
   'Hisense U6 Series 55" TV is typically priced between $349-$449. Hisense U8 Series 65" TV is typically priced between $649-$799. Prices vary by retailer and promotional periods. Check BestBuy.com and Amazon.com for current pricing and availability.',
   'pricing', 'manual'),

  ('Smart TV Features',
   'Hisense Google TV provides access to 10,000+ apps including Netflix, Disney+, HBO Max, YouTube, and more. Voice control with Google Assistant and Amazon Alexa built-in. Chromecast built-in for casting from mobile devices. AirPlay 2 support for Apple devices.',
   'usage', 'manual')
ON CONFLICT DO NOTHING;

-- ── VECTOR SEARCH FUNCTION ───────────────────────────────────────
CREATE OR REPLACE FUNCTION search_kb_vector(
  query_embedding vector(384),
  match_count     int DEFAULT 5
)
RETURNS TABLE (
  id        UUID,
  title     TEXT,
  content   TEXT,
  category  TEXT,
  source    TEXT,
  similarity FLOAT
)
LANGUAGE SQL STABLE
AS $$
  SELECT
    id, title, content, category, source,
    1 - (embedding <=> query_embedding) AS similarity
  FROM knowledge_base
  WHERE embedding IS NOT NULL
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;

-- ── SUPABASE STORAGE BUCKET ──────────────────────────────────────
-- Run this separately in Supabase Dashboard → Storage → Create bucket:
-- Bucket name: manuals
-- Public: true
-- Or run:
-- INSERT INTO storage.buckets (id, name, public) VALUES ('manuals', 'manuals', true) ON CONFLICT DO NOTHING;

-- ================================================================
-- DONE. Verify with:
-- SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';
-- ================================================================
