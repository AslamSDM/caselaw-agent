import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { detectAnonymised, parseJudgment } from "@/lib/tna/parser";

const fixture = (f: string) => parseJudgment(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8"));

describe("parseJudgment", () => {
  const taxi = fixture("ewhc-ch-2016-52.xml");

  it("extracts metadata", () => {
    expect(taxi.uri).toBe("ewhc/ch/2016/52");
    expect(taxi.ncn).toBe("[2016] EWHC 52 (Ch)");
    expect(taxi.court).toBe("EWHC-Chancery");
    expect(taxi.date).toBe("2016-01-20");
    expect(taxi.judges).toEqual(["THE HON MR JUSTICE ARNOLD"]);
    expect(taxi.anonymised).toBe(false);
  });

  it("keeps paragraph eIds and decodes entities", () => {
    const p83 = taxi.elements.find((e) => e.elementId === "para_83")!;
    expect(p83.num).toBe("83.");
    expect(p83.text).toContain("time required to charge the battery pack and range anxiety");
    const p84 = taxi.elements.find((e) => e.elementId === "para_84")!;
    expect(p84.text).toContain("FNR’s internal designers");
  });

  it("splits quoted blocks into child elements, included in parent text", () => {
    const p66 = taxi.elements.find((e) => e.elementId === "para_66")!;
    const quote = taxi.elements.find((e) => e.elementId === "para_66__quote_1")!;
    expect(quote.kind).toBe("quote_block");
    expect(quote.parentId).toBe("para_66");
    expect(quote.text).toMatch(/^“… it became very clear to me/);
    expect(p66.parts.some((p) => "c" in p && p.c === "para_66__quote_1")).toBe(true);
    expect(p66.text).toContain(quote.text);
  });

  it("collects case and legislation citations", () => {
    const cases = taxi.citations.filter((c) => c.type === "case");
    expect(cases.length).toBeGreaterThan(50);
    expect(cases.some((c) => c.toNcn === "[2015] EWCA Civ 290" && c.toUri === "ewca/civ/2015/290")).toBe(true);
    const leg = taxi.citations.find((c) => c.type === "legislation")!;
    expect(leg.toLegislation).toBe("Greater London Authority Act 1999");
  });

  it("handles older judgments with un-id'd nested paragraphs", () => {
    const roe = fixture("ewca-civ-2003-1.xml");
    expect(roe.ncn).toBe("[2003] EWCA Civ 1");
    expect(roe.elements.filter((e) => e.kind === "paragraph").length).toBeGreaterThan(100);
    const ids = roe.elements.map((e) => e.elementId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(roe.parties).not.toContain("and:");
  });

  it("flags anonymised family cases", () => {
    const fam = fixture("ewfc-2026-279.xml");
    expect(fam.anonymised).toBe(true);
    expect(fam.parties).toEqual(["D", "C", "K"]);
  });
});

describe("detectAnonymised", () => {
  it.each([
    ["Alfie (a Child)(Welfare), Re", null, true],
    ["X, Y & Z (Care Proceedings), Re", null, true],
    ["R v ABC", "EWCA-Criminal", true],
    ["Roe v Sheffield City Council & Ors", "EWCA-Civil", false],
    ["Customs & Excise v Total Network SL", "EWHC-QBD", false],
  ])("%s", (name, court, expected) => {
    expect(detectAnonymised(name, court, "")).toBe(expected);
  });
});
