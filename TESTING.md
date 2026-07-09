# CQM v3 — Manual End-to-End Test Checklist

Run the FULL list against real services before every Git commit (ground
rule 3: full regression, positive and negative, not just changed paths).
Automated suite first: `cd backend && npm test` → must be 52/52.

## 0. Environment
- [ ] `GET /api/health` → `version: 3.0.0`, `db_connected: true`, `qdrant.connected: true`, all `*_configured: true`
- [ ] `qdrant_capacity.estimated_usage_pct` present and sane

## 1. Migration (first deploy only)
- [ ] `npm run migrate:v2-kb` completes; summary shows Migrated = v2 count, Failed = 0
- [ ] Re-run the script → everything reported as SKIP (idempotency)
- [ ] `POST /api/knowledge-base/reconcile` → `consistent: true`
- [ ] v2 app still fully functional afterwards (read-only guarantee)

## 2. Knowledge Base (changed area — test hardest)
- [ ] KB tab lists migrated entries; search / category / source / date filters work
- [ ] Upload a text PDF → chunks stored; response shows `chunks_without_vector: 0`; PDF preview opens (memory cache) and again after backend restart (storage path)
- [ ] Upload a scanned/corrupt PDF → clean 400 error, nothing stored
- [ ] Upload with wrong QDRANT_API_KEY set (negative test) → chunks stored with warning, entries flagged unsynced; restore key → "Rebuild KB Search Index" backfills them; reconcile → consistent
- [ ] Delete a KB entry → gone from list; reconcile → consistent (no orphaned point)
- [ ] Confirm there is still NO manual KB-create route (`POST /api/knowledge-base` → 404)

## 3. Scrape → Enrich → RAG (regression)
- [ ] Add a BestBuy scrape target; template download works
- [ ] `POST /api/scrape/now` → questions appear; scrape log row written; multi-page product pulls unanswered questions from page 2+ (v2 bug #9)
- [ ] Duplicate run → no duplicate questions (content_hash dedup)
- [ ] Questions get category/sentiment/language and an assigned agent
- [ ] A clear-answer question (covered by KB) auto-approves at ≥70% confidence and lands in Answered
- [ ] Auto-approved answer appears as a new KB entry (approve→KB flow) and is vector-synced (reconcile → consistent)
- [ ] A vague/foreign-language question routes to Review with a review_reason
- [ ] Negative: temporarily break QDRANT_URL → questions still get answered via keyword fallback (degraded, logged, never silent); restore

## 4. Review queue / Answered
- [ ] Approve with edited answer (+ "add to KB" checked) → status answered, KB entry created
- [ ] Reassign a question to another agent
- [ ] Questions date filter uses `date_asked`; dashboard date filter uses `created_at` (v2 rule #5 — verify they differ)

## 5. Dashboard
- [ ] Stats load; retailer/date filters work; role switch (agent vs manager/admin) shows/hides the extra KPIs
- [ ] Date preset dropdown works repeatedly without wiping open state (v2 bugs #6/#7)

## 6. Scheduler, config, post-answers
- [ ] Change scrape interval/engine in Configuration → scheduler restarts with new interval (check logs)
- [ ] Interval below 5 minutes is rejected/clamped
- [ ] Post-answers toggle + posting config endpoints respond
- [ ] CSV/XLSX export of questions downloads

## 7. Failure-mode drills (v3 learning content — do at least once per release)
- [ ] Wrong QDRANT_API_KEY → health shows qdrant connected:false with actionable auth message; app still serves all non-vector features
- [ ] Wrong SUPABASE_SERVICE_KEY → errors are explicit HTTP 500s with messages, never blank successes
- [ ] Manually create an orphan (insert a point via Qdrant console) → reconcile detects it; `?fix=true` removes it

Commit only when every box is checked. Log any new failure discovered here
before fixing it, so the checklist grows with the project.
