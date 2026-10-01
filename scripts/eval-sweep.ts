/**
 * Replays a saved eval run at stricter relevance cutoffs (no new searches or LLM calls).
 * Results below the run's own cutoff were never highlighted, so only cutoffs ≥ that one are valid.
 *
 *   pnpm eval:sweep [evals/runs/<file>.json]   (default: latest run)
 */
import { readdirSync, readFileSync } from "node:fs";
import { DATASET } from "../evals/dataset";
import { scoreQuery, summarize, type QueryRun } from "../evals/metrics";

const file = process.argv[2] ?? `evals/runs/${readdirSync("evals/runs").filter((f) => f.endsWith(".json")).sort().at(-1)}`;
const saved = JSON.parse(readFileSync(file, "utf8"));
const runs: QueryRun[] = saved.runs;
const base = Number(saved.meta?.config?.cutoff ?? 0.5);
const byId = new Map(DATASET.map((c) => [c.id, c]));

console.log(`Cutoff sweep over ${file} (run cutoff ${base})\n`);
console.log("cutoff  recall@10  precision  hl-prec  negatives  nDCG   avg results  dropped grade≥2");
for (let c = base; c <= 0.951; c += 0.05) {
  const cut = Math.round(c * 100) / 100;
  let droppedGood = 0;
  const filtered = runs.map((r) => {
    const kase = byId.get(r.id)!;
    const kept = r.results.filter((x) => x.score >= cut);
    for (const x of r.results) {
      if (x.score >= cut) continue;
      const label = kase.targets.find((t) => t.uri === x.uri)?.grade;
      if ((label ?? r.judge[x.uri]?.grade ?? 0) >= 2) droppedGood++;
    }
    return { ...r, results: kept };
  });
  const scores = filtered.map((r) => scoreQuery(byId.get(r.id)!, r));
  const s = summarize(scores, filtered);
  const avg = filtered.reduce((n, r) => n + r.results.length, 0) / filtered.length;
  const pct = (v: number | null) => (v === null ? "  –  " : `${(v * 100).toFixed(0).padStart(3)}%`);
  console.log(
    `${cut.toFixed(2)}    ${pct(s.recallAt10)}       ${pct(s.precision)}      ${pct(s.highlightPrecision)}    ${pct(s.negativePassRate)}       ${s.ndcgAt10.toFixed(2)}   ${avg.toFixed(1).padStart(5)}        ${droppedGood}`,
  );
}
