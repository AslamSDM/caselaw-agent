# Caselaw Agent

Natural-language search over UK judgments from The National Archives' **Find Case Law**, with
verified paragraph/clause highlights. See [`plan.md`](plan.md) for the design.

## Dev setup

Requires podman (with `podman compose`), Node 24, pnpm.

```bash
pnpm install
cp .env.example .env.local        # then set ANTHROPIC_API_KEY or AI_GATEWAY_API_KEY
pnpm services                     # Postgres (compose.yaml, :5433) + checks/starts local Firecrawl (:3002)
pnpm db:migrate
pnpm dev
```

- **Postgres**: `compose.yaml` (pgvector image) → `postgres://caselaw:caselaw@localhost:5433/caselaw`.
- **Firecrawl (dev)**: self-hosted in podman from `FIRECRAWL_LOCAL_DIR` (default `../firecrawl-local`),
  `FIRECRAWL_API_URL=http://localhost:3002`, no key. Search goes through its SearXNG container.
- `pnpm eval` — end-to-end quality evals (needs an LLM key); see [`evals/README.md`](evals/README.md).
- `pnpm test` — parser, quote verification, fusion, NCN unit tests (fixtures in `test/fixtures`).
- `pnpm tsx scripts/smoke.ts` — live TNA + DB + Firecrawl smoke test (no LLM).

## Local index (bulk RAG)

⚠️ Bulk ingest + embeddings need TNA's computational-analysis licence (plan.md §1).

```bash
pnpm ingest [--from 2025-10-01 --to 2026-10-01] [--exclude-court immigration]  # TNA → cases/elements
pnpm embed [--watch]                 # chunk + embed new cases locally (bge-small, no API cost)
pnpm local-search "damp and mould"   # query the local index directly (no LLM, no TNA)
```

Both scripts are resumable. Once any chunks exist, every search also queries the local index
(pgvector semantic + Postgres full-text) and fuses those lists with the live TNA ones; paragraph
retrieval inside each case blends semantic hits with keyword hits. `LOCAL_INDEX=off` disables it.

## Production

| Setting | Value |
|---|---|
| `DATABASE_URL` | Neon connection string, then `pnpm db:migrate` |
| `FIRECRAWL_API_URL` | unset (SDK defaults to `https://api.firecrawl.dev`) |
| `FIRECRAWL_API_KEY` | Firecrawl cloud key (`fc-…`) |
| `AI_GATEWAY_API_KEY` / OIDC | Vercel AI Gateway (or `ANTHROPIC_API_KEY`) |

Web enrichment is optional: `WEB_ENRICH_ENABLED=false`, or no Firecrawl config, skips it.

## Layout

```
src/lib/tna/        client (atom search, data.xml, 24h search cache), shared Postgres rate limiter,
                    Akoma Ntoso parser, NCN helpers
src/lib/web/        Firecrawl client (same code path for self-hosted and cloud)
src/lib/search/     expand → TNA searches (+ web hints, + local index) → fusion → retrieve (FTS + vectors)
                    → relevance (LLM) → verify quotes → cutoff; pipeline.ts streams events
src/lib/cases/      cache-first case store
src/lib/embed.ts    local embeddings (transformers.js) + paragraph chunking
src/app/api/search  NDJSON event stream
src/app/case/[...uri]  judgment viewer with highlights, jump list, citations
src/app/cases       cached-case explorer + search history
src/lib/areas.ts    area-of-law taxonomy + court-based guess
evals/              dataset, metrics, LLM judge; runner in scripts/eval.ts
```

## Search notes

- TNA keyword searches use `order=relevance` (undocumented; what TNA's own "Most relevant" sort
  uses). Falls back to date order if TNA rejects it. Up to 25 hits per keyword variant are fused.
- **Area of law**: each case gets up to 3 areas — a guess from the court, then a classification
  from the relevance pass. Users can restrict a search to areas (cases outside are rejected with a
  reason) or filter results by area afterwards.
- **Date range**: inferred from the question ("since 2020", "in 2019", "recent" = last 5 years),
  or set with the from/to inputs (YYYY, YYYY-MM, YYYY-MM-DD), which override it. Applied as TNA's
  `from_date_*`/`to_date_*` filter and enforced on every candidate (web citations bypass TNA's
  filter), before any LLM call. The UI shows the applied range and where it came from.

Not legal advice. Source: The National Archives, Find Case Law (Open Justice Licence — note the
computational-analysis restriction discussed in `plan.md` §1).
