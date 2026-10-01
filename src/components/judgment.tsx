import type { ReactNode } from "react";
import type { ElementRow } from "@/lib/cases/store";

export interface HighlightMark {
  elementId: string;
  kind: string;
  quote: string;
}

interface Props {
  elements: ElementRow[];
  highlights: HighlightMark[];
  terms: string[];
}

/** Renders a judgment's element tree with verified quote highlights and query-term underlines. */
export function Judgment({ elements, highlights, terms }: Props) {
  const children = new Map<string, ElementRow[]>();
  for (const e of elements) {
    if (!e.parentId) continue;
    const list = children.get(e.parentId) ?? [];
    list.push(e);
    children.set(e.parentId, list);
  }
  const byId = new Map(elements.map((e) => [e.elementId, e]));
  const hlByEl = new Map<string, HighlightMark[]>();
  const tinted = new Set<string>();
  for (const h of highlights) {
    hlByEl.set(h.elementId, [...(hlByEl.get(h.elementId) ?? []), h]);
    for (let e = byId.get(h.elementId); e; e = e.parentId ? byId.get(e.parentId) : undefined) tinted.add(e.elementId);
  }
  const termRe = buildTermRegex(terms);

  const render = (e: ElementRow): ReactNode => {
    const marks = hlByEl.get(e.elementId) ?? [];
    const ownTexts = e.parts.filter((p): p is { t: string } => "t" in p).map((p) => p.t);
    // a verified quote spanning several parts can't be marked inline → outline the element instead
    const unplaced = marks.filter((m) => !ownTexts.some((t) => t.includes(m.quote)));
    const body = e.parts.map((p, i) =>
      "t" in p ? (
        <span key={i} className="whitespace-pre-line">{markText(p.t, marks, termRe)}</span>
      ) : byId.get(p.c) ? (
        <div key={i}>{render(byId.get(p.c)!)}</div>
      ) : null,
    );
    const outline = unplaced.length ? "ring-2 ring-[var(--quote-hl)]" : "";

    if (e.kind === "heading") {
      return (
        <h3 id={e.elementId} key={e.elementId} className="mt-8 mb-2 font-sans text-base font-semibold">
          {body}
        </h3>
      );
    }
    if (e.kind === "quote_block") {
      const clause = marks.some((m) => m.kind === "quoted_clause");
      return (
        <blockquote
          id={e.elementId}
          className={`my-2 ml-6 border-l-2 pl-4 ${clause ? "border-clause-border" : "border-border"} ${outline}`}
        >
          {clause && <span className="mb-1 inline-block rounded bg-clause-hl px-1.5 font-sans text-[10px] uppercase tracking-wide">clause</span>}
          {body}
        </blockquote>
      );
    }
    const isTop = !e.parentId;
    return (
      <div
        id={e.elementId}
        key={e.elementId}
        className={`${isTop ? "my-3 rounded px-3 py-1" : "my-1 ml-6"} ${isTop && tinted.has(e.elementId) ? "bg-para-tint" : ""} ${outline} flex gap-3`}
      >
        {e.num && <span className="w-10 shrink-0 select-none pt-0.5 text-right font-sans text-xs text-muted">{e.num}</span>}
        <div className="min-w-0 flex-1">{body}</div>
      </div>
    );
  };

  return (
    <div className="font-serif text-[17px] leading-relaxed">
      {elements.filter((e) => !e.parentId).map((e) => <div key={e.elementId}>{render(e)}</div>)}
    </div>
  );
}

function buildTermRegex(terms: string[]): RegExp | null {
  const words = [...new Set(terms.flatMap((t) => t.toLowerCase().replace(/["()]/g, "").split(/\s+/)))]
    .filter((w) => w.length > 3 && !STOP.has(w))
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return words.length ? new RegExp(`\\b(${words.join("|")})\\w*`, "gi") : null;
}

const STOP = new Set(["with", "from", "that", "this", "which", "their", "there", "case", "cases", "court", "judgment"]);

function markText(text: string, marks: HighlightMark[], termRe: RegExp | null): ReactNode[] {
  // quote ranges first (verbatim, as verified), then term underlines in the rest
  const ranges: { a: number; b: number; kind: string }[] = [];
  for (const m of marks) {
    const i = text.indexOf(m.quote);
    if (i >= 0) ranges.push({ a: i, b: i + m.quote.length, kind: m.kind });
  }
  ranges.sort((x, y) => x.a - y.a);
  const out: ReactNode[] = [];
  let pos = 0;
  ranges.forEach((r, k) => {
    if (r.a < pos) return;
    out.push(...underline(text.slice(pos, r.a), termRe, `u${k}`));
    out.push(
      <mark key={`m${k}`} className={r.kind === "quoted_clause" ? "hl-clause" : "hl-quote"}>
        {text.slice(r.a, r.b)}
      </mark>,
    );
    pos = r.b;
  });
  out.push(...underline(text.slice(pos), termRe, "tail"));
  return out;
}

function underline(text: string, re: RegExp | null, keyPrefix: string): ReactNode[] {
  if (!re || !text) return [text];
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    out.push(text.slice(last, m.index));
    out.push(<span key={`${keyPrefix}-${m.index}`} className="term-underline">{m[0]}</span>);
    last = m.index! + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}
