/**
 * Eval runner.
 *
 *   pnpm eval                       run all queries, judge, score, compare with the previous run
 *   pnpm eval --only uber-worker-status,prorogation
 *   pnpm eval --tag negative
 *   pnpm eval --no-judge            skip the LLM judge (label-only metrics)
 *   pnpm eval --regrade evals/runs/<file>.json   re-score a saved run (judge fills gaps) without searching
 *   pnpm eval --concurrency 3 --no-gate
 *
 * Writes evals/runs/<timestamp>.json (full record) and .md (report). Exit code 1 if a gate fails.
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    only: { type: "string" },
    tag: { type: "string" },
    "no-judge": { type: "boolean", default: false },
    regrade: { type: "string" },
    concurrency: { type: "string", default: "2" },
    "no-gate": { type: "boolean", default: false },
  },
});

const RUNS_DIR = "evals/runs";

// captured at startup: the code that runs is the code loaded now, not whatever HEAD is when the
// report is written (another session may commit in between)
const STARTED = {
  at: new Date().toISOString(),
  git: safeSync(() => execSync("git rev-parse --short HEAD").toString().trim()),
  dirty: safeSync(() => execSync("git status --porcelain").toString().trim().length > 0),
};

function safeSync<T>(f: () => T): T | null {
  try {
    return f();
  } catch {
    return null;
  }
}

async function main() {
  const { DATASET } = await import("../evals/dataset");
  const { scoreQuery, summarize, checkGates } = await import("../evals/metrics");
  type QueryRun = import("../evals/metrics").QueryRun;
  const { judgeResult, saveJudgeCache } = await import("../evals/judge");
  const { llmConfigured, provider } = await import("../src/lib/llm");
  await preflight();
  if (!llmConfigured()) throw new Error("Set OPENROUTER_API_KEY, ANTHROPIC_API_KEY or AI_GATEWAY_API_KEY in .env.local");

  let cases = DATASET;
  if (args.only) {
    const ids = new Set(args.only.split(","));
    cases = cases.filter((c) => ids.has(c.id));
  }
  if (args.tag) cases = cases.filter((c) => c.tags?.includes(args.tag!));
  if (!cases.length) throw new Error("no eval cases selected");

  let runs: QueryRun[];
  if (args.regrade) {
    const saved = JSON.parse(readFileSync(args.regrade, "utf8"));
    const wanted = new Set(cases.map((c) => c.id));
    runs = (saved.runs as QueryRun[]).filter((r) => wanted.has(r.id));
    console.log(`Re-grading ${runs.length} saved runs from ${args.regrade}`);
  } else {
    runs = await runAll(cases, Number(args.concurrency));
  }

  // ---- judge ---------------------------------------------------------------------------------
  if (!args["no-judge"]) {
    const jobs = runs.flatMap((r) => r.results.slice(0, 10).map((res) => ({ r, res })));
    process.stdout.write(`Judging ${jobs.length} results `);
    await mapLimit(jobs, Number(process.env.EVAL_JUDGE_CONCURRENCY ?? 4), async ({ r, res }) => {
      try {
        const v = await judgeResult(r.query, res);
        if (v) r.judge[res.uri] = v;
        process.stdout.write(".");
      } catch (err) {
        process.stdout.write("x");
        console.error(`\n  judge failed for ${r.id} ${res.uri}:`, err instanceof Error ? err.message : err);
      }
    });
    saveJudgeCache();
    console.log();
  }

  // ---- score + report ------------------------------------------------------------------------
  const byId = new Map(cases.map((c) => [c.id, c]));
  const scores = runs.map((r) => scoreQuery(byId.get(r.id)!, r));
  const summary = summarize(scores, runs);
  const gates = checkGates(summary);
  const previous = latestRun();

  const stamp = STARTED.at.replace(/[:.]/g, "-").slice(0, 19);
  const meta = {
    startedAt: STARTED.at,
    finishedAt: new Date().toISOString(),
    git: STARTED.git,
    dirty: STARTED.dirty,
    models: {
      fast: process.env.LLM_FAST_MODEL ?? "default",
      strong: process.env.LLM_STRONG_MODEL ?? "default",
      judge: process.env.EVAL_JUDGE_MODEL ?? `${process.env.LLM_STRONG_MODEL ?? "default"} (self)`,
      reasoning: {
        fast: process.env.LLM_FAST_REASONING ?? "default",
        strong: process.env.LLM_STRONG_REASONING ?? "default",
        judge: process.env.EVAL_JUDGE_REASONING ?? "default",
      },
      provider: provider(),
    },
    config: {
      cutoff: process.env.RELEVANCE_CUTOFF ?? "0.5",
      maxCandidates: process.env.MAX_CANDIDATES ?? "10",
      perVariant: process.env.TNA_PER_VARIANT ?? "25",
      web: process.env.WEB_ENRICH_ENABLED ?? "true",
    },
    regradeOf: args.regrade ?? null,
    selection: { only: args.only ?? null, tag: args.tag ?? null },
  };
  mkdirSync(RUNS_DIR, { recursive: true });
  const base = `${RUNS_DIR}/${stamp}`;
  writeFileSync(`${base}.json`, JSON.stringify({ meta, summary, gates, scores, runs }, null, 1));
  const report = renderReport(meta, summary, gates, scores, runs, cases, previous?.summary ?? null);
  writeFileSync(`${base}.md`, report);
  console.log(report);
  console.log(`\nSaved ${base}.json / .md`);

  if (!args["no-gate"] && gates.some((g) => !g.pass)) process.exitCode = 1;
  process.exit();

  // ------------------------------------------------------------------------------------------
  async function runAll(selected: typeof DATASET, concurrency: number): Promise<QueryRun[]> {
    const { runSearch } = await import("../src/lib/search/pipeline");
    const { getCachedCase } = await import("../src/lib/cases/store");
    const out: QueryRun[] = [];
    await mapLimit(selected, concurrency, async (c) => {
      const run: QueryRun = { id: c.id, kind: c.kind, query: c.query, candidates: [], results: [], rejected: [], dates: null, dateSource: "none", targetAreas: {}, stats: null, judge: {} };
      const t0 = Date.now();
      try {
        for await (const e of runSearch(c.query, { areas: c.filterAreas, source: "eval" })) {
          if (e.type === "expanded") {
            run.dates = e.dates;
            run.dateSource = e.dateSource;
          } else if (e.type === "candidates") run.candidates = e.candidates.map((x) => x.uri);
          else if (e.type === "result")
            run.results.push({
              uri: e.result.uri,
              name: e.result.name,
              date: e.result.date,
              score: e.result.score,
              areas: e.result.areas,
              highlights: e.result.highlights.map((h) => ({ elementId: h.elementId, kind: h.kind, quote: h.quote })),
            });
          else if (e.type === "rejected") run.rejected.push({ uri: e.uri, name: e.name, score: e.score, reason: e.reason });
          else if (e.type === "done") run.stats = e.stats;
          else if (e.type === "error") run.error = e.message;
        }
      } catch (err) {
        run.error = err instanceof Error ? err.message : String(err);
      }
      run.results.sort((a, b) => b.score - a.score);
      for (const t of c.targets) run.targetAreas[t.uri] = (await getCachedCase(t.uri))?.areas ?? [];
      out.push(run);
      const hit = run.error ? "✗ error" : c.kind === "negative" ? (run.results.length ? "✗ returned results" : "✓ none") : `${c.targets.filter((t) => t.grade === 3 && run.results.some((r) => r.uri === t.uri)).length}/${c.targets.filter((t) => t.grade === 3).length} targets`;
      console.log(`  ${c.id.padEnd(28)} ${String(run.results.length).padStart(2)} results  ${hit.padEnd(18)} ${((Date.now() - t0) / 1000).toFixed(1)}s${run.error ? `  ERROR ${run.error}` : ""}`);
    });
    const order = new Map(selected.map((c, i) => [c.id, i]));
    return out.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  }
}

// ---- helpers ---------------------------------------------------------------------------------

/** Fail fast on dead infrastructure instead of recording junk runs. */
async function preflight() {
  const { db } = await import("../src/db");
  const { sql } = await import("drizzle-orm");
  try {
    await db.execute(sql`select 1`);
  } catch (err) {
    throw new Error(`Postgres unreachable (${err instanceof Error ? err.message : err}); run pnpm services`);
  }
  const fc = process.env.FIRECRAWL_API_URL;
  if (fc && process.env.WEB_ENRICH_ENABLED !== "false") {
    const ok = await fetch(fc, { signal: AbortSignal.timeout(3000) }).then(() => true, () => false);
    if (!ok) console.warn(`! Firecrawl not reachable at ${fc}: web enrichment will be skipped, results not comparable`);
  }
}

