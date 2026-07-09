# CQM v3 — Vector DB Edition (Qdrant)

Customer Query Management, rebuilt from v2 with the `knowledge_base` embedding
storage and similarity search moved from Supabase **pgvector** to **Qdrant
Cloud**. Everything else (scraper, enrichment, scheduler, all other routes,
frontend) is carried forward from v2 unchanged.

**v2 remains live and untouched** at `customerquerymanagement.pages.dev` /
`customerquerymanagement.onrender.com`. v3 is a parallel deployment: new GitHub
repo, new Render service, new Cloudflare Pages project, **new Supabase project**.

---

## What changed vs v2

| Area | v2 | v3 |
|---|---|---|
| Vector storage | `knowledge_base.embedding vector(384)` (pgvector) | Qdrant Cloud collection `cqm_kb` (384-dim, cosine) |
| Similarity search | `search_kb_vector()` SQL RPC | Qdrant `/points/search` REST |
| KB schema | `embedding` column | `qdrant_point_id` + `vector_synced_at` columns |
| KB writes | single Supabase insert | **two-store write**: Qdrant first, Supabase second (`kbStore.js`) |
| New service | — | `src/services/qdrant.js` (timeouts, retries, error classification, capacity checks) |
| New endpoint | — | `POST /api/knowledge-base/reconcile[?fix=true]` |
| Health | Supabase only | + Qdrant connectivity & free-tier capacity estimate |

Unchanged: `questions`, `agents`, `scrape_targets`, `scrape_logs`, `config`
tables; all scraping/enrichment/scheduling/posting logic; the entire frontend
contract (the "Rebuild KB Search Index" button now backfills into Qdrant via
the same `/backfill-embeddings` endpoint). All 9 documented v2 bug fixes are
preserved (see `CQM_v3_Handover_Brief.md` Section 4).

## Two-store consistency strategy (the learning content)

A KB entry now lives in two systems with **no cross-system transaction**:

```
insert:  embed → Qdrant upsert (point id = row UUID) → Supabase insert
delete:  Supabase fetch → Qdrant point delete → Supabase row delete
```

| Failure | Handling | Result |
|---|---|---|
| Embedding (HF) fails on insert | Row stored with `qdrant_point_id = NULL` | Keyword-search-only entry; fix via backfill |
| Qdrant upsert fails on insert | Same degradation, warning surfaced in API response | No orphaned vector possible |
| Supabase insert fails after Qdrant succeeded | **Compensating Qdrant delete** | No orphan; insert error returned |
| Compensating delete also fails | Loud `ORPHANED QDRANT POINT <id>` log | `reconcile?fix=true` cleans it up |
| Qdrant delete fails on entry delete | **Abort** — Supabase row kept | Never a vector pointing at deleted metadata |
| Supabase row delete fails after point deleted | Row marked unsynced, error returned | Retry delete; row is keyword-only meanwhile |

`POST /api/knowledge-base/reconcile` (dry run) reports orphaned Qdrant points
and unsynced Supabase rows; `?fix=true` deletes orphans and re-embeds/upserts
unsynced rows.

**Three timestamp concepts now exist — don't conflate them** (extends v2's
`date_asked` vs `created_at` rule): `created_at` (row created), `updated_at`
(row changed), `vector_synced_at` (embedding upserted to Qdrant).

Other v3-specific failure handling: every Qdrant call has a 15s timeout and
up to 3 attempts with exponential backoff for transient failures only
(network, timeout, 429, 5xx — never auth/4xx); upserts are blocked with an
explicit error when the estimated 1GB free-tier usage is exhausted, and
`/api/health` reports usage % with a warning above 80%.

## Setup (in order)

1. **Supabase (new project — do NOT reuse v2's)**
   - Create project → SQL Editor → run `db/schema.sql` in full.
   - Storage → create bucket `manuals`, Public = ON.
   - Copy Project URL and `service_role` key.
2. **Qdrant Cloud** — create a free 1GB cluster at cloud.qdrant.io, copy the
   cluster URL (keep the `:6333` port) and an API key. The collection is
   created automatically on first write.
3. **Backend (new Render web service)** — root dir `backend`, build
   `npm install`, start `npm start`. Set every var from `backend/.env.example`.
4. **Frontend (new Cloudflare Pages project)** — deploy `frontend/`. Then open
   the app → Configuration tab → set the API URL to your new Render URL
   (default in code is `https://cqm-v3-vectordb.onrender.com/api` — change it
   if your Render service name differs).
5. **Migrate v2's KB entries** (reads v2 read-only, re-embeds, writes v3):
   ```bash
   cd backend
   V2_SUPABASE_URL=https://<v2-project>.supabase.co \
   V2_SUPABASE_SERVICE_KEY=<v2-service-key> \
   npm run migrate:v2-kb
   ```
   Idempotent — safe to re-run after partial failures. It refuses to run if
   the v2 and v3 Supabase URLs are identical.
6. **Verify** — `GET /api/health` should show `db_connected: true`,
   `qdrant.connected: true`, and `POST /api/knowledge-base/reconcile` should
   report `consistent: true`.

## Testing

```bash
cd backend && npm install && npm test   # 52 automated tests
```

Covers the Qdrant client (retries, error classification, capacity limits,
pagination), both two-store failure modes, delete ordering, backfill,
reconcile, RAG fallback chain, route contracts, and health degradation.
External services are mocked; before each Git commit also run the manual
end-to-end pass in `TESTING.md` against real services (per project ground
rule 3 — full regression, not just changed paths).

## Repo layout

```
backend/                 Node/Express API (deploy root for Render)
  src/services/qdrant.js   NEW — Qdrant REST client
  src/services/kbStore.js  NEW — two-store write coordinator
  src/services/rag.js      CHANGED — search via Qdrant + keyword fallback
  src/services/enrichment.js CHANGED — approve→KB via kbStore
  src/routes/knowledgeBase.js CHANGED — kbStore + /reconcile
  src/routes/health.js     CHANGED — Qdrant status/capacity
  test/                    NEW — automated suite (node:test, no new deps)
frontend/                Single-page app (deploy root for Cloudflare Pages)
db/schema.sql            v3 Supabase schema (run once)
db/schema-v2-reference.sql  v2 schema, reference only
scripts/migrate-v2-kb.js One-time v2 → v3 KB migration
TESTING.md               Manual E2E checklist (run before every commit)
```

Design rules carried from v2, still enforced: no manual question/KB creation
via API (scraper + PDF-upload/approve-to-KB only); 70% confidence gate with
non-English always routed to review; permanent free tiers only.
