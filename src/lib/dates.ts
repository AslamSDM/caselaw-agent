/** Judgment date ranges (inclusive ISO dates, either end optional). */
export interface DateRange {
  from?: string; // YYYY-MM-DD
  to?: string; // YYYY-MM-DD
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function valid(d: string | undefined | null): string | undefined {
  if (!d || !ISO.test(d)) return undefined;
  const t = Date.parse(`${d}T00:00:00Z`);
  // reject impossible dates rather than letting 2021-02-30 roll over to March
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d ? d : undefined;
}

/** Accepts YYYY, YYYY-MM or YYYY-MM-DD; expands to the start/end of the period. */
export function parseDateInput(s: string | undefined | null, end: "from" | "to"): string | undefined {
  const v = (s ?? "").trim();
  if (/^\d{4}$/.test(v)) return end === "from" ? `${v}-01-01` : `${v}-12-31`;
  const ym = v.match(/^(\d{4})-(\d{2})$/);
  if (ym) {
    if (end === "from") return `${v}-01`;
    const last = new Date(Date.UTC(Number(ym[1]), Number(ym[2]), 0)).getUTCDate();
    return `${v}-${String(last).padStart(2, "0")}`;
  }
  return valid(v);
}

/** Validates, swaps reversed ends, drops an empty range. */
export function normalizeRange(r: DateRange | null | undefined): DateRange | null {
  if (!r) return null;
  let from = valid(r.from);
  let to = valid(r.to);
  if (from && to && from > to) [from, to] = [to, from];
  if (!from && !to) return null;
  return { ...(from && { from }), ...(to && { to }) };
}

export function inRange(date: string | null | undefined, r: DateRange | null | undefined): boolean {
  if (!r) return true;
  if (!date) return false; // undated judgments can't be shown as satisfying a date filter
  const d = date.slice(0, 10);
  return (!r.from || d >= r.from) && (!r.to || d <= r.to);
}

export function formatRange(r: DateRange | null | undefined): string {
  if (!r) return "any date";
  const short = (d: string, end: "from" | "to") =>
    d.endsWith(end === "from" ? "-01-01" : "-12-31") ? d.slice(0, 4) : d;
  if (r.from && r.to) return `${short(r.from, "from")} – ${short(r.to, "to")}`;
  if (r.from) return `since ${short(r.from, "from")}`;
  return `until ${short(r.to!, "to")}`;
}

/** TNA atom params: from_date_0/1/2 = day/month/year (same for to_date). */
export function tnaDateParams(r: DateRange | null | undefined): [string, string][] {
  const out: [string, string][] = [];
  for (const [end, d] of [["from", r?.from], ["to", r?.to]] as const) {
    if (!d) continue;
    const [y, m, day] = d.split("-");
    out.push([`${end}_date_0`, String(Number(day))], [`${end}_date_1`, String(Number(m))], [`${end}_date_2`, y]);
  }
  return out;
}