function latestRun(): { summary: import("../evals/metrics").Summary } | null {
  if (!existsSync(RUNS_DIR)) return null;
  const files = readdirSync(RUNS_DIR).filter((f) => f.endsWith(".json")).sort();
  const last = files.at(-1);
  return last ? JSON.parse(readFileSync(`${RUNS_DIR}/${last}`, "utf8")) : null;
}

async function mapLimit<T>(items: T[], limit: number, fn: (t: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => { while (queue.length) await fn(queue.shift()!); }));
}

type Summary = import("../evals/metrics").Summary;

function fmt(v: number | null | undefined, kind: import("../evals/metrics").Unit = "pct"): string {
  if (v === null || v === undefined) return "–";
  if (kind === "pct") return `${(v * 100).toFixed(0)}%`;
  if (kind === "ms") return `${(v / 1000).toFixed(1)}s`;
  return v.toFixed(v < 10 ? 2 : 0);
}

function delta(cur: number | null, prev: number | null | undefined, kind: "pct" | "ms" | "num", higherBetter: boolean): string {
  if (cur === null || prev === null || prev === undefined) return "";
  const d = cur - prev;
  if (Math.abs(d) < 1e-9) return " (=)";
  const good = higherBetter ? d > 0 : d < 0;
  const s = kind === "pct" ? `${d > 0 ? "+" : ""}${(d * 100).toFixed(0)}pt` : kind === "ms" ? `${d > 0 ? "+" : ""}${(d / 1000).toFixed(1)}s` : `${d > 0 ? "+" : ""}${d.toFixed(1)}`;
  return ` (${s} ${good ? "▲" : "▼"})`;
}

