/**
 * Candidate fusion: reciprocal-rank style scoring over TNA result lists (ordered by TNA's
 * keyword relevance). Each list's contribution is also scaled by source weight and by query
 * specificity — a list with few total hits says more about each hit than one with thousands.
 */
import type { Candidate, CandidateList, CandidateSourceKind } from "./types";

export const SOURCE_WEIGHT: Record<CandidateSourceKind, number> = {
  ncn: 3,
  party: 1.5,
  keyword: 1,
  "web-keyword": 0.8,
  "local-vector": 1.3,
  "local-fts": 1,
};

/** lists whose weight doesn't depend on hit count (exact citations; semantic top-k always "hits") */
const NO_SPECIFICITY = new Set<CandidateSourceKind>(["ncn", "local-vector"]);

const K = 10;

export function specificity(estimatedTotal: number): number {
  if (estimatedTotal <= 0) return 0;
  return 1 / (1 + Math.log10(Math.max(1, estimatedTotal / 10)));
}

export function fuseCandidates(lists: CandidateList[], limit = 10): Candidate[] {
  const byUri = new Map<string, Candidate>();
  for (const list of lists) {
    const w = SOURCE_WEIGHT[list.source] * (list.weight ?? 1) * (NO_SPECIFICITY.has(list.source) ? 1 : specificity(list.estimatedTotal));
    list.entries.forEach((e, rank) => {
      const c = byUri.get(e.uri) ?? { ...e, score: 0, matchedBy: [] };
      c.score += (w * K) / (K + rank);
      if (!c.matchedBy.includes(list.label)) c.matchedBy.push(list.label);
      c.ncn ??= e.ncn;
      c.court ??= e.court;
      c.date ??= e.date;
      if (!c.name && e.name) c.name = e.name;
      byUri.set(e.uri, c);
    });
  }
  // agreement bonus: several independent variants hitting the same case
  for (const c of byUri.values()) c.score *= 1 + 0.25 * (c.matchedBy.length - 1);
  return [...byUri.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
