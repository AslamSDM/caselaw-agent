/**
 * Eval metrics. Pure functions over a recorded run, so they can be unit-tested and recomputed
 * from saved run files without re-running searches.
 *
 * Grades: 3 = leading authority, 2 = relevant, 1 = tangential, 0 = irrelevant.
 * Labelled targets take precedence; other returned cases use the LLM judge's grade.
 */
import type { EvalCase } from "./dataset";

export interface RecordedHighlight {
  elementId: string;
  kind: string;
  quote: string;
}

export interface RecordedResult {
  uri: string;
  name: string;
  date: string | null;
  score: number;
  areas: string[];
  highlights: RecordedHighlight[];
}

export interface JudgeVerdict {
  grade: 0 | 1 | 2 | 3;
  /** one entry per judged highlight (first N of the result) */
  highlightSupports: boolean[];
  rationale: string;
}

export interface QueryRun {
  id: string;
  kind: EvalCase["kind"];
  query: string;
  error?: string;
  candidates: string[];
  results: RecordedResult[];
  rejected: { uri: string; name: string; score: number; reason: string }[];
  /** date range the pipeline applied, and where it came from */
  dates: { from?: string; to?: string } | null;
  dateSource: string;
  /** areas stored for each target case after the run (targets may have been rejected) */
  targetAreas: Record<string, string[]>;
  stats: { ms: number; firstResultMs: number | null; tnaRequests: number; inputTokens: number; outputTokens: number; webEnrichment: string } | null;
  judge: Record<string, JudgeVerdict>;
}

export type MissStage = "not-retrieved" | "rejected" | "not-read" | "error";

export interface QueryScore {
  id: string;
  kind: EvalCase["kind"];
  recall: number | null; // grade-3 targets in results
  recallAll: number | null; // all labelled targets in results
  candidateRecall: number | null; // grade-3 targets among candidates (retrieval stage only)
  rr: number | null; // reciprocal rank of first grade-3 target
  ndcg: number | null;
  precision: number | null; // results graded ≥2 / graded results
  highlightsJudged: number;
  highlightsSupported: number;
  areaHit: boolean | null;
  /** inferred range matches the expected one (or none expected and none inferred) */
  dateInferenceHit: boolean;
  /** results inside the expected range / results (null when the query has no range) */
  dateCompliance: number | null;
  negativePass: boolean | null;
  misses: { uri: string; stage: MissStage; detail?: string }[];
  resultCount: number;
  unjudged: number;
}

export function gradeOf(uri: string, c: EvalCase, run: QueryRun): number | null {
  const label = c.targets.find((t) => t.uri === uri);
  if (label) return label.grade;
  return run.judge[uri]?.grade ?? null;
}

function dcg(gains: number[]): number {
  return gains.reduce((s, g, i) => s + (2 ** g - 1) / Math.log2(i + 2), 0);
}

