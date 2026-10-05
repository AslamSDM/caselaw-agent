"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flashElement } from "./hash-flash";

interface Match {
  range: Range;
  /** nearest element with an id (the paragraph / passage anchor) */
  anchor: HTMLElement | null;
}

interface ParagraphHit {
  anchorId: string;
  label: string;
  snippet: { before: string; hit: string; after: string };
  first: number;
  count: number;
}

const supportsHighlights = () => typeof CSS !== "undefined" && "highlights" in CSS;

/** "¶87" from an anchor id or the paragraph's leading number; else a short id. */
function labelFor(el: HTMLElement | null): string {
  if (!el) return "";
  const fromId = el.id.match(/^para_(\d+)/)?.[1];
  if (fromId) return `¶${fromId}`;
  const lead = el.textContent?.trim().match(/^(\(?\d+[.)]?)\s/)?.[1];
  return lead ? `¶${lead.replace(/[().]/g, "")}` : el.id.replace(/_/g, " ");
}

/**
 * Find in judgment: highlights every match of the typed words/phrase in the judgment text,
 * steps through them, and lists matching paragraphs. Uses the CSS Custom Highlight API so the
 * judgment's DOM is never modified.
 */
export function JudgmentFind({ containerId }: { containerId: string }) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Match[]>([]);
  const [current, setCurrent] = useState(-1);
  const [showList, setShowList] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  /** whether Enter has moved to a match since the query last changed */
  const navigated = useRef(false);

  // search the rendered judgment text (debounced)
  useEffect(() => {
    const q = query.trim().toLowerCase().replace(/\s+/g, " ");
    const t = window.setTimeout(() => {
      const root = document.getElementById(containerId);
      if (!root || q.length < 2) {
        setMatches([]);
        setCurrent(-1);
        return;
      }
      // join text nodes so phrases that span inline markup (links, emphasis) still match
      const nodes: { node: Text; start: number }[] = [];
      let full = "";
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        nodes.push({ node: n as Text, start: full.length });
        full += (n as Text).data;
      }
      const lower = full.toLowerCase().replace(/\s/g, " ");
      const locate = (pos: number) => {
        let lo = 0;
        let hi = nodes.length - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (nodes[mid].start <= pos) lo = mid;
          else hi = mid - 1;
        }
        return { node: nodes[lo].node, offset: pos - nodes[lo].start };
      };
      const found: Match[] = [];
      for (let i = lower.indexOf(q); i >= 0 && found.length < 2000; i = lower.indexOf(q, i + q.length)) {
        const a = locate(i);
        const b = locate(i + q.length - 1);
        const range = document.createRange();
        range.setStart(a.node, a.offset);
        range.setEnd(b.node, b.offset + 1);
        found.push({ range, anchor: a.node.parentElement?.closest<HTMLElement>("[id]") ?? null });
      }
      setMatches(found);
      setCurrent(found.length ? 0 : -1);
      navigated.current = false;
    }, 150);
    return () => window.clearTimeout(t);
  }, [query, containerId]);

  // paint all matches + the current one
  useEffect(() => {
    if (!supportsHighlights()) return;
    const reg = CSS.highlights;
    if (!matches.length) {
      reg.delete("find");
      reg.delete("find-current");
      return;
    }
    reg.set("find", new Highlight(...matches.map((m) => m.range)));
    if (current >= 0) reg.set("find-current", new Highlight(matches[current].range));
    return () => {
      reg.delete("find");
      reg.delete("find-current");
    };
  }, [matches, current]);

  const jump = useCallback(
    (i: number) => {
      if (!matches.length) return;
      const n = (i + matches.length) % matches.length;
      setCurrent(n);
      navigated.current = true;
      const m = matches[n];
      const target = (m.range.startContainer.parentElement ?? m.anchor) as HTMLElement | null;
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
      if (m.anchor?.id) flashElement(m.anchor.id, false);
    },
    [matches],
  );

  // "/" focuses the box (unless typing elsewhere)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (e.key === "/" && tag !== "INPUT" && tag !== "TEXTAREA") {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const paragraphs = useMemo<ParagraphHit[]>(() => {
    const byAnchor = new Map<string, ParagraphHit>();
    matches.forEach((m, i) => {
      const id = m.anchor?.id ?? `match-${i}`;
      const hit = byAnchor.get(id);
      if (hit) {
        hit.count++;
        return;
      }
      const text = m.range.startContainer.textContent ?? "";
      const s = m.range.startOffset;
      const len = m.range.toString().length;
      byAnchor.set(id, {
        anchorId: id,
        label: labelFor(m.anchor),
        snippet: {
          before: (s > 50 ? "…" : "") + text.slice(Math.max(0, s - 50), s),
          hit: text.slice(s, s + len) || m.range.toString(),
          after: text.slice(s + len, s + len + 70) + (text.length > s + len + 70 ? "…" : ""),
        },
        first: i,
        count: 1,
      });
    });
    return [...byAnchor.values()];
  }, [matches]);

  const q = query.trim();
  return (
    <div className="sticky top-14 z-10 -mx-1 mb-6 rounded-lg border border-border bg-surface/95 p-2 text-sm shadow-sm backdrop-blur">
      <div className="flex items-center gap-2">
        <label htmlFor="judgment-find" className="sr-only">
          Find in judgment
        </label>
        <input
          ref={input}
          id="judgment-find"
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setShowList(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              // first Enter shows the first match; later ones step forward (Shift: back)
              jump(!navigated.current ? current : e.shiftKey ? current - 1 : current + 1);
              navigated.current = true;
            } else if (e.key === "Escape") {
              setQuery("");
              input.current?.blur();
            }
          }}
          placeholder="Find in judgment (press /) — words or a phrase"
          className="min-w-0 flex-1 rounded border border-border bg-background px-3 py-1.5 outline-none focus:border-accent"
        />
        <span className="w-20 shrink-0 text-center text-xs tabular-nums text-muted" aria-live="polite">
          {q.length < 2 ? "" : matches.length ? `${current + 1} / ${matches.length}` : "no matches"}
        </span>
        <button type="button" aria-label="Previous match" disabled={!matches.length} onClick={() => jump(current - 1)} className="rounded border border-border px-2 py-1 disabled:opacity-40 hover:border-accent">
          ↑
        </button>
        <button type="button" aria-label="Next match" disabled={!matches.length} onClick={() => jump(current + 1)} className="rounded border border-border px-2 py-1 disabled:opacity-40 hover:border-accent">
          ↓
        </button>
        {paragraphs.length > 0 && (
          <button
            type="button"
            aria-expanded={showList}
            onClick={() => setShowList((x) => !x)}
            className="shrink-0 rounded border border-border px-2 py-1 text-xs text-muted hover:border-accent"
          >
            {paragraphs.length} ¶ {showList ? "▴" : "▾"}
          </button>
        )}
      </div>
      {showList && paragraphs.length > 0 && (
        <ol className="mt-2 max-h-72 space-y-1 overflow-y-auto border-t border-border pt-2">
          {paragraphs.map((p) => (
            <li key={p.anchorId}>
              <button
                type="button"
                onClick={() => jump(p.first)}
                className="flex w-full gap-2 rounded px-2 py-1 text-left hover:bg-background"
              >
                <span className="w-14 shrink-0 font-mono text-xs text-accent">{p.label}</span>
                <span className="min-w-0 flex-1 text-xs text-muted">
                  {p.snippet.before}
                  <mark className="rounded bg-quote-hl px-0.5 text-foreground">{p.snippet.hit}</mark>
                  {p.snippet.after}
                </span>
                {p.count > 1 && <span className="shrink-0 text-[11px] text-muted">×{p.count}</span>}
              </button>
            </li>
          ))}
        </ol>
      )}
      {q.length >= 2 && !supportsHighlights() && matches.length > 0 && (
        <p className="mt-1 text-[11px] text-muted">Your browser can’t paint highlights; use the list or arrows to jump.</p>
      )}
    </div>
  );
}
