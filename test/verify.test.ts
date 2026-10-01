import { describe, expect, it } from "vitest";
import { matchQuote, verifyQuote } from "@/lib/search/verify";

const para = "Mr Chia gave evidence that he attended meetings. He stated:\n“… it became very clear to me that the PCO (and TfL) were keen for British traditions to be preserved with regard to the ‘look’ of any new licensed London cab.”";
const quote = "“… it became very clear to me that the PCO (and TfL) were keen for British traditions to be preserved with regard to the ‘look’ of any new licensed London cab.”";

describe("matchQuote", () => {
  it("matches across curly/straight quotes and whitespace, returning source text", () => {
    const m = matchQuote('the PCO (and TfL) were keen for British traditions to be preserved with regard to the \'look\'', para)!;
    expect(m.similarity).toBe(1);
    expect(m.matchedText).toBe("the PCO (and TfL) were keen for British traditions to be preserved with regard to the ‘look’");
  });

  it("accepts near-exact quotes above threshold", () => {
    const m = matchQuote("the PCO and TfL were keen for British tradition to be preserved with regard to the look of any new licensed London cab", para);
    expect(m).not.toBeNull();
    expect(m!.similarity).toBeGreaterThanOrEqual(0.9);
    expect(para).toContain(m!.matchedText);
  });

  it("rejects paraphrases", () => {
    expect(matchQuote("officials wanted the traditional appearance of London taxis kept intact", para)).toBeNull();
  });

  it("rejects too-short quotes", () => {
    expect(matchQuote("PCO", para)).toBeNull();
  });
});

describe("verifyQuote", () => {
  const elements = [
    { elementId: "para_66", parentId: null, text: para },
    { elementId: "para_66__quote_1", parentId: "para_66", text: quote },
    { elementId: "para_67", parentId: null, text: "Something else entirely about taxis." },
  ];

  it("anchors on the smallest containing element even if the model named the parent", () => {
    const m = verifyQuote("keen for British traditions to be preserved", "para_66", elements)!;
    expect(m.elementId).toBe("para_66__quote_1");
  });

  it("corrects a wrong element id", () => {
    expect(verifyQuote("he attended meetings", "para_67", elements)!.elementId).toBe("para_66");
  });

  it("returns null for hallucinated text", () => {
    expect(verifyQuote("the battery pack leaked electrolyte into the cabin", "para_66", elements)).toBeNull();
  });
});
