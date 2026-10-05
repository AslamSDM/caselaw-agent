# Caselaw Agent — demo script (~12 min)

## 0. Before the call (5 min)

```bash
cd ~/tempy/caselaw-agent
pnpm services          # starts podman machine, Postgres :5433, Firecrawl :3002
ollama ps              # Ollama must be running (nomic-embed-text embeddings; gemma4 fallback)
pnpm dev               # http://localhost:3000
```

- Run every demo query once beforehand. Query expansion is cached for 24 h and judgments are
  stored in Postgres, so the second run is noticeably faster.
- Open these tabs: `/`, `/cases`, `/chats`.
- Models: `.env.local` uses `openai/gpt-6-luna` for both tiers (reasoning off), plus
  `LLM_FALLBACK_MODEL=ollama/gemma4-16k:12b-mlx` (local) and `typesafe/jev-1.13` as the pre-screen.
  Each search costs about $0.005.

## 1. Opening pitch (1 min)

> "It's natural-language search over UK judgments from the National Archives' Find Case Law.
> You describe a situation in plain English. It finds the judgments and highlights the exact
> paragraphs that answer it. Every quote is checked against the judgment text. And it says
> 'no strong matches' instead of padding the list with noise."

> "Three facts drove the design:
> 1. TNA's search is literal keyword AND matching. 'jaguar battery' gets 5 hits; 'jaguar battery leak' gets zero.
> 2. Keyword hits are mostly false positives.
> 3. The licence forbids bulk computational analysis without a separate licence.
> So the app searches TNA live per query, with an LLM doing expansion and relevance judging on top."

## 2. Demo flow

### A. Classic positive: streaming + verified highlights (2 min)
**Query:** `employer liable when a disgruntled employee leaked staff payroll data online`

Point at:
- **Expanded variants** chips: 7 keyword queries generated from one sentence ("payroll data" employee, vicarious liability employee data, …). *"This is what makes a literal-AND search engine usable."*
- **Live status**: Searching TNA → local index hits → "Reading top 6" → "Reading 4 more" (web hints merged) → "Following citations".
- **Cards stream in** as each case passes, not at the end. All three Morrisons instances appear: QB 2017, CA 2018, UKSC 2020.
- **Rejected list with reasons**: "No passage is about the question (reranker 0.025)", "Pre-screen: tangential 75%". *"Every rejection is explained, and the cheap filters run before the expensive ones."*
- Open the UKSC card → **judgment viewer**: highlighted paragraphs, the jump list, press `/` for find-in-judgment.

### B. Negative: honesty (1 min)
**Query:** `jaguar battery leak`
- Ends with **"No strong matches."** All 10 candidates are rejected, mostly by the local cross-encoder, with **no LLM calls** (first result: none, ~16 s, ~5k tokens).
- *"The London Taxi trade-mark case shows up here because it mentions a battery pack and 1960s Jaguars. Keep it in mind for the next query."*

### C. Same case, now the right answer + area filter (1 min)
**Query:** `shape of a taxi as a trade mark`, with **Area = IP** selected
- Both *London Taxi* judgments pass: EWHC 2016 and EWCA 2017.
- Rejected: KitKat shape (Nestlé v Cadbury), cheese shape (Bongrain): "same doctrine, different facts". A case without an IP classification is rejected as "outside selected areas".
- *"Same document: a false positive for one question, the answer to another. Relevance has to be judged against the question, which keyword scores can't do."*

### D. Date inference (1 min)
**Query:** `decisions since 2020 on whether app-based drivers count as workers`
- Shows **"2020-01-01 → today · from the query: 'Since 2020'"**. The from/to inputs override it.
- Results: IWGB v CAC (Deliveroo, UKSC 2023), Johnson v Transopco, Patel v DPD, BCA Logistics.
- Citation expansion tries Autoclenz-era authorities and **rejects them as outside the date range** before any LLM call.

### E. Follow-up chat agent (2 min)
On the Morrisons results (search A), in the chat panel:
**Ask:** `Why did the Supreme Court reverse the Court of Appeal in Morrisons? Quote the key paragraph.`
- The agent calls `read_case` on uksc/2020/12 and ewca/civ/2018/2339, then quotes **¶31** verbatim.
- **Hover** a citation: paragraph preview. **Click** it: jumps to the paragraph and flashes it.
- *"The browser checks every quote word-for-word against the paragraphs the agent actually read, and fixes wrong anchors by paragraph number."*
- Optional: `Which later cases cite Morrisons?` → `get_citations` tool. Caveat: this only covers locally stored judgments.

