import { describe, expect, it } from "vitest";
import { fuseCandidates, specificity } from "@/lib/search/fusion";
import { extractNcns, ncnToUri } from "@/lib/tna/ncn";
import type { CandidateList } from "@/lib/search/types";

const e = (uri: string) => ({ uri, name: uri, ncn: null, court: null, date: null });

describe("fuseCandidates", () => {
  it("prefers cases hit by specific queries and by several variants", () => {
    const lists: CandidateList[] = [
      { source: "keyword", label: "broad", estimatedTotal: 5000, entries: [e("a"), e("b"), e("c")] },
      { source: "keyword", label: "specific", estimatedTotal: 4, entries: [e("c"), e("d")] },
      { source: "keyword", label: "specific2", estimatedTotal: 8, entries: [e("d")] },
    ];
    const out = fuseCandidates(lists);
    expect(out[0].uri).toBe("d");
    expect(out[1].uri).toBe("c");
    expect(out.find((c) => c.uri === "d")!.matchedBy).toEqual(["specific", "specific2"]);
  });

  it("weights NCN hits highest", () => {
    const out = fuseCandidates([
      { source: "keyword", label: "k", estimatedTotal: 3, entries: [e("a")] },
      { source: "ncn", label: "web citation", estimatedTotal: 1, entries: [e("z")] },
    ]);
    expect(out[0].uri).toBe("z");
  });

  it("specificity decreases with hit count", () => {
    expect(specificity(5)).toBe(1);
    expect(specificity(500)).toBeLessThan(specificity(50));
    expect(specificity(0)).toBe(0);
  });
});

describe("ncn", () => {
  it.each([
    ["[2016] EWHC 52 (Ch)", "ewhc/ch/2016/52"],
    ["[2015] EWCA Civ 290", "ewca/civ/2015/290"],
    ["[2020] UKSC 5", "uksc/2020/5"],
    ["[2026] EWFC 178 (B)", "ewfc/b/2026/178"],
    ["[2022] UKFTT 455 (TC)", "ukftt/tc/2022/455"],
  ])("%s → %s", (ncn, uri) => expect(ncnToUri(ncn)).toBe(uri));

  it("extracts NCNs from free text", () => {
    expect(extractNcns("see Smith v Jones [2019] EWHC 1234 (QB) and [2020] UKSC 5.")).toEqual(["[2019] EWHC 1234 (QB)", "[2020] UKSC 5"]);
  });
});
