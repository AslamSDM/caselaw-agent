import { describe, expect, it } from "vitest";
import { formatRange, inRange, normalizeRange, parseDateInput, tnaDateParams } from "@/lib/dates";
import { searchUrl } from "@/lib/tna/urls";

describe("dates", () => {
  it("parses year / month / day inputs to period bounds", () => {
    expect(parseDateInput("2020", "from")).toBe("2020-01-01");
    expect(parseDateInput("2020", "to")).toBe("2020-12-31");
    expect(parseDateInput("2024-02", "to")).toBe("2024-02-29");
    expect(parseDateInput("2021-03-15", "from")).toBe("2021-03-15");
    expect(parseDateInput("last year", "from")).toBeUndefined();
    expect(parseDateInput("2021-02-30", "from")).toBeUndefined();
  });

  it("normalizes ranges", () => {
    expect(normalizeRange({ from: "2022-01-01", to: "2019-12-31" })).toEqual({ from: "2019-12-31", to: "2022-01-01" });
    expect(normalizeRange({ from: "nope" })).toBeNull();
    expect(normalizeRange({ to: "2016-12-31" })).toEqual({ to: "2016-12-31" });
  });

  it("checks membership inclusively; undated cases fail a filter", () => {
    const r = { from: "2019-01-01", to: "2019-12-31" };
    expect(inRange("2019-12-31", r)).toBe(true);
    expect(inRange("2020-01-01", r)).toBe(false);
    expect(inRange(null, r)).toBe(false);
    expect(inRange(null, null)).toBe(true);
  });

  it("formats", () => {
    expect(formatRange({ from: "2019-01-01", to: "2019-12-31" })).toBe("2019 – 2019");
    expect(formatRange({ from: "2020-01-01" })).toBe("since 2020");
    expect(formatRange({ to: "2021-03-31" })).toBe("until 2021-03-31");
  });

  it("builds TNA day/month/year params", () => {
    expect(tnaDateParams({ from: "2019-03-05" })).toEqual([["from_date_0", "5"], ["from_date_1", "3"], ["from_date_2", "2019"]]);
    const url = searchUrl({ query: "x", dates: { from: "2019-01-01", to: "2019-12-31" } });
    expect(url).toContain("from_date_2=2019");
    expect(url).toContain("to_date_0=31");
  });
});
