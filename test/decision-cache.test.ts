import { describe, expect, it } from "vitest";
import { decisionKey } from "../src/lib/search/decision-cache";

const t = { RERANK_MIN: 0.05, RERANK_TRUST: 0.9, JUDGE_GATE_REJECT: 0.75 };

describe("decisionKey", () => {
  it("ignores case and spacing in the question", () => {
    expect(decisionKey("Uber  drivers workers ", "uksc/2021/5", "h1", t)).toBe(decisionKey("uber drivers workers", "uksc/2021/5", "h1", t));
  });
  it("changes with the judgment version, case or thresholds", () => {
    const k = decisionKey("q", "uksc/2021/5", "h1", t);
    expect(decisionKey("q", "uksc/2021/5", "h2", t)).not.toBe(k);
    expect(decisionKey("q", "uksc/2021/6", "h1", t)).not.toBe(k);
    expect(decisionKey("q", "uksc/2021/5", "h1", { ...t, RERANK_MIN: 0.1 })).not.toBe(k);
  });
});
