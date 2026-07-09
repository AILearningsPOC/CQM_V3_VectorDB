#!/usr/bin/env node
// CQM v3 — one-time migration of v2 knowledge_base entries.
//
// READS from v2 Supabase (read-only — no writes ever issued to v2),
// re-embeds each entry's content via HuggingFace, then writes using the
// v3 two-store ordering: Qdrant FIRST, v3 Supabase SECOND.
//
// Usage (from backend/ so it shares node_modules):
//   V2_SUPABASE_URL=... V2_SUPABASE_SERVICE_KEY=... npm run migrate:v2-kb
// plus the normal v3 .env (SUPABASE_URL, SUPABASE_SERVICE_KEY, QDRANT_*, HF_API_KEY).
//
// Idempotent: rows already migrated (matched by v2 id stored in payload &
// a deterministic content check) are skipped, so it's safe to re-run after
// a partial failure.
require('dotenv').config({ path: require('path').join(__dirname, '..', 'backend', '.env') });
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const { generateEmbedding } = require('../backend/src/services/embedding');
const qdrant = require('../backend/src/services/qdrant');

function fatal(msg) { console.error(`\n[migrate] FATAL: ${msg}\n`); process.exit(1); }

const V2_URL = process.env.V2_SUPABASE_URL;
const V2_KEY = process.env.V2_SUPABASE_SERVICE_KEY;
const V3_URL = process.env.SUPABASE_URL;
const V3_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!V2_URL || !V2_KEY) fatal('V2_SUPABASE_URL / V2_SUPABASE_SERVICE_KEY not set (read-only export source).');
if (!V3_URL || !V3_KEY) fatal('SUPABASE_URL / SUPABASE_SERVICE_KEY not set (v3 destination).');
if (V2_URL === V3_URL) fatal('v2 and v3 Supabase URLs are identical — v3 must be a NEW project. Aborting to protect v2.');
if (!process.env.QDRANT_URL || !process.env.QDRANT_API_KEY) fatal('QDRANT_URL / QDRANT_API_KEY not set.');
if (!process.env.HF_API_KEY) fatal('HF_API_KEY not set (needed to re-embed).');

const v2 = createClient(V2_URL, V2_KEY, { auth: { persistSession: false } });
const v3 = createClient(V3_URL, V3_KEY, { auth: { persistSession: false } });

function contentHash(content) { return crypto.createHash('md5').update(content).digest('hex'); }

async function main() {
  console.log('[migrate] Ensuring Qdrant collection exists...');
  await qdrant.ensureCollection();

  console.log('[migrate] Reading v2 knowledge_base (read-only)...');
  const { data: v2Rows, error: v2Err } = await v2.from('knowledge_base')
    .select('id,title,content,category,source,has_pdf,pdf_filename,pdf_url,created_at')
    .order('created_at', { ascending: true });
  if (v2Err) fatal(`v2 read failed: ${v2Err.message}`);
  if (!v2Rows?.length) { console.log('[migrate] v2 KB is empty — nothing to migrate.'); return; }
  console.log(`[migrate] Found ${v2Rows.length} v2 KB entries.`);

  // Idempotency: skip entries whose content hash already exists in v3
  const { data: existing, error: exErr } = await v3.from('knowledge_base').select('id,content');
  if (exErr) fatal(`v3 read failed: ${exErr.message}. Did you run db/schema.sql on the v3 project?`);
  const existingHashes = new Set((existing || []).map(r => contentHash(r.content)));

  let migrated = 0, skipped = 0;
  const failures = [];

  for (const [idx, row] of v2Rows.entries()) {
    const label = `${idx + 1}/${v2Rows.length} "${(row.title || row.content).slice(0, 50)}"`;
    if (existingHashes.has(contentHash(row.content))) {
      console.log(`[migrate] SKIP  ${label} (already in v3)`);
      skipped++;
      continue;
    }
    try {
      const id = crypto.randomUUID();
      const vector = await generateEmbedding(row.content);
      // Qdrant FIRST
      await qdrant.upsertPoint(id, vector, {
        supabase_id: id,
        v2_id: row.id,
        title: (row.title || '').slice(0, 200),
        content: row.content,
        category: row.category || 'other',
        source: row.source || 'v2_migration'
      });
      // v3 Supabase SECOND
      const now = new Date().toISOString();
      const { error: insErr } = await v3.from('knowledge_base').insert({
        id,
        title: row.title,
        content: row.content,
        category: row.category || 'other',
        source: row.source || 'v2_migration',
        qdrant_point_id: id,
        vector_synced_at: now,
        has_pdf: row.has_pdf || false,
        pdf_filename: row.pdf_filename,
        pdf_url: row.pdf_url,
        created_at: row.created_at || now
      });
      if (insErr) {
        // compensating delete — keep the stores consistent even mid-migration
        try {
          await qdrant.deletePoint(id);
          throw new Error(`v3 insert failed (${insErr.message}); Qdrant point rolled back cleanly.`);
        } catch (cleanupErr) {
          if (cleanupErr.message.includes('rolled back')) throw cleanupErr;
          throw new Error(`v3 insert failed (${insErr.message}) AND Qdrant rollback failed (${cleanupErr.message}) — ORPHANED POINT ${id}. Run POST /api/knowledge-base/reconcile?fix=true after fixing credentials.`);
        }
      }
      console.log(`[migrate] OK    ${label}`);
      migrated++;
    } catch (err) {
      console.error(`[migrate] FAIL  ${label}: ${err.message}`);
      failures.push({ v2_id: row.id, title: row.title, error: err.message });
    }
  }

  console.log('\n[migrate] ──────────── SUMMARY ────────────');
  console.log(`[migrate] Migrated: ${migrated}   Skipped (already present): ${skipped}   Failed: ${failures.length}`);
  if (failures.length) {
    console.log('[migrate] Failures (re-run this script to retry — it is idempotent):');
    failures.forEach(f => console.log(`  - ${f.title || f.v2_id}: ${f.error}`));
    process.exit(2);
  }
  // Post-migration verification
  const cap = await qdrant.getCapacityStatus();
  const { count } = await v3.from('knowledge_base').select('*', { count: 'exact', head: true });
  console.log(`[migrate] Verify: v3 Supabase rows=${count}, Qdrant points=${cap.points_count} (should match for vectorized entries).`);
  console.log('[migrate] Done.');
}

main().catch(err => fatal(err.message));
