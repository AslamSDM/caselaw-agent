import { describe, expect, it } from "vitest";
import { buildBatchRequest } from "@/lib/search/gate";

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