export function scoreQuery(c: EvalCase, run: QueryRun, k = 10): QueryScore {
  const results = run.results.slice(0, k);
  const resultUris = results.map((r) => r.uri);
  const must = c.targets.filter((t) => t.grade === 3);
  const score: QueryScore = {
    id: c.id,
    kind: c.kind,
    recall: null,
    recallAll: null,
    candidateRecall: null,
    rr: null,
    ndcg: null,
    precision: null,
    highlightsJudged: 0,
    highlightsSupported: 0,
    areaHit: null,
    dateInferenceHit: dateInferenceHit(c, run),
    dateCompliance: null,
    negativePass: null,
    misses: [],
    resultCount: run.results.length,
    unjudged: 0,
  };

  // highlight precision + result precision (both kinds)
  const grades: (number | null)[] = results.map((r) => gradeOf(r.uri, c, run));
  const graded = grades.filter((g): g is number => g !== null);
  score.unjudged = grades.length - graded.length;
  if (graded.length) score.precision = graded.filter((g) => g >= 2).length / graded.length;
  for (const r of results) {
    const v = run.judge[r.uri];
    if (!v) continue;
    score.highlightsJudged += v.highlightSupports.length;
    score.highlightsSupported += v.highlightSupports.filter(Boolean).length;
  }

  if (c.dates && run.results.length) {
    const inside = run.results.filter((r) => {
      const y = r.date ? Number(r.date.slice(0, 4)) : NaN;
      return !Number.isNaN(y) && (c.dates!.fromYear === undefined || y >= c.dates!.fromYear) && (c.dates!.toYear === undefined || y <= c.dates!.toYear);
    });
    score.dateCompliance = inside.length / run.results.length;
  }

  if (c.kind === "negative") {
    score.negativePass = run.results.length === 0 && !run.error;
    return score;
  }
  if (run.error) {
    score.recall = 0;
    score.recallAll = 0;
    score.candidateRecall = 0;
    score.rr = 0;
    score.ndcg = 0;
    score.misses = must.map((t) => ({ uri: t.uri, stage: "error" as const, detail: run.error }));
    return score;
  }

  score.recall = must.filter((t) => resultUris.includes(t.uri)).length / must.length;
  score.recallAll = c.targets.filter((t) => resultUris.includes(t.uri)).length / c.targets.length;
  score.candidateRecall = must.filter((t) => run.candidates.includes(t.uri)).length / must.length;
  const firstHit = resultUris.findIndex((u) => must.some((t) => t.uri === u));
  score.rr = firstHit >= 0 ? 1 / (firstHit + 1) : 0;

  // nDCG@k: ideal ranking uses every known grade (labels + judged returned cases)
  const gains = grades.map((g) => g ?? 0);
  const known = new Map<string, number>();
  for (const t of c.targets) known.set(t.uri, t.grade);
  for (const [uri, v] of Object.entries(run.judge)) if (!known.has(uri)) known.set(uri, v.grade);
  const ideal = [...known.values()].sort((a, b) => b - a).slice(0, k);
  const idcg = dcg(ideal);
  score.ndcg = idcg > 0 ? dcg(gains) / idcg : 0;

  for (const t of must) {
    if (resultUris.includes(t.uri)) continue;
    const rej = run.rejected.find((r) => r.uri === t.uri);
    if (rej) score.misses.push({ uri: t.uri, stage: "rejected", detail: rej.reason });
    else if (run.candidates.includes(t.uri)) score.misses.push({ uri: t.uri, stage: "not-read" });
    else score.misses.push({ uri: t.uri, stage: "not-retrieved" });
  }

  if (c.areas.length) {
    const predicted = new Set(must.flatMap((t) => run.results.find((r) => r.uri === t.uri)?.areas ?? run.targetAreas[t.uri] ?? []));
    score.areaHit = predicted.size ? c.areas.some((a) => predicted.has(a)) : null;
  }
  return score;
}

export function dateInferenceHit(c: EvalCase, run: QueryRun, nowYear = new Date().getFullYear()): boolean {
  const inferred = run.dateSource === "query" ? run.dates : null;
  const exp = c.dates;
  if (!exp) return !inferred;
  if (!inferred) return false;
  const tol = exp.toleranceYears ?? 0;
  const year = (d?: string) => (d ? Number(d.slice(0, 4)) : undefined);
  const endOk = (want: number | undefined, got: number | undefined, openEndOk: (g: number) => boolean) =>
    want === undefined ? got === undefined || openEndOk(got) : got !== undefined && Math.abs(got - want) <= tol;
  return (
    endOk(exp.fromYear, year(inferred.from), () => false) &&
    // an open-ended "since X" may be closed at today
    endOk(exp.toYear, year(inferred.to), (g) => g >= nowYear)
  );
}

export interface Summary {
  queries: number;
  positives: number;
  negatives: number;
  errors: number;
  recallAt10: number;
  recallAllAt10: number;
  candidateRecall: number;
  mrr: number;
  ndcgAt10: number;
  precision: number | null;
  highlightPrecision: number | null;
  negativePassRate: number | null;
  areaAccuracy: number | null;
  dateInferenceAccuracy: number;
  dateCompliance: number | null;
  firstResultP50: number | null;
  totalP50: number | null;
  totalP95: number | null;
  avgTnaRequests: number;
  avgInputTokens: number;
  avgOutputTokens: number;
  missStages: Record<MissStage, number>;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}

