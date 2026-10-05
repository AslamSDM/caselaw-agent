import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RelevanceGate, blendScore, buildBatchRequest } from "@/lib/search/gate";
import type { CaseRow } from "@/lib/cases/store";

describe("buildBatchRequest", () => {
  it("puts every case in one request with one question per case", () => {
    const body = buildBatchRequest("typesafe/jev-1.13", "escaped penguin", ["case A text", "case B text"]);
    expect(body.state).toEqual({ research_question: "escaped penguin", case_1: "case A text", case_2: "case B text" });
    expect(Object.keys(body.questions)).toEqual(["case_1", "case_2"]);
    const q = body.questions.case_2 as { type: string; instructions: string; criteria: Record<string, string> };
    expect(q.type).toBe("choice");
    expect(q.instructions).toContain("case_2");
    expect(Object.keys(q.criteria)).toEqual(["on_point", "tangential", "irrelevant"]);
  });
});

type Probs = { on_point: number; tangential: number; irrelevant: number };

const kase = (n: number) => ({ uri: `ewhc/2024/${n}`, name: `Case ${n}`, ncn: null, court: "ewhc", date: "2024-01-01" }) as unknown as CaseRow;
const ctx = { topLevel: [], all: [] };

/** fetch stub: answers every case in the request with `probs(i)`, or fails when `fail` is set */
function stubFetch(probs: (i: number) => Probs = () => ({ on_point: 0.8, tangential: 0.15, irrelevant: 0.05 }), fail = false) {
  const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { questions: Record<string, unknown> };
    if (fail) return { ok: false, status: 500, json: async () => ({ error: { message: "upstream down" } }) };
    const answers = Object.fromEntries(
      Object.keys(body.questions).map((k, i) => {
        const p = probs(i);
        const choice = (Object.entries(p).sort((a, b) => b[1] - a[1])[0][0]) as keyof Probs;
        return [k, { choice, probabilities: p, confidence: p[choice] }];
      }),
    );
    return { ok: true, status: 200, json: async () => ({ answers, usage: { cost: 0.001 } }) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** case keys of the request the n-th fetch call sent */
const sentCases = (fetchMock: ReturnType<typeof stubFetch>, n = 0) =>
  Object.keys((JSON.parse(fetchMock.mock.calls[n][1].body) as { questions: object }).questions);

describe("RelevanceGate batching", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("waits for a case still in flight, then sends both in one request", async () => {
    const fetchMock = stubFetch();
    const gate = new RelevanceGate("jev", "q");
    const [t1, t2] = [gate.enter(), gate.enter()];
    const p1 = gate.screen(kase(1), ctx, t1);
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchMock).not.toHaveBeenCalled();
    const p2 = gate.screen(kase(2), ctx, t2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentCases(fetchMock)).toEqual(["case_1", "case_2"]);
    await expect(Promise.all([p1, p2])).resolves.toHaveLength(2);
    expect(gate.stats).toMatchObject({ requests: 1, cases: 2, errors: 0 });
    expect(gate.inFlight).toBe(0);
  });

  it("sends at once when the only case in flight submits (no timer wait)", async () => {
    const fetchMock = stubFetch();
    const gate = new RelevanceGate("jev", "q");
    const p = gate.screen(kase(1), ctx, gate.enter());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    const v = await p;
    expect(v.choice).toBe("on_point");
    expect(v.onPoint).toBe(0.8);
    expect(v.reject).toBe(false);
  });

  it("sends when the last case still in flight leaves without submitting", async () => {
    const fetchMock = stubFetch();
    const gate = new RelevanceGate("jev", "q");
    const [t1, t2] = [gate.enter(), gate.enter()];
    const p1 = gate.screen(kase(1), ctx, t1);
    expect(fetchMock).not.toHaveBeenCalled();
    t2.leave(); // e.g. rejected by the reranker
    t2.leave(); // idempotent
    t1.leave(); // already submitted: no-op
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await p1;
    expect(gate.inFlight).toBe(0);
  });

  it("falls back to the wait timer while another case is still in flight", async () => {
    const fetchMock = stubFetch();
    const gate = new RelevanceGate("jev", "q");
    const t1 = gate.enter();
    gate.enter(); // a slow case that never arrives in time
    const p1 = gate.screen(kase(1), ctx, t1);
    await vi.advanceTimersByTimeAsync(399);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await p1;
  });

  it("rejects when P(tangential) + P(irrelevant) reaches the threshold (0.75)", async () => {
    const probs: Probs[] = [
      { on_point: 0.2, tangential: 0.5, irrelevant: 0.3 }, // 0.80 → reject
      { on_point: 0.25, tangential: 0.5, irrelevant: 0.25 }, // 0.75 → reject (inclusive)
      { on_point: 0.3, tangential: 0.45, irrelevant: 0.25 }, // 0.70 → pass
    ];
    stubFetch((i) => probs[i]);
    const gate = new RelevanceGate("jev", "q");
    const tickets = probs.map(() => gate.enter());
    const verdicts = await Promise.all(probs.map((_, i) => gate.screen(kase(i), ctx, tickets[i])));
    expect(verdicts.map((v) => v.reject)).toEqual([true, true, false]);
    expect(verdicts.map((v) => v.onPoint)).toEqual([0.2, 0.25, 0.3]);
    expect(gate.stats).toMatchObject({ requests: 1, cases: 3, rejected: 2 });
  });

  it("a failed request rejects every case in the batch and counts each as an error", async () => {
    stubFetch(undefined, true);
    const gate = new RelevanceGate("jev", "q");
    const tickets = [gate.enter(), gate.enter(), gate.enter()];
    const results = await Promise.allSettled(tickets.map((t, i) => gate.screen(kase(i), ctx, t)));
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected", "rejected"]);
    expect(String((results[0] as PromiseRejectedResult).reason)).toContain("decisions 500");
    expect(gate.stats).toMatchObject({ requests: 1, cases: 0, errors: 3 });
  });

  it("flushes a full batch (GATE_BATCH_SIZE, 6) without waiting for cases still in flight", async () => {
    const fetchMock = stubFetch();
    const gate = new RelevanceGate("jev", "q");
    const tickets = Array.from({ length: 8 }, () => gate.enter());
    const first = tickets.slice(0, 6).map((t, i) => gate.screen(kase(i), ctx, t));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentCases(fetchMock)).toHaveLength(6);
    const rest = tickets.slice(6).map((t, i) => gate.screen(kase(6 + i), ctx, t));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentCases(fetchMock, 1)).toEqual(["case_1", "case_2"]);
    await Promise.all([...first, ...rest]);
    expect(gate.stats).toMatchObject({ requests: 2, cases: 8 });
  });
});

describe("blendScore", () => {
  it("is the judge score without a pre-screen verdict or with weight 0", () => {
    expect(blendScore(0.7, undefined, 0.25)).toBe(0.7);
    expect(blendScore(0.7, { onPoint: 0.1 }, 0)).toBe(0.7);
  });
  it("pulls the judge score towards P(on_point) geometrically", () => {
    expect(blendScore(0.8, { onPoint: 0.8 }, 0.25)).toBeCloseTo(0.8);
    expect(blendScore(0.8, { onPoint: 0.2 }, 0.25)).toBeCloseTo(0.8 ** 0.75 * 0.2 ** 0.25);
    expect(blendScore(0.8, { onPoint: 0.2 }, 0.25)).toBeLessThan(0.8);
  });
});
