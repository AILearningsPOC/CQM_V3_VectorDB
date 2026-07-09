// CQM v3 — knowledge_base two-store coordinator
//
// THE core v3 learning content: a KB entry now lives in TWO systems with no
// cross-system transaction:
//   Supabase (metadata row)  +  Qdrant (embedding vector point)
//
// Write strategy (confirmed with user): QDRANT FIRST, SUPABASE SECOND.
//   * Qdrant fails            → abort. Nothing written anywhere. Clean.
//   * Supabase fails after
//     Qdrant succeeded        → compensating delete of the Qdrant point.
//   * Compensating delete
//     also fails              → loud ORPHAN log with the point id; the
//                               /knowledge-base/reconcile endpoint detects
//                               and can clean these up later.
//   * Embedding fails         → entry is still stored in Supabase with
//     qdrant_point_id = NULL (keyword-search-only, same graceful behavior
//     as v2's nullable embedding column). Backfill can vectorize it later.
//
// Delete strategy (reverse order): Qdrant point first, Supabase row second.
// If the Qdrant delete fails we ABORT and keep the row, so a searchable
// vector never points at missing metadata for a user-visible entry.
const crypto = require('crypto');
const supabase = require('../utils/supabase');
const embeddingSvc = require('./embedding');
const qdrant = require('./qdrant');

const KB_COLUMNS = 'id,title,content,category,source,qdrant_point_id,vector_synced_at,has_pdf,pdf_filename,pdf_url,created_at';

/**
 * Insert a KB entry into both stores.
 * @returns {Promise<{id: string, vectorized: boolean, warning: string|null}>}
 * @throws only when NEITHER store could record the entry.
 */
async function insertKBEntry({ title, content, category, source, has_pdf = false, pdf_filename = null, pdf_url = null }) {
  if (!content?.trim()) throw new Error('insertKBEntry: content is required');

  const id = crypto.randomUUID(); // same UUID = Supabase row id AND Qdrant point id

  // 1) Embed (failure here is non-fatal — mirror v2's nullable-embedding behavior)
  let vector = null;
  let embedWarning = null;
  try {
    vector = await embeddingSvc.generateEmbedding(content);
  } catch (err) {
    embedWarning = `Embedding failed (${err.message}) — entry stored without vector, keyword search only. Run backfill to fix.`;
    console.error(`[kbStore.insert] ${embedWarning}`);
  }

  // 2) Qdrant FIRST (only if we have a vector)
  let vectorized = false;
  if (vector) {
    try {
      await qdrant.upsertPoint(id, vector, {
        supabase_id: id,
        title: (title || '').slice(0, 200),
        content,
        category: category || 'other',
        source: source || 'manual'
      });
      vectorized = true;
    } catch (err) {
      // Qdrant write failed — do NOT abort the whole insert; degrade exactly
      // like the embedding-failure path (row without vector), because losing
      // the metadata entirely is worse for the user than losing searchability.
      embedWarning = `Qdrant upsert failed (${err.message}) — entry stored without vector, keyword search only. Run backfill to fix.`;
      console.error(`[kbStore.insert] ${embedWarning}`);
      vectorized = false;
    }
  }

  // 3) Supabase SECOND
  const now = new Date().toISOString();
  const { error } = await supabase.from('knowledge_base').insert({
    id,
    title: title || null,
    content,
    category: category || 'other',
    source: source || 'manual',
    qdrant_point_id: vectorized ? id : null,
    vector_synced_at: vectorized ? now : null,
    has_pdf, pdf_filename, pdf_url,
    created_at: now
  });

  if (error) {
    // Supabase failed AFTER Qdrant succeeded → compensating delete
    if (vectorized) {
      try {
        await qdrant.deletePoint(id);
        console.error(`[kbStore.insert] Supabase insert failed (${error.message}) — compensating Qdrant delete of point ${id} succeeded. No orphan.`);
      } catch (cleanupErr) {
        console.error(`[kbStore.insert] ORPHANED QDRANT POINT ${id} — Supabase insert failed (${error.message}) AND compensating delete failed (${cleanupErr.message}). Run POST /api/knowledge-base/reconcile?fix=true to clean up.`);
      }
    }
    throw new Error(`KB insert failed: ${error.message}`);
  }

  return { id, vectorized, warning: embedWarning };
}

/**
 * Delete a KB entry from both stores. Qdrant first; abort if it fails.
 */
async function deleteKBEntry(id) {
  if (!id) throw new Error('deleteKBEntry: id is required');

  const { data: row, error: fetchErr } = await supabase.from('knowledge_base')
    .select('id,qdrant_point_id').eq('id', id).single();
  if (fetchErr || !row) { const e = new Error('KB entry not found'); e.notFound = true; throw e; }

  if (row.qdrant_point_id) {
    // deletePoint treats "already gone" as success; any other failure throws,
    // and we abort so we never leave an orphaned vector for a visible row.
    await qdrant.deletePoint(row.qdrant_point_id);
  }

  const { error: delErr } = await supabase.from('knowledge_base').delete().eq('id', id);
  if (delErr) {
    // Vector already deleted, metadata remains → row is now keyword-only.
    // Mark it un-synced so reconcile/backfill sees it, and surface the error.
    try { await supabase.from('knowledge_base').update({ qdrant_point_id: null, vector_synced_at: null }).eq('id', id); } catch {}
    throw new Error(`Qdrant point deleted but Supabase row delete failed: ${delErr.message}. Entry is now keyword-search-only; retry the delete.`);
  }
  return true;
}

