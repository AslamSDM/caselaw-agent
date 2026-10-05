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

Embeddings come from a local [Ollama](https://ollama.com) server (`ollama pull nomic-embed-text`,
768-d, no API cost). One vector per top-level paragraph, stored on `elements.embedding`.

```bash
pnpm ingest [--from 2025-10-01 --to 2026-10-01] [--exclude-court immigration]  # TNA → cases/elements
pnpm embed:backfill [--limit 500] [--court UKSC] [--since 2020-01-01]           # embed whole cases
pnpm local-search "damp and mould"   # query the local index directly (no LLM, no TNA)
```

Both scripts are resumable. Searches also embed on demand: each candidate case gets its best
keyword paragraphs embedded (or the whole case when keywords barely match), cached for next time.
Once any embeddings exist, every search also queries the local index (pgvector semantic over the
question + top expansion variants, and Postgres full-text) and fuses those lists with the live TNA
ones. The semantic list's fusion weight scales with index coverage, so a partly embedded cache
does not crowd out TNA. `LOCAL_INDEX=off` disables local retrieval, `EMBED_ENABLED=false` disables
embeddings entirely (keyword-only ranking).

## Reranker, pre-screen, citations, chat

- **Reranker**: each candidate's keyword + semantic paragraphs are re-scored by a local
  cross-encoder (bge-reranker-base via transformers.js, ~280 MB downloaded on first use). Cases
  with no paragraph above `RERANK_MIN` are rejected without LLM calls.
- **Pre-screen** (`JUDGE_GATE_MODEL=typesafe/jev-1.13`): a decisions model on OpenRouter labels each
  case on point / tangential / unrelated, several cases per request. Confident "not on point" skips
  the strong judge. Skipped when the reranker is already sure (`RERANK_TRUST`).
- **Citation expansion**: after the first round, judgments cited by at least `CITE_MIN` passing
  results are read too (labelled "cited by N of the results"). Privy Council and House of Lords
  judgments are not on Find Case Law and are skipped.
- **Follow-up chat** (`/api/chat`, panel under results and on each judgment): an AI SDK tool loop with
  `read_case`, `get_citations` and `search_cases`; answers quote paragraphs with links into the viewer.
  In the browser every citation is matched to a paragraph the agent read (wrong anchors corrected by
  ¶ number), every quote is checked word-for-word, hover previews the paragraph (`/api/paragraph`)
  and click jumps to it and flashes it. Conversations are saved to the `chats` table after each
  answer; History in the panel and `/chats` list them.
- **Citation graph** (`/graph?case=<uri>` or `/graph?search=<id>`): Cytoscape view of what a judgment
  cites, which stored judgments cite it and its statutes, or of a search's results and the
  authorities they share. Counts only cover locally stored judgments.
- **Find in judgment**: the bar above each judgment (press `/`) highlights every match with the CSS
  Custom Highlight API, steps through them, and lists matching paragraphs.

A fuller explanation with diagrams: https://claude.ai/artifact/4tfYtJub1kEdSofrCLkS11

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
src/lib/embed.ts    Ollama paragraph embeddings (on demand + backfill)
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