export function summarize(scores: QueryScore[], runs: QueryRun[]): Summary {
  const pos = scores.filter((s) => s.kind === "positive");
  const neg = scores.filter((s) => s.kind === "negative");
  const vals = (f: (s: QueryScore) => number | null, xs = pos) => xs.map(f).filter((v): v is number => v !== null);
  const judged = scores.reduce((n, s) => n + s.highlightsJudged, 0);
  const supported = scores.reduce((n, s) => n + s.highlightsSupported, 0);
  const areaVals = pos.map((s) => s.areaHit).filter((v): v is boolean => v !== null);
  const precs = vals((s) => s.precision, scores);
  const stats = runs.map((r) => r.stats).filter((s): s is NonNullable<QueryRun["stats"]> => s !== null);
  const missStages: Record<MissStage, number> = { "not-retrieved": 0, rejected: 0, "not-read": 0, error: 0 };
  for (const s of pos) for (const m of s.misses) missStages[m.stage]++;

  return {
    queries: scores.length,
    positives: pos.length,
    negatives: neg.length,
    errors: runs.filter((r) => r.error).length,
    recallAt10: mean(vals((s) => s.recall)),
    recallAllAt10: mean(vals((s) => s.recallAll)),
    candidateRecall: mean(vals((s) => s.candidateRecall)),
    mrr: mean(vals((s) => s.rr)),
    ndcgAt10: mean(vals((s) => s.ndcg)),
    precision: precs.length ? mean(precs) : null,
    highlightPrecision: judged ? supported / judged : null,
    negativePassRate: neg.length ? neg.filter((s) => s.negativePass).length / neg.length : null,
    areaAccuracy: areaVals.length ? areaVals.filter(Boolean).length / areaVals.length : null,
    dateInferenceAccuracy: scores.length ? scores.filter((s) => s.dateInferenceHit).length / scores.length : 0,
    dateCompliance: (() => {
      const v = vals((s) => s.dateCompliance, scores);
      return v.length ? mean(v) : null;
    })(),
    firstResultP50: percentile(stats.map((s) => s.firstResultMs).filter((v): v is number => v !== null), 50),
    totalP50: percentile(stats.map((s) => s.ms), 50),
    totalP95: percentile(stats.map((s) => s.ms), 95),
    avgTnaRequests: mean(stats.map((s) => s.tnaRequests)),
    avgInputTokens: mean(stats.map((s) => s.inputTokens)),
    avgOutputTokens: mean(stats.map((s) => s.outputTokens)),
    missStages,
  };
}

/** Pass/fail gates from plan.md Phase 1 "done when". */
export type Unit = "pct" | "ms" | "num";

export const GATES: { key: keyof Summary; min?: number; max?: number; label: string; unit: Unit }[] = [
  { key: "recallAt10", min: 0.7, label: "recall@10 ≥ 70%", unit: "pct" },
  { key: "highlightPrecision", min: 0.9, label: "highlight precision ≥ 90%", unit: "pct" },
  { key: "negativePassRate", min: 0.8, label: "negatives → no strong matches ≥ 80%", unit: "pct" },
  { key: "dateCompliance", min: 1, label: "all results inside the question's date range", unit: "pct" },
  { key: "dateInferenceAccuracy", min: 0.9, label: "date range inferred correctly ≥ 90%", unit: "pct" },
  { key: "firstResultP50", max: 8000, label: "first result p50 < 8s", unit: "ms" },
  { key: "totalP50", max: 20000, label: "full results p50 < 20s", unit: "ms" },
  { key: "avgTnaRequests", max: 25, label: "TNA requests/search ≤ 25", unit: "num" },
];

export function checkGates(s: Summary): { label: string; value: number | null; unit: Unit; pass: boolean }[] {
  return GATES.map((g) => {
    const v = s[g.key] as number | null;
    const pass = v !== null && (g.min === undefined || v >= g.min) && (g.max === undefined || v <= g.max);
    return { label: g.label, value: v, unit: g.unit, pass };
  });
}
