import { TNA_BASE } from "./parser";
import { tnaDateParams, type DateRange } from "../dates";

export interface TnaSearchParams {
  query?: string;
  party?: string;
  judge?: string;
  court?: string[];
  dates?: DateRange | null;
  perPage?: number;
  page?: number;
  /** "relevance" is undocumented but used by TNA's own "Most relevant" sort; falls back to date */
  order?: "relevance" | "-date";
}

export function searchUrl(p: TnaSearchParams): string {
  const qs = new URLSearchParams();
  if (p.query) qs.set("query", p.query);
  if (p.party) qs.set("party", p.party);
  if (p.judge) qs.set("judge", p.judge);
  for (const c of p.court ?? []) qs.append("court", c);
  for (const [k, v] of tnaDateParams(p.dates)) qs.set(k, v);
  if (p.order === "relevance") qs.set("order", "relevance");
  qs.set("per_page", String(Math.min(p.perPage ?? 10, 50))); // TNA caps pages at 50
  if (p.page && p.page > 1) qs.set("page", String(p.page));
  return `${TNA_BASE}/atom.xml?${qs}`;
}
