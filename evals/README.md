# Evals

`pnpm eval` runs every query in `dataset.ts` through the real search pipeline, grades the output,
and writes `runs/<timestamp>.json` (full record) + `.md` (report), with deltas against the previous run.
Exit code 1 when a gate fails, so it can run in CI.

## What is graded

| Metric | How | Why |
|---|---|---|
| Recall@10 (must-find) | grade-3 labelled targets among results | primary quality number |
| Candidate recall | grade-3 targets among fused candidates | isolates retrieval (expansion + TNA + fusion) from the relevance pass |
| Miss stage | not-retrieved / not-read / rejected (+ reason) | tells you which stage to fix |
| MRR, nDCG@10 | ranks; grades from labels, else the judge | ordering quality |
| Result precision | results graded ≥ 2 / graded results | false positives |
| Highlight precision | judge: does each quoted passage help answer the question (first 3 per result) | quotes are verified verbatim already; this checks they matter |
| Negatives | queries with no known authority must return nothing | "no strong matches" honesty |
| Date inference | inferred range matches the query's expected range; queries without one must infer none | catches invented date filters |
| Date compliance | results inside the expected range | the range is actually enforced |
| Area accuracy | predicted areas of the must-find case ∩ expected | area-of-law classifier |
| Latency, TNA requests, tokens | pipeline stats | budgets from plan.md §3 |

Gates (plan.md Phase 1): recall@10 ≥ 70%, highlight precision ≥ 90%, negatives ≥ 80%,
first result p50 < 8 s, total p50 < 20 s, ≤ 25 TNA requests/search.

## Labels vs judge

- **Labels** (`dataset.ts`) are ground truth, checked against TNA: grade 3 = must find, 2 = relevant.
  Queries describe the situation, never the case name.
- **Judge** (`judge.ts`) grades unlabelled returned cases 0–3 and every highlight. It gets its own
  evidence (full-text match on the original query words), not the pipeline's paragraphs, and uses
  `EVAL_JUDGE_MODEL` if set (use a different model from `LLM_STRONG_MODEL` to reduce self-agreement).
  Verdicts are cached in `.cache/judge.json`, so `--regrade` of a saved run is cheap and stable.
- Spot-check the "Returned cases" section of each report. When the judge is wrong, add a label.

## Usage

```bash
pnpm eval                                   # everything
pnpm eval --only prorogation,ashers-cake    # subset
pnpm eval --tag negative
pnpm eval --no-judge                        # labels only
pnpm eval --regrade evals/runs/<file>.json  # re-score without searching
pnpm eval:sweep [run.json]                  # replay a run at stricter relevance cutoffs
EVAL_JUDGE_MODEL=qwen/qwen3.8-27b:free pnpm eval --regrade <run.json>   # independent judge
```

| Env | Effect |
|---|---|
| `EVAL_JUDGE_MODEL` | judge model id (default: the strong pipeline model, which grades its own work) |
| `EVAL_JUDGE_CONCURRENCY` / `EVAL_JUDGE_RETRIES` | for rate-limited free models (defaults 4 / 6) |
| `EVAL_JUDGE_REASONING`, `LLM_FAST_REASONING`, `LLM_STRONG_REASONING` | OpenRouter reasoning effort (`none`…`xhigh`) |
| `RELEVANCE_CUTOFF` | pipeline relevance threshold; tune per model with `eval:sweep` |

LLM output varies between runs. Compare runs on the same commit before trusting small deltas,
and grow the dataset (target 40+ queries, ≥ 25% negatives) before tuning thresholds.
