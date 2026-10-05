/**
 * Paragraph citations for chat answers (runs in the browser).
 *
 * The agent cites paragraphs as markdown links to the judgment viewer, e.g.
 * [Mohamud v WM Morrison, ¶44](/case/uksc/2016/11#para_44). This module collects those links,
 * matches them with the paragraphs the agent actually read (read_case tool outputs), and checks
 * every quotation in the answer word-for-word against that text.
 */

export interface SourceParagraph {
  href: string;
  caseName: string;
  label: string;
  text: string;
}

export interface CitedParagraph {
  /** the paragraph's real link (corrected when the answer used a wrong anchor) */
  href: string;
  /** link text the answer used */
  label: string;
  /** the paragraph, if the agent read it in this conversation */
  source: SourceParagraph | null;
}

export interface QuoteCheck {
  quote: string;
  found: boolean;
}

interface ReadCaseOutput {
  name?: string;
  paragraphs?: { link: string; label?: string; num?: string | null; id: string; text: string }[];
}

/** Paragraphs returned by read_case calls in these message parts. */
export function sourcesFromParts(parts: { type: string; state?: string; output?: unknown }[]): SourceParagraph[] {
  const out: SourceParagraph[] = [];
  for (const p of parts) {
    if (p.type !== "tool-read_case" || p.state !== "output-available") continue;
    const o = p.output as ReadCaseOutput | undefined;
    for (const para of o?.paragraphs ?? []) {
      out.push({ href: para.link, caseName: o?.name ?? "", label: para.label ?? para.num ?? para.id, text: para.text });
    }
  }
  return out;
}

const paraNumber = (s: string) => s.match(/¶\s*(\d+)/)?.[1] ?? s.match(/#para_(\d+)$/)?.[1] ?? null;

/**
 * The paragraph a citation link refers to. Exact link first; otherwise the same judgment and
 * paragraph number (models sometimes build "#para_87" themselves, but some judgments anchor
 * paragraphs as "#p_183" with number 87).
 */
export function resolveCitation(href: string, label: string, sources: SourceParagraph[]): SourceParagraph | null {
  const exact = sources.find((s) => s.href === href);
  if (exact) return exact;
  const path = href.split("#")[0];
  const n = paraNumber(label) ?? paraNumber(href);
  if (!n) return null;
  return sources.find((s) => s.href.split("#")[0] === path && paraNumber(s.label) === n) ?? null;
}

/** Links into the judgment viewer that point at a paragraph, in order of first use. */
export function citedParagraphs(text: string, sources: SourceParagraph[]): CitedParagraph[] {
  const seen = new Set<string>();
  const out: CitedParagraph[] = [];
  for (const m of text.matchAll(/\[([^\]]+)\]\((\/case\/[^)\s]+#[^)\s]+)\)/g)) {
    const source = resolveCitation(m[2], m[1], sources);
    const href = source?.href ?? m[2];
    if (seen.has(href)) continue;
    seen.add(href);
    out.push({ href, label: m[1], source });
  }
  return out;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[‘’‛`]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

/** Quotations of 6+ words in the answer, each checked against the paragraphs read. */
export function checkQuotes(text: string, sources: SourceParagraph[]): QuoteCheck[] {
  const haystack = norm(sources.map((s) => s.text).join("\n"));
  const quotes = new Set<string>();
  // pair quote marks in order (short quotes included) so a skipped short quote's closing mark is
  // never taken as the next opening one; spans across lines or links are not quotations
  for (const m of text.matchAll(/[“"]([^”"]*)[”"]/g)) {
    const q = m[1].trim();
    if (/\n|\]\(/.test(q)) continue;
    if (q.split(/\s+/).length >= 6) quotes.add(q);
  }
  return [...quotes].map((quote) => {
    // an ellipsis joins separate passages: each piece must appear
    const pieces = quote
      .split(/\s*(?:\.\.\.|…|\[\.\.\.\])\s*/)
      .map((x) => norm(x).replace(/^[\s,.;:]+|[\s,.;:]+$/g, ""))
      .filter((x) => x.length >= 8);
    return { quote, found: pieces.length > 0 && pieces.every((p) => haystack.includes(p)) };
  });
}

/** "¶87" from a paragraph number like "87." or "(87)", else from an id like para_87. */
export function paragraphLabel(num: string | null | undefined, id: string, index: number): string {
  const n = num?.replace(/[().\s]/g, "");
  if (n) return `¶${n}`;
  const fromId = id.match(/^para_(\d+)$/)?.[1];
  return fromId ? `¶${fromId}` : `passage ${index + 1}`;
}