function renderReport(
  meta: Record<string, unknown>,
  s: Summary,
  gates: ReturnType<typeof import("../evals/metrics").checkGates>,
  scores: import("../evals/metrics").QueryScore[],
  runs: import("../evals/metrics").QueryRun[],
  cases: import("../evals/dataset").EvalCase[],
  prev: Summary | null,
): string {
  const row = (label: string, key: keyof Summary, kind: "pct" | "ms" | "num", higherBetter = true) =>
    `| ${label} | ${fmt(s[key] as number | null, kind)}${delta(s[key] as number | null, prev?.[key] as number | null, kind, higherBetter)} |`;
  const lines = [
    `# Eval run ${meta.startedAt}`,
    "",
    `git ${meta.git}${meta.dirty ? " (dirty)" : ""} · models ${JSON.stringify(meta.models)} · config ${JSON.stringify(meta.config)}`,
    "",
    `${s.queries} queries (${s.positives} positive, ${s.negatives} negative), ${s.errors} errors`,
    "",
    "| Metric | Value |",
    "|---|---|",
    row("Recall@10 (must-find)", "recallAt10", "pct"),
    row("Recall@10 (all labelled)", "recallAllAt10", "pct"),
    row("Candidate recall (retrieval stage)", "candidateRecall", "pct"),
    row("MRR", "mrr", "num"),
    row("nDCG@10", "ndcgAt10", "num"),
    row("Result precision (grade ≥2)", "precision", "pct"),
    row("Highlight precision", "highlightPrecision", "pct"),
    row("Negatives → no strong matches", "negativePassRate", "pct"),
    row("Area-of-law accuracy", "areaAccuracy", "pct"),
    row("Date range inferred correctly", "dateInferenceAccuracy", "pct"),
    row("Results inside date range", "dateCompliance", "pct"),
    row("First result p50", "firstResultP50", "ms", false),
    row("Total p50", "totalP50", "ms", false),
    row("Total p95", "totalP95", "ms", false),
    row("TNA requests / search", "avgTnaRequests", "num", false),
    row("Input tokens / search", "avgInputTokens", "num", false),
    row("Output tokens / search", "avgOutputTokens", "num", false),
    "",
    `Missed must-find targets by stage: ${Object.entries(s.missStages).map(([k, v]) => `${k} ${v}`).join(" · ")}`,
    "",
    "## Gates",
    "",
    ...gates.map((g) => `- ${g.pass ? "✅" : "❌"} ${g.label} — ${g.value === null ? "no data" : fmt(g.value, g.unit)}`),
    "",
    "## Per query",
    "",
    "| Query | Kind | Results | Recall | RR | Precision | Highlights | Area | Dates | Misses |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...scores.map((q) => {
      const c = cases.find((x) => x.id === q.id)!;
      const hl = q.highlightsJudged ? `${q.highlightsSupported}/${q.highlightsJudged}` : "–";
      const misses = q.misses.map((m) => `${m.uri}: ${m.stage}${m.detail ? ` — ${m.detail.slice(0, 80)}` : ""}`).join("<br>");
      const kind = c.kind === "negative" ? (q.negativePass ? "neg ✅" : "neg ❌") : "pos";
      return `| ${q.id} | ${kind} | ${q.resultCount}${q.unjudged ? ` (${q.unjudged} unjudged)` : ""} | ${fmt(q.recall)} | ${fmt(q.rr, "num")} | ${fmt(q.precision)} | ${hl} | ${q.areaHit === null ? "–" : q.areaHit ? "✓" : "✗"} | ${dateCell(q, runs.find((r) => r.id === q.id)!)} | ${misses} |`;
    }),
    "",
    "## Returned cases (negatives and low grades — review these)",
    "",
    ...runs.flatMap((r) =>
      r.results
        .filter((res) => r.kind === "negative" || (r.judge[res.uri] && r.judge[res.uri].grade < 2 && !cases.find((c) => c.id === r.id)!.targets.some((t) => t.uri === res.uri)))
        .map((res) => `- **${r.id}** → ${res.name} (${res.uri}), score ${res.score.toFixed(2)}, judge ${r.judge[res.uri]?.grade ?? "?"}: ${r.judge[res.uri]?.rationale ?? ""}`),
    ),
  ];
  return lines.join("\n");
}

function dateCell(q: import("../evals/metrics").QueryScore, r: import("../evals/metrics").QueryRun): string {
  const inferred = r.dateSource === "query" && r.dates ? `${r.dates.from ?? "…"}→${r.dates.to ?? "…"}` : "none";
  const comp = q.dateCompliance === null ? "" : ` · ${fmt(q.dateCompliance)} in range`;
  return `${q.dateInferenceHit ? "✓" : "✗"} ${inferred}${comp}`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
