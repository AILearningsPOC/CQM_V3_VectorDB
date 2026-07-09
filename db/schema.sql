-- ================================================================
-- CQM v3 — Complete Supabase Schema (Qdrant vector DB edition)
-- Run this entire script in the NEW v3 Supabase project SQL Editor.
--
-- Differences from v2:
--   * NO pgvector extension, NO vector(384) column, NO search_kb_vector()
--   * knowledge_base gains qdrant_point_id (UUID reference into Qdrant)
--   * knowledge_base.id is generated in application code so the same
--     UUID can be written to Qdrant FIRST, then Supabase (two-store
--     write ordering — see backend/src/services/kbStore.js)
-- ================================================================

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
  source              TEXT DEFAULT 'scraper',    -- scraper only (manual creation blocked by design)

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

-- ── KNOWLEDGE BASE (v3: vectors live in Qdrant, not here) ───────
-- Timestamp semantics (three concepts now — do not conflate):
--   created_at         when the KB row was created (Supabase)
--   updated_at         when the KB row metadata last changed (Supabase)
--   vector_synced_at   when the embedding was last upserted to Qdrant
CREATE TABLE IF NOT EXISTS knowledge_base (
  id               UUID PRIMARY KEY,             -- generated in app code (== Qdrant point id)
  title            TEXT,
  content          TEXT NOT NULL,
  category         TEXT DEFAULT 'other',
  source           TEXT DEFAULT 'manual',        -- manual | pdf_manual | approved_answer | product_spec | v2_migration
  qdrant_point_id  UUID,                         -- NULL = no vector in Qdrant yet (keyword search only)
  vector_synced_at TIMESTAMPTZ,                  -- when the vector was last upserted to Qdrant
  has_pdf          BOOLEAN DEFAULT FALSE,
  pdf_filename     TEXT,
  pdf_url          TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_kb_category ON knowledge_base(category);
CREATE INDEX IF NOT EXISTS idx_kb_source   ON knowledge_base(source);
CREATE INDEX IF NOT EXISTS idx_kb_qdrant   ON knowledge_base(qdrant_point_id);

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

INSERT INTO config (key, value) VALUES
  ('scraping_config',  '{"auto_enabled": true, "interval_minutes": 10, "engine": "scraperapi"}'::jsonb),
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

-- NOTE: no SEED KNOWLEDGE BASE block here. KB entries are loaded by
-- scripts/migrate-v2-kb.js which re-embeds v2's entries and writes
-- Qdrant first, Supabase second (the v3 two-store write ordering).

-- ── SUPABASE STORAGE BUCKET ──────────────────────────────────────
-- Create manually: Dashboard → Storage → New bucket → name: manuals, Public: ON
-- Or run:
-- INSERT INTO storage.buckets (id, name, public) VALUES ('manuals', 'manuals', true) ON CONFLICT DO NOTHING;

-- ================================================================
-- DONE. Verify with:
-- SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';
-- ================================================================