### F. Citation graph (30 s)
Open `/graph?search=<id>` (link on results) or `/graph?case=uksc/2020/12`.
- Edges come for free from `<ref uk:type="case">` markup in the Akoma Ntoso XML.

### G. Evals (1 min), `evals/runs/*.md`
> "Every change runs against a labelled eval set: 27 queries, 4 of them negatives, described
> by situation, never by case name. A missed target is attributed to a stage: not retrieved,
> not read, or rejected. Last full run: must-find recall@10 100%, highlight precision 93%,
> negatives 100%, about 2.6 TNA requests per search. Latency gates fail: first result p50 is 10.9 s
> against an 8 s target, and the strong judge is the bottleneck."

## 3. Architecture walkthrough (3 min; draw this)

```
question
  │
  ├─ embed question (Ollama nomic-embed-text, local)                    ┐
  ├─ expand (fast LLM, cached 24h) → variants, terms, filters, dates    ├ all start at t0
  ├─ web enrichment: Firecrawl "<question> case law UK judgment"        ┘  (background; waited on
  │    → fast LLM → terms / new variants / UK citations                     ≤12 s once wave 1 reads)
  ▼ after expansion:
  ├─ local index: pgvector (question + 2 variants) + Postgres FTS
  ├─ TNA atom search × each variant (4 at a time, ≤25 requests/search)
  ▼
wave 1: weighted reciprocal-rank fusion → start reading top 6 now
  ▼ when web hints arrive:
  citation list + party searches + ≤3 new keyword searches → re-fuse → fill to 10
  ▼  per case, 4 workers, XML prefetched:
fetch + parse Akoma Ntoso (cache-first) → paragraphs / quoted clauses / citations in Postgres
  ▼
paragraph retrieval: FTS ∪ semantic → cross-encoder rerank (bge-reranker, local)
  │      best score < 0.05 → reject, no LLM
  ▼
pre-screen (Jev decisions model, batched, fails open) → confidently tangential → reject
  ▼
strong LLM judge (forced tool call → typed JSON): relevant, score, summary, areas, quotes
  ▼
quote verification (exact after normalising, else ≥0.9 token-LCS; the highlight text is sliced from the source)
  ▼
cutoff → stream card (NDJSON)  ·  then citation expansion: cases cited by ≥2 results
```

Key lines:
- **Pipeline for search, agent for chat**: bounded cost (≤25 TNA requests), predictable latency, testable stages.
- **Funnel from cheap to expensive**: date/area checks (free) → local cross-encoder (no API cost) → batched cheap classifier → strong model.
- **The LLM proposes, deterministic code verifies**: hallucinated quotes can't reach the UI.
- **Retrieval is swappable**: live TNA today; the local index (licence-gated bulk ingest) just adds more lists to the same fusion.
- **Postgres does everything**: FTS (generated tsvector + GIN), vectors (pgvector HNSW), the shared rate limiter (10-second buckets, atomic upsert), the cache, and search/chat history.
- **Provider-agnostic LLM layer**: OpenRouter, Anthropic, AI Gateway, or `ollama/<model>` locally. Structured output uses a forced tool call because some models ignore JSON-schema mode.

## 4. Honest weak spots (say them before they ask)
- **Latency**: 15–45 s per search. The judge dominates. Next steps: stream the judge, use a smaller judge for clear cases, run web enrichment only when recall is low.
- **Model swaps regress quality.** Switching to DeepSeek without reasoning made `£85 car park overstay charge` reject the UKSC *ParkingEye/Cavendish* judgment: the retrieved paragraphs came from the conjoined *Makdessi* appeal. And the 0.05 reranker floor dropped *Uber v Aslam* on one phrasing. *"That's exactly why the eval suite exists. The cutoffs were tuned per model, and I'd re-run the eval sweep before trusting a new model."*
- **"Cited by" is partial**: it only covers judgments stored locally.
- **Licence**: not settled whether LLM relevance scoring counts as "enrich". Bulk features are gated behind it.
- **Self-graded evals**: the last run used the same model as judge. `EVAL_JUDGE_MODEL` exists for an independent judge.

## 5. Backup queries
| Query | Expect |
|---|---|
| `bakery refused to make a cake iced with a slogan supporting same-sex marriage` | Lee v Ashers (UKSC 2018) |
| `was the prime minister's advice to suspend parliament for five weeks in 2019 lawful` | Miller/Cherry (UKSC 2019) |
| `zoo liable after an escaped penguin damaged a neighbour's car` | no strong matches |
| `UK parent company duty of care for toxic discharges from its foreign subsidiary's copper mine` | Vedanta v Lungowe |

If a search hangs: check `ollama ps` and Postgres (`pnpm services`), and look for `[llm] … retrying with` in the dev server log.
