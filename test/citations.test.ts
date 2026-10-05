import { describe, expect, it } from "vitest";
import { checkQuotes, citedParagraphs, paragraphLabel, sourcesFromParts } from "@/lib/chat/citations";

const parts = [
  {
    type: "tool-read_case",
    state: "output-available",
    output: {
      name: "Mohamud v WM Morrison Supermarkets Plc",
      paragraphs: [
        { id: "para_44", num: "44.", label: "¶44", link: "/case/uksc/2016/11#para_44", text: "In the present case it was Mr Khan’s job to attend to customers and to respond to their inquiries." },
      ],
    },
  },
];

describe("chat citations", () => {
  const sources = sourcesFromParts(parts);

  it("collects paragraphs from read_case outputs", () => {
    expect(sources).toHaveLength(1);
    expect(sources[0].label).toBe("¶44");
  });

  it("matches cited links with paragraphs read, and flags unknown ones", () => {
    const text = "He was serving customers [Mohamud v WM Morrison, ¶44](/case/uksc/2016/11#para_44), see also [X, ¶9](/case/uksc/2016/11#para_9).";
    const cited = citedParagraphs(text, sources);
    expect(cited.map((c) => [c.label, Boolean(c.source)])).toEqual([
      ["Mohamud v WM Morrison, ¶44", true],
      ["X, ¶9", false],
    ]);
  });

  it("checks quotes word-for-word, tolerating curly quotes and ellipses", () => {
    const text =
      '“it was Mr Khan\'s job to attend to customers” and "to respond to their inquiries" ... but "it was his job to assault people in the shop"';
    const checks = checkQuotes(text, sources);
    expect(checks.find((c) => c.quote.startsWith("it was Mr Khan"))?.found).toBe(true);
    expect(checks.find((c) => c.quote.startsWith("it was his job"))?.found).toBe(false);
  });

  it("labels paragraphs from their number or id", () => {
    expect(paragraphLabel("87.", "para_87", 0)).toBe("¶87");
    expect(paragraphLabel(null, "para_12", 0)).toBe("¶12");
    expect(paragraphLabel(null, "p_40", 2)).toBe("passage 3");
  });
});

describe("quote pairing", () => {
  it("does not pair a short quote's closing mark with the next quote", () => {
    const sources = sourcesFromParts([
      { type: "tool-read_case", state: "output-available", output: { name: "X", paragraphs: [{ id: "para_1", link: "/case/x#para_1", text: "the wording is not conclusive and the court must look at how the work is actually performed in practice" }] } },
    ]);
    const text = 'The wording "is not conclusive" and one must look at practice. Later: "the court must look at how the work is actually performed".';
    const checks = checkQuotes(text, sources);
    expect(checks).toEqual([{ quote: "the court must look at how the work is actually performed", found: true }]);
  });
});

describe("resolveCitation", () => {
  const sources = [{ href: "/case/uksc/2021/5#p_183", caseName: "Uber", label: "¶119", text: "x" }];
  it("maps a model-built #para_N link to the judgment's real anchor by paragraph number", () => {
    const cited = citedParagraphs("see [Uber v Aslam, ¶119](/case/uksc/2021/5#para_119)", sources);
    expect(cited[0].href).toBe("/case/uksc/2021/5#p_183");
    expect(cited[0].source).not.toBeNull();
  });
  it("does not match a paragraph number in another judgment", () => {
    expect(citedParagraphs("[X, ¶119](/case/uksc/2020/1#para_119)", sources)[0].source).toBeNull();
  });
});
