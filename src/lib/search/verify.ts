/**
 * Quote verification: every highlight the model proposes must be found in the judgment text,
 * exactly (after normalisation) or near-exactly (token similarity ≥ threshold). The returned
 * `matchedText` is sliced from the source, so what we render is always the judgment's own words.
 */
import { normalize } from "../text";

export interface VerifiableElement {
  elementId: string;
  parentId: string | null;
  text: string;
}

export interface QuoteMatch {
  elementId: string;
  matchedText: string;
  similarity: number;
}

const FUZZY_THRESHOLD = 0.9;

/** Find `quote` in `text`; returns the original-text slice and similarity, or null. */
export function matchQuote(quote: string, text: string, threshold = FUZZY_THRESHOLD): { matchedText: string; similarity: number } | null {
  const full = normalize(quote).norm;
  // models sometimes wrap quotes in quotation marks or trailing dots: try as-is, then trimmed
  const trimmed = full.replace(/^["'.\s-]+|["'.\s-]+$/g, "");
  if (trimmed.length < 8) return null;
  const src = normalize(text);
  for (const q of full === trimmed ? [full] : [full, trimmed]) {
    const idx = src.norm.indexOf(q);
    if (idx >= 0) {
      return { matchedText: text.slice(src.map[idx], src.map[idx + q.length - 1] + 1), similarity: 1 };
    }
  }
  return fuzzyMatch(trimmed, src, text, threshold);
}

interface Tok {
  w: string;
  start: number; // index in normalised string
  end: number; // exclusive
}

function toks(norm: string): Tok[] {
  const out: Tok[] = [];
  for (const m of norm.matchAll(/[a-z0-9]+(?:'[a-z0-9]+)*/g)) out.push({ w: m[0], start: m.index!, end: m.index! + m[0].length });
  return out;
}

function lcs(a: string[], b: string[]): number {
  const dp = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[b.length];
}

function fuzzyMatch(
  qNorm: string,
  src: { norm: string; map: number[] },
  original: string,
  threshold: number,
): { matchedText: string; similarity: number } | null {
  const qt = toks(qNorm).map((t) => t.w);
  if (qt.length < 3) return null;
  const st = toks(src.norm);
  const qSet = new Set(qt);
  let best = { sim: 0, from: -1, to: -1 };
  const n = qt.length;
  for (let i = 0; i < st.length; i++) {
    // cheap anchor: window must start on a quote word
    if (!qSet.has(st[i].w)) continue;
    for (let len = Math.max(1, n - 2); len <= n + 2 && i + len <= st.length; len++) {
      const win = st.slice(i, i + len).map((t) => t.w);
      const sim = (2 * lcs(qt, win)) / (n + len);
      if (sim > best.sim) best = { sim, from: i, to: i + len - 1 };
    }
  }
  if (best.sim < threshold) return null;
  const a = src.map[st[best.from].start];
  const b = src.map[st[best.to].end - 1] + 1;
  return { matchedText: original.slice(a, b), similarity: Math.round(best.sim * 1000) / 1000 };
}

/**
 * Verify a quote claimed to be in `claimedId`. Searches the claimed element, then every provided
 * element, and anchors the highlight on the smallest element that contains the quote.
 */
export function verifyQuote(quote: string, claimedId: string, elements: VerifiableElement[]): QuoteMatch | null {
  const byId = new Map(elements.map((e) => [e.elementId, e]));
  const depth = (id: string) => {
    let d = 0;
    for (let e = byId.get(id); e?.parentId; e = byId.get(e.parentId)) d++;
    return d;
  };

  // exact matches anywhere → deepest (smallest) element wins
  const exact = elements
    .map((e) => ({ e, m: matchQuote(quote, e.text, 1) }))
    .filter((x): x is { e: VerifiableElement; m: NonNullable<typeof x.m> } => x.m !== null)
    .sort((a, b) => depth(b.e.elementId) - depth(a.e.elementId) || a.e.text.length - b.e.text.length);
  if (exact[0]) return { elementId: exact[0].e.elementId, ...exact[0].m };

  // fuzzy: claimed element first, then its top-level ancestor
  const tryIds = [claimedId];
  for (let e = byId.get(claimedId); e?.parentId; e = byId.get(e.parentId)) tryIds.push(e.parentId);
  for (const id of tryIds) {
    const el = byId.get(id);
    if (!el) continue;
    const m = matchQuote(quote, el.text);
    if (m) return { elementId: id, ...m };
  }
  return null;
}