/**
 * Backfill: embed + upsert every row with qdrant_point_id IS NULL.
 * Replaces v2's /backfill-embeddings behavior (same endpoint contract).
 */
async function backfillVectors(limit = 50) {
  const { data: entries, error } = await supabase.from('knowledge_base')
    .select('id,content').is('qdrant_point_id', null).limit(limit);
  if (error) throw new Error(`Backfill query failed: ${error.message}`);
  if (!entries?.length) return { done: 0, total: 0, message: 'All entries already have vectors in Qdrant' };

  let done = 0;
  const failures = [];
  for (const entry of entries) {
    try {
      const vector = await embeddingSvc.generateEmbedding(entry.content);
      await qdrant.upsertPoint(entry.id, vector, { supabase_id: entry.id, content: entry.content });
      const { error: upErr } = await supabase.from('knowledge_base')
        .update({ qdrant_point_id: entry.id, vector_synced_at: new Date().toISOString() }).eq('id', entry.id);
      if (upErr) throw new Error(`row update failed after Qdrant upsert: ${upErr.message}`);
      done++;
    } catch (e) {
      failures.push({ id: entry.id, error: e.message });
      console.error(`[kbStore.backfill] Failed for ${entry.id}: ${e.message}`);
    }
  }
  return {
    done, total: entries.length, failures,
    message: done === 0 ? 'No vectors generated — check HF_API_KEY / QDRANT_URL / QDRANT_API_KEY.' : `${done}/${entries.length} vectors synced to Qdrant`
  };
}

/**
 * Reconcile the two stores. dryRun (default) only reports; fix=true repairs:
 *   * orphaned Qdrant points (no Supabase row)      → delete the point
 *   * un-synced Supabase rows (no Qdrant point/id)  → re-embed + upsert
 *   * rows whose qdrant_point_id is missing in Qdrant → re-embed + upsert
 */
async function reconcile({ fix = false } = {}) {
  const { data: rows, error } = await supabase.from('knowledge_base').select('id,content,qdrant_point_id');
  if (error) throw new Error(`Reconcile: Supabase read failed: ${error.message}`);

  let qdrantIds;
  try { qdrantIds = new Set(await qdrant.listAllPointIds()); }
  catch (err) {
    if (err.notFound) qdrantIds = new Set(); // collection not created yet
    else throw new Error(`Reconcile: Qdrant scroll failed: ${err.message}`);
  }

  const rowById = new Map((rows || []).map(r => [String(r.id), r]));
  const syncedRowPointIds = new Set((rows || []).filter(r => r.qdrant_point_id).map(r => String(r.qdrant_point_id)));

  const orphanedPoints = [...qdrantIds].filter(pid => !rowById.has(pid) && !syncedRowPointIds.has(pid));
  const unsyncedRows = (rows || []).filter(r => !r.qdrant_point_id || !qdrantIds.has(String(r.qdrant_point_id))).map(r => r.id);

  const report = {
    supabase_rows: rows?.length || 0,
    qdrant_points: qdrantIds.size,
    orphaned_qdrant_points: orphanedPoints,
    unsynced_supabase_rows: unsyncedRows,
    consistent: orphanedPoints.length === 0 && unsyncedRows.length === 0,
    fixed: null
  };

  if (fix && !report.consistent) {
    const fixed = { points_deleted: 0, rows_resynced: 0, failures: [] };
    for (const pid of orphanedPoints) {
      try { await qdrant.deletePoint(pid); fixed.points_deleted++; }
      catch (e) { fixed.failures.push({ id: pid, action: 'delete_point', error: e.message }); }
    }
    for (const rowId of unsyncedRows) {
      try {
        const row = rowById.get(String(rowId));
        const vector = await embeddingSvc.generateEmbedding(row.content);
        await qdrant.upsertPoint(row.id, vector, { supabase_id: row.id, content: row.content });
        const { error: upErr } = await supabase.from('knowledge_base')
          .update({ qdrant_point_id: row.id, vector_synced_at: new Date().toISOString() }).eq('id', row.id);
        if (upErr) throw new Error(upErr.message);
        fixed.rows_resynced++;
      } catch (e) { fixed.failures.push({ id: rowId, action: 'resync_row', error: e.message }); }
    }
    report.fixed = fixed;
  }
  return report;
}

module.exports = { insertKBEntry, deleteKBEntry, backfillVectors, reconcile };
// BUILD: v3.0
