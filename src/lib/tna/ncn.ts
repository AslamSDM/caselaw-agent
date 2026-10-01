/**
 * Neutral citation helpers. `[2016] EWHC 52 (Ch)` → `ewhc/ch/2016/52`, `[2015] EWCA Civ 290` →
 * `ewca/civ/2015/290`, `[2026] EWFC 178 (B)` → `ewfc/b/2026/178`.
 */
export const NCN_REGEX =
  /\[(\d{4})\]\s+(UKSC|UKPC|UKHL|EWCA|EWHC|EWCOP|EWFC|UKUT|UKFTT|UKEAT|UKIPTrib|EAT|UKAIT|UKSIAC|EWCC|EWCR)\s+(?:(Civ|Crim)\s+)?(\d+)(?:\s*\(([A-Za-z]+)\))?/g;

export function extractNcns(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(NCN_REGEX)) out.add(normalizeNcn(m[0]));
  return [...out];
}

export function normalizeNcn(ncn: string): string {
  return ncn.replace(/\s+/g, " ").replace(/\s*\(/, " (").trim();
}

export function ncnToUri(ncn: string): string | null {
  const m = new RegExp(NCN_REGEX.source).exec(ncn);
  if (!m) return null;
  const [, year, court, division, num, suffix] = m;
  const parts = [court.toLowerCase()];
  if (division) parts.push(division.toLowerCase());
  if (suffix) parts.push(suffix.toLowerCase());
  return [...parts, year, num].join("/");
}
