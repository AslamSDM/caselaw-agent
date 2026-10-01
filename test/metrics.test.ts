import { describe, expect, it } from "vitest";
import { checkGates, dateInferenceHit, scoreQuery, summarize, type QueryRun } from "../evals/metrics";
import type { EvalCase } from "../evals/dataset";
import { courtAreas } from "@/lib/areas";

const pos: EvalCase = {
  id: "p",
  query: "q",
  kind: "positive",
  targets: [
    { uri: "a", ncn: "A", grade: 3 },
    { uri: "b", ncn: "B", grade: 2 },
  ],
  areas: ["employment"],
};
const neg: EvalCase = { id: "n", query: "q", kind: "negative", targets: [], areas: [] };

const res = (uri: string, areas: string[] = [], date: string | null = "2020-01-01") => ({ uri, name: uri, date, score: 0.8, areas, highlights: [] });
const base = (over: Partial<QueryRun>): QueryRun => ({
  id: "p",
  kind: "positive",
  query: "q",
  candidates: [],
  results: [],
  rejected: [],
  dates: null,
  dateSource: "none",
  targetAreas: {},
  stats: { ms: 10000, firstResultMs: 5000, tnaRequests: 12, inputTokens: 1000, outputTokens: 100, webEnrichment: "used" },
  judge: {},
  ...over,
});

describe("scoreQuery", () => {
  it("scores a hit at rank 2 with a judged irrelevant case above it", () => {
    const run = base({
      candidates: ["x", "a", "b"],
      results: [res("x"), res("a", ["employment", "tort"])],
      judge: { x: { grade: 0, highlightSupports: [false, true], rationale: "" }, a: { grade: 3, highlightSupports: [true], rationale: "" } },
    });
    const s = scoreQuery(pos, run);
    expect(s.recall).toBe(1);
    expect(s.recallAll).toBe(0.5);
    expect(s.rr).toBe(0.5);
    expect(s.precision).toBe(0.5);
    expect(s.highlightsSupported).toBe(2);
    expect(s.highlightsJudged).toBe(3);
    expect(s.areaHit).toBe(true);
    expect(s.ndcg!).toBeGreaterThan(0);
    expect(s.ndcg!).toBeLessThan(1);
  });

  it("attributes misses to the pipeline stage", () => {
    expect(scoreQuery(pos, base({})).misses[0].stage).toBe("not-retrieved");
    expect(scoreQuery(pos, base({ candidates: ["a"] })).misses[0].stage).toBe("not-read");
    const rej = scoreQuery(pos, base({ candidates: ["a"], rejected: [{ uri: "a", name: "a", score: 0.2, reason: "incidental" }] }));
    expect(rej.misses[0]).toEqual({ uri: "a", stage: "rejected", detail: "incidental" });
  });

  it("uses stored areas for a target that was rejected", () => {
    const s = scoreQuery(pos, base({ candidates: ["a"], targetAreas: { a: ["tax"] } }));
    expect(s.areaHit).toBe(false);
  });

  it("perfect ranking gives nDCG 1", () => {
    expect(scoreQuery(pos, base({ results: [res("a"), res("b")] })).ndcg).toBeCloseTo(1);
  });

  it("negatives pass only with no results", () => {
    expect(scoreQuery(neg, base({ id: "n", kind: "negative" })).negativePass).toBe(true);
    expect(scoreQuery(neg, base({ id: "n", kind: "negative", results: [res("z")] })).negativePass).toBe(false);
  });
});

describe("summarize + gates", () => {
  it("aggregates and gates", () => {
    const runs = [base({ results: [res("a")] }), base({ id: "n", kind: "negative" })];
    const scores = [scoreQuery(pos, runs[0]), scoreQuery(neg, runs[1])];
    const s = summarize(scores, runs);
    expect(s.recallAt10).toBe(1);
    expect(s.negativePassRate).toBe(1);
    expect(s.firstResultP50).toBe(5000);
    const gates = checkGates(s);
    expect(gates.find((g) => g.label.startsWith("recall"))!.pass).toBe(true);
    // no judged highlights → gate has no data and fails
    expect(gates.find((g) => g.label.startsWith("highlight"))!.pass).toBe(false);
  });
});

describe("dates in evals", () => {
  const dated: EvalCase = { ...pos, dates: { fromYear: 2020 } };

  it("inference must match the expected range; no range expected means none inferred", () => {
    expect(dateInferenceHit(pos, base({}))).toBe(true);
    expect(dateInferenceHit(pos, base({ dates: { from: "2019-01-01" }, dateSource: "query" }))).toBe(false);
    expect(dateInferenceHit(dated, base({ dates: { from: "2020-01-01" }, dateSource: "query" }), 2026)).toBe(true);
    // "since 2020" closed at today is fine
    expect(dateInferenceHit(dated, base({ dates: { from: "2020-01-01", to: "2026-10-01" }, dateSource: "query" }), 2026)).toBe(true);
    expect(dateInferenceHit(dated, base({ dates: { from: "2020-01-01", to: "2022-12-31" }, dateSource: "query" }), 2026)).toBe(false);
    // a user-set range doesn't count as inference
    expect(dateInferenceHit(dated, base({ dates: { from: "2020-01-01" }, dateSource: "user" }))).toBe(false);
    const recent: EvalCase = { ...pos, dates: { fromYear: 2021, toleranceYears: 1 } };
    expect(dateInferenceHit(recent, base({ dates: { from: "2021-10-01" }, dateSource: "query" }))).toBe(true);
  });

  it("measures results inside the expected range", () => {
    const s = scoreQuery(dated, base({ results: [res("a", [], "2021-02-19"), res("b", [], "2018-06-13")] }));
    expect(s.dateCompliance).toBe(0.5);
  });
});

describe("courtAreas", () => {
  it.each([
    ["UKFTT-TC", ["tax"]],
    ["EWFC", ["family"]],
    ["EWCA-Criminal", ["criminal"]],
    ["EWHC-Chancery-Patents", ["ip"]],
    ["EWHC-KBD-Admin", ["public"]],
    ["UKSC", []],
    [null, []],
  ])("%s", (court, areas) => expect(courtAreas(court)).toEqual(areas));
});
