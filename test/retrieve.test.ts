import { describe, expect, it } from "vitest";
import { RENDER_CAPS, renderCost, selectParagraphs } from "@/lib/search/retrieve";
import { buildCaseContext } from "@/lib/search/relevance";
import type { ElementRow } from "@/lib/cases/store";

const el = (id: string, text: string, parentId: string | null = null, kind = "paragraph"): ElementRow => ({
  caseUri: "x",
  elementId: id,
  parentId,
  kind,
  num: null,
  ord: 0,
  text,
  parts: [{ t: text }],
});
const paras = Array.from({ length: 20 }, (_, i) => el(`p${i}`, `paragraph ${i} `.repeat(10)));
const opts = { top: 8, neighboursFor: 3, budgetChars: 100_000 };

describe("selectParagraphs", () => {
  it("interleaves keyword and semantic rankings and dedupes", () => {
    const r = selectParagraphs(paras, ["p1", "p5"], ["p5", "p10"], { ...opts, neighboursFor: 0 });
    expect(r.topLevel.map((e) => e.elementId)).toEqual(["p1", "p5", "p10"]);
  });

  it("adds neighbours only for the best few", () => {
    const r = selectParagraphs(paras, ["p5", "p15"], [], { ...opts, neighboursFor: 1 });
    expect(r.topLevel.map((e) => e.elementId)).toEqual(["p4", "p5", "p6", "p15"]);
  });

  it("caps at top N", () => {
    const ids = paras.map((p) => p.elementId);
    const r = selectParagraphs(paras, ids, [], { ...opts, neighboursFor: 0 });
    expect(r.topLevel).toHaveLength(8);
  });

  it("stops at the character budget but always keeps the best paragraph", () => {
    const big = [el("a", "x".repeat(5000)), el("b", "y".repeat(5000)), el("c", "z".repeat(5000))];
    const r = selectParagraphs(big, ["a", "b", "c"], [], { top: 8, neighboursFor: 0, budgetChars: 2000 });
    expect(r.topLevel.map((e) => e.elementId)).toEqual(["a"]);
    const r2 = selectParagraphs(big, ["a", "b", "c"], [], { top: 8, neighboursFor: 0, budgetChars: 3000 });
    expect(r2.topLevel).toHaveLength(2);
  });

  it("counts capped nested passages in the budget, and the renderer honours the same caps", () => {
    const root = { ...el("r", "intro"), parts: [{ t: "intro" }, ...Array.from({ length: 12 }, (_, i) => ({ c: `r__q${i}` }))] };
    const kids = Array.from({ length: 12 }, (_, i) => el(`r__q${i}`, "q".repeat(2000), "r", "quote_block"));
    const all = [root, ...kids];
    const children = new Map([["r", kids]]);
    expect(renderCost(root, children)).toBe(5 + 40 + RENDER_CAPS.maxChildren * (RENDER_CAPS.childChars + 40));
    const text = buildCaseContext({ topLevel: [root], all });
    expect(text).toContain("(4 more nested passages omitted)");
    expect(text.split("<el ").length - 1).toBe(1 + RENDER_CAPS.maxChildren);
    expect(text).not.toContain("q".repeat(RENDER_CAPS.childChars + 1));
  });
});

describe("interleave", () => {
  it("alternates two rankings, dedupes and caps", async () => {
    const { interleave } = await import("@/lib/search/retrieve");
    expect(interleave(["a", "b", "c"], ["b", "d"], 10)).toEqual(["a", "b", "d", "c"]);
    expect(interleave(["a", "b", "c"], ["x", "y"], 3)).toEqual(["a", "x", "b"]);
  });
});
