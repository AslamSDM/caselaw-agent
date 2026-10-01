# Caselaw Agent — Plan

Natural-language search over the UK National Archives **Find Case Law** service
(https://caselaw.nationalarchives.gov.uk), with highlighted relevant paragraphs and quoted clauses,
a citation graph view, and a database explorer.

Example: user types *"jaguar battery leak"* → app finds the relevant judgments and shows exactly
which paragraphs (and quoted contract clauses) discuss it, highlighted inside the judgment — or says
clearly that nothing strongly matches.

---

## 1. Research findings

### TNA public API
Docs: https://nationalarchives.github.io/ds-find-caselaw-docs/public

| Endpoint | Purpose |
|---|---|
| `GET /atom.xml?query=&court=&party=&judge=&order=&page=&per_page=` | Search → Atom feed of matching cases |
| `GET /{uri}/data.xml` | Full judgment as Akoma Ntoso (LegalDocML) XML |

- **Rate limit:** 1,000 requests / rolling 5 min / IP → HTTP 429.
- **Change detection:** SHA256 content hash + `<FRBRdate>` per document.
- **Availability filter:** `minimum_availability=metadata|document|full-text`.

### XML structure (verified on `ewhc/ch/2016/52`, ~377 KB)
- 308 top-level `<paragraph eId="para_N">` elements → stable IDs for highlighting and deep links.
- 172 nested structures (subparagraphs, quoted blocks) → quoted contract clauses live *inside*
  paragraphs and need their own sub-element anchors.
- Text contains HTML entities (`&#8221;`) and curly quotes → must normalise before matching.
- References are marked up: `<ref uk:type="legislation" uk:canonical="1999 c. 29" href="…">` and
  `uk:type="case"` (68 case refs in this document) → citation graph edges for free.

### TNA search is literal keyword AND matching
- `jaguar battery` → 5 hits · `jaguar battery leak` → **0 hits** · `jaguar leak` → 5 unrelated hits.
- Raw user queries can't be passed straight through; they need expansion into keyword variants.

### Keyword hits are often false positives (verified)
The top `jaguar battery` hit, *London Taxi Co v Frazer-Nash* [2016] EWHC 52 (Ch), is a **trademark
dispute about the London taxi's shape**. Its matches are incidental:
- ¶83 "battery pack" (electric vehicle range limits)
- ¶100 "Jaguar cars of the 1960s" (design influence)
- ¶167, ¶172 cite *Jaguar Land Rover v OHIM* (a trademark case)

**Consequence:** the relevance step must be able to reject candidates, and the UI must support
"no strong matches".

### Web search: good vocabulary, bad results
Test query *"Jaguar battery leak UK High Court judgment"* returned mostly **US** litigation and a
Guernsey case (none on TNA), but useful terms: *I-Pace, high-voltage battery pack, thermal overload,
recall*.

**Consequence:** use the web for **vocabulary and citations only**. Every result shown must be
verified against TNA.

### Corpus size (checked 2026-09-29)
- TNA search page lists **96,377 documents**.
- 12 sampled recent `data.xml` files: 29–128 KB, avg ~64 KB; long judgments reach ~377 KB.
- Estimate: **~6–10 GB XML**, ~10–20 GB in Postgres with full-text indexes.
- Full download at 1,000 req / 5 min ≈ **8–10 hours** (one overnight run).
- Size is not the blocker; the licence is.

### Licensing ⚠️
- The Open Justice Licence permits reading, downloading and commercial reuse.
- It **does not permit computational analysis**: "programmatic searching in bulk across Find Case Law
  records to identify, extract or enrich contents". That needs a separate licence.
- Bulk ingest, embeddings and a full citation graph clearly need that licence.
- Live per-query lookup is closer to normal use. But citation extraction and LLM relevance
  scoring *may* still count as "extract or enrich", so this is not settled.
- **Action (Phase 0, now; reply needed before Phase 3):** email caselawlicence@nationalarchives.gov.uk describing the exact use.

---

## 2. Approach: live-first, no bulk download

Query TNA live per user request, cache every case fetched, and let the DB and graph grow from real
usage. Bulk ingest with embeddings is optional and **licence-gated** (Phase 6).

| Gain | Loss |
|---|---|
| No days-long ingest; MVP not blocked on licence | Recall bounded by TNA keyword search + our expansion |
| Always current | First query slower (network + LLM) |
| Small DB | Graph partial: outbound citations complete for cached cases, **inbound** ("who cites X") is not |

Inbound workaround: search TNA for the neutral-citation string, e.g. `"[2016] EWHC 52 (Ch)"`.

### Decision: live search now, bulk download only with licence
Bulk download is the better product (search by meaning, sub-second search, complete graph), but it needs
the computational-analysis licence. Build live search now and apply for the licence in parallel.

**Retrieval is swappable.** ~80% of the code (parser, schema, paragraph ranking, relevance check,
quote check, highlighting, UI, graph) is the same either way. Only candidate retrieval changes, behind
one interface:

```ts
interface CandidateSource {
  findCandidates(query: ExpandedQuery): Promise<Candidate[]>
}
// now:            LiveTnaSource    (atom.xml searches + RRF)
// if licensed:    LocalIndexSource (full-text + pgvector over the full archive)
//                 + LiveTnaSource as fallback for judgments newer than the last sync
```

### Pipeline vs agent
- **Search = deterministic pipeline** (section 3). Predictable cost and latency, easy to test.
- **Chat agent = follow-ups** on results: "what did the judge say on causation?", "cases citing this",
  "compare ¶12 with X". It uses the tools in section 6.

---

## 3. Search pipeline

```
user query: "jaguar battery leak"
│
├─ Wave 1 (immediate)
│   B. Claude query expansion → 5–8 keyword variants + filters (court, date, party, judge)
│      "jaguar battery", "I-Pace battery", "battery pack defect", "electric vehicle battery fire" …
│   C1. TNA searches for each variant (parallel, shared rate limiter)
│
├─ Wave 2 (joins when ready; ≤4s timeout, skipped if slow)
│   A. Web enrichment (Claude web_search, NO domain allowlist)
│      → terms            : accepted from any source
│      → case names / NCNs: accepted only from UK legal sources
│                           (judiciary.uk, bailii.org, lawgazette.co.uk, legalfutures.co.uk, …)
│      → drop non-UK jurisdictions (US, Guernsey, …)
│   C2. TNA searches: NCN exact → party= filter → new keyword variants
│
▼
D. Merge candidate lists with Reciprocal Rank Fusion (RRF)
   weights: NCN hit > party hit > keyword hit; bonus when multiple variants agree
   → top ~10 candidates (cap: ≤25 TNA requests per search in total)
▼
E. Fetch data.xml (cache-first) → parse → paragraphs + sub-elements + citations → DB
▼
F. Paragraph retrieval: Postgres full-text ranking (ts_rank) over each case's paragraphs
   using the original query + expanded terms → top 15–20 paragraphs per case
   (+1 neighbour each side for context). Ranked, not a regex filter,
   so paragraphs with different wording aren't silently dropped.
▼
G. Claude relevance pass per case (parallel, structured output):
   { case_uri, relevant: bool, score 0–1, summary,
     highlights: [{ element_id, kind, quote, reason }] }
   kind ∈ paragraph | quoted_clause | legislation_ref
   Instruction: incidental keyword mentions ≠ relevant.
▼
H. Verify each quote against source element text:
   decode entities → normalise whitespace and quotes → exact match, else near-exact match (≥0.9)
   → drop unverifiable highlights; drop case if none survive
▼
I. Apply relevance cutoff (score ≥ 0.5, to be tuned)
   → stream each case card as soon as it passes
   → if none pass: "No strong matches" + closest candidates, with why they fell short
```

### Latency and cost budgets (targets, tune with evals)
- First result card: < 8 s · full result set: < 20 s
- Cost per search: < $0.05 (use a small/fast model for expansion, a stronger one for relevance)
- TNA requests per search: ≤ 25

---

## 4. Highlighting (paragraphs and clauses)

- Judgments are numbered paragraphs. Contract clauses and statute text appear **quoted inside**
  paragraphs as nested elements.
- Highlight granularity = the smallest element containing the quote (sub-element `eId`, or the
  paragraph `eId` plus a character offset when the sub-element has no ID).
- Documents without `eId`s: fall back to paragraph order position.
- Rendering:
  - relevant paragraph → tinted background
  - exact quote → strong highlight (quoted clauses get a distinct "clause" badge)
  - legislation refs → chip linking to legislation.gov.uk
  - query terms → light underline
  - sidebar jump list: `¶47 · clause — "the Seller warrants the battery pack…" — why it matters`
- Every highlight deep-links to the same paragraph on the TNA site.

---

## 5. Data model (Postgres + Drizzle ORM, from day one)

Local: Postgres in Docker. Deploy: Neon. Same schema and same full-text search, so no SQLite→Postgres
migration later, and it's ready for pgvector.

```sql
cases(
  uri TEXT PRIMARY KEY,            -- ewhc/ch/2016/52
  ncn TEXT UNIQUE,                 -- [2016] EWHC 52 (Ch)
  name TEXT, court TEXT, date DATE,
  judges JSONB, parties JSONB,
  anonymised BOOLEAN,              -- initials / "A v B" / reporting restriction detected
  availability TEXT,               -- metadata | document | full-text
  content_hash TEXT, fetched_at TIMESTAMPTZ, checked_at TIMESTAMPTZ
)
elements(
  case_uri, element_id,            -- para_12 | para_12__subpara_b | …
  parent_id, kind,                 -- paragraph | subparagraph | quote_block
  ord INT, text TEXT, tsv TSVECTOR -- GIN index
)
citations(from_uri, from_element_id, type, to_ncn, to_uri NULL, to_legislation NULL, raw)
case_stubs(uri, ncn, name, court, date)   -- 1-hop metadata for cited cases (graph)
searches(id, query, expanded JSONB, web_hints JSONB, candidates JSONB, created_at)
results(search_id, case_uri, score, relevant, summary)
highlights(search_id, case_uri, element_id, kind, quote, reason, verified BOOLEAN)
rate_limit(window_start, count)   -- shared TNA limiter (or Upstash Redis)
```

### Storage budget (live search)
- Store metadata + paragraph text + full-text index only; **no raw XML** (re-fetch from TNA when needed).
- Rough estimate: ~100–150 KB per cached case → **Neon free tier (0.5 GB) holds ~3,000–5,000 cases**.
- Near the limit: evict least-recently-opened cases (highlights and search history kept).
- Hosted free Postgres tiers are ≤ 1 GB (Neon 0.5 GB, Supabase 500 MB, Aiven 1 GB), fine for this, not for bulk.
- Bulk (Phase 6) needs ~10–20 GB: local Docker, Oracle Cloud Always Free VM (200 GB disk, self-managed), or paid Neon/Supabase.

### Freshness
- Search results cached **24 h** (new judgments are added daily).
- Cached cases: on open, if `checked_at` > 7 days, compare the hash via TNA and re-parse if changed.

---

## 6. Agent tools (chat follow-ups; the search pipeline calls the same functions)

| Tool | Does |
|---|---|
| `search_cases(query, filters)` | Runs the full section 3 pipeline |
| `search_tna(params)` | Raw atom.xml call through the shared limiter |
| `fetch_case(uri)` | Cache-first fetch + parse |
| `find_in_case(uri, question)` | Full-text retrieval + relevance pass for one case |
| `get_citations(uri, direction, depth)` | Graph traversal (inbound uses the NCN text search workaround) |
| `web_enrich(query)` | Vocabulary + UK citations; disabled for anonymised cases |
| `query_db(sql)` | Read-only, allowlisted tables, row cap (Phase 3+) |

---

## 7. UI

- **Search view:** query box, live progress ("expanding… searching TNA (6)… reading 8 cases…"),
  case cards streaming in, "no strong matches" state.
- **Case card:** name, NCN, court + level (binding weight), date, 1-line summary, # highlights,
  score, "appealed?" flag when detectable.
- **Case viewer:** full judgment, highlights, jump-list sidebar, citations panel, TNA link,
  chat box for follow-ups scoped to this case.
- **Graph view (Cytoscape.js):** nodes = cases + Acts. Opening a case fetches 1-hop stubs for the
  cases it cites so the graph isn't sparse. Colour by court, size by in-degree within the cache,
  depth 1–2, click node → open case.
- **DB explorer:** cached cases with filters (court, date, judge, party), search history,
  re-run a past search.
- **Footer notice:** "Not legal advice. Source: The National Archives, Find Case Law."

---

## 8. Safety and legal guardrails

| Concern | Guardrail |
|---|---|
| Anonymised parties (family, criminal, immigration) | Detect anonymisation; **no web enrichment** for those cases; never show web-derived identities next to them |
| Hallucinated highlights | Quote verification (section 3, step H); unverifiable highlights never rendered |
| Non-existent / non-UK cases from web | Only TNA-verified cases shown; web cases listed separately as "mentioned on web, not in TNA" with the source link |
| Over-reliance | Footer notice, court level on cards, link to the original judgment |
| Licence | Email TNA before Phase 3; bulk features only with licence |

---

## 9. Tech stack

- **App:** Next.js (App Router) + TypeScript + shadcn/ui + Tailwind
- **LLM:** Claude via AI SDK (AI Gateway). Small model for expansion, stronger model for relevance.
  Verify the Claude `web_search` tool works through Gateway; otherwise call the Anthropic provider
  directly for that step only.
- **XML:** `fast-xml-parser` + `he` for entity decoding
- **DB:** Postgres (Docker locally → Neon) + Drizzle ORM + built-in full-text search (tsvector)
- **Rate limit:** shared counter in Postgres (or Upstash Redis on Vercel) + 429 exponential backoff
- **Graph:** Cytoscape.js
- **Tests:** Vitest (parser, quote verifier, RRF) + eval runner script

---

## 10. Phases

### Phase 0 — Groundwork (½ day)
- [ ] Email TNA licensing contact
- [ ] Build the **eval set**: 15–20 natural-language queries with known target cases and paragraphs,
      found manually on TNA, including **negative queries** (should return "no strong matches").
      Replace the Jaguar example with a verified real case, or keep it as a negative.
- [ ] Collect 5 sample XMLs across courts and eras (old/new, with/without eIds, anonymised)

### Phase 1 — Live search MVP
- [ ] Scaffold Next.js + Drizzle + Docker Postgres
- [ ] TNA client: search, fetch, shared rate limiter, 429 backoff
- [ ] Akoma Ntoso parser → metadata, elements (nested), citations, anonymisation detection
- [ ] Wave 1: expansion + TNA search + RRF merge
- [ ] Full-text paragraph retrieval + relevance pass + quote verification + cutoff
- [ ] Streaming results UI + case viewer with highlights
- [ ] Eval runner: recall@10, highlight precision, false-positive rate on negatives, latency, cost
- **Done when:** eval recall@10 ≥ 0.7, highlight precision ≥ 0.9, negatives return "no strong
  matches" ≥ 80% of the time, budgets from section 3 met.

### Phase 2 — Web enrichment
- [ ] Wave 2: `web_enrich` with the vocabulary/citation split, jurisdiction filter, timeout
- [ ] NCN and party searches from hints
- [ ] "Mentioned on web, not in TNA" section
- [ ] Anonymisation guard
- [ ] Measure the eval gain vs cost; decide always-on vs auto-trigger on low recall

### Phase 3 — Graph + DB explorer + chat (after TNA reply)
- [ ] Citation graph + 1-hop stubs
- [ ] Inbound citations via NCN search
- [ ] DB explorer + search history
- [ ] Follow-up chat agent with the section 6 tools

### Phase 4 — Deploy
- [ ] Neon free tier (0.5 GB) + Vercel, Upstash limiter if needed
- [ ] Cache eviction when storage nears the limit
- [ ] Auth + per-user rate limits + LLM spend cap (if public)
- [ ] Cost/latency logging per search

### Phase 5 — Quality iteration
- [ ] Tune the expansion prompt, RRF weights, cutoff, candidate count against evals
- [ ] Add "appealed / overturned" detection via inbound citations

### Phase 6 — Optional, licence-gated
- [ ] Bulk ingest per court (UKSC / EWCA first), nightly incremental sync via `order=-updated` + hash
- [ ] pgvector paragraph embeddings → hybrid (full-text + vector) search
- [ ] Full inbound citation graph, authority scores

---

## 11. Open questions

1. Licence: TNA's answer on live lookup + citation extraction + LLM relevance.
2. Audience: personal tool vs public app (drives auth and spend caps).
3. Court priorities (all, or focus e.g. EWHC / EWCA / UKSC).
4. Web enrichment: always on vs only on low recall (decide from Phase 2 evals).

## 12. Risks

| Risk | Mitigation |
|---|---|
| TNA keyword search misses relevant cases | Expansion + web vocabulary + NCN/party searches; hybrid search if licensed |
| Keyword false positives (see London Taxi case) | Relevance pass can reject; cutoff; negative evals |
| Rate limit under multi-user load / shared Vercel egress IPs | Shared limiter, ≤25 req/search, caching, backoff |
| Hallucinated highlights | Normalised quote verification |
| Large judgments blow token budget | Full-text top-K paragraphs only |
| De-anonymisation via web data | Anonymisation detection + enrichment disabled |
| Licensing | Email TNA before Phase 3; bulk features gated |
