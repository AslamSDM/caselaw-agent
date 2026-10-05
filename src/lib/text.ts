/**
 * Text normalisation shared by quote verification, highlighting and search.
 *
 * `normalize` folds curly quotes, dashes, ellipses and whitespace, lowercases, and keeps a map from
 * each normalised character back to its index in the original string, so a match found in the
 * normalised text can be sliced out of the original verbatim.
 */

const CHAR_MAP: Record<string, string> = {
  "‘": "'", "’": "'", "‚": "'", "‛": "'", "′": "'", "`": "'",
  "“": '"', "”": '"', "„": '"', "‟": '"', "″": '"', "«": '"', "»": '"',
  "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-", "―": "-", "−": "-",
  "…": "...",
  "ﬁ": "fi", "ﬂ": "fl",
};

export interface Normalized {
  norm: string;
  /** map[i] = index in the original string of normalised char i */
  map: number[];
}

export function normalize(input: string): Normalized {
  const out: string[] = [];
  const map: number[] = [];
  let pendingSpace = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (/\s/.test(ch) || ch === " ") {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) {
      out.push(" ");
      map.push(i);
      pendingSpace = false;
    }
    const rep = (CHAR_MAP[ch] ?? ch).toLowerCase();
    for (const r of rep) {
      out.push(r);
      map.push(i);
    }
  }
  return { norm: out.join(""), map };
}

export function normalizeString(s: string): string {
  return normalize(s).norm;
}

/** Collapse whitespace but keep single newlines between blocks. */
export function tidyWhitespace(s: string): string {
  return s
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

export function tokenize(s: string): string[] {
  return normalizeString(s)
    .split(/[^a-z0-9']+/)
    .filter(Boolean);
}

/** OR of terms for websearch_to_tsquery; multi-word terms become quoted phrases. */
export function ftsQueryString(terms: string[]): string {
  return terms
    .map((t) => t.replace(/["()]/g, " ").trim())
    .filter((t) => t.length > 1)
    .map((t) => (t.includes(" ") ? `"${t}"` : t))
    .join(" OR ");
}
