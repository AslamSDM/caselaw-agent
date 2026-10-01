"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Candidate, CaseResult, DateSource, SearchEvent, SearchStats, WebMention } from "@/lib/search/types";

/** undefined = infer from query, null = ignore dates, object = explicit range (YYYY / YYYY-MM-DD) */
export type DateInput = { from?: string; to?: string } | null | undefined;
import { courtInfo } from "@/lib/courts";
import { AREAS, areaLabel } from "@/lib/areas";
import { formatRange, type DateRange } from "@/lib/dates";

type Rejected = { uri: string; name: string; score: number; reason: string };

interface State {
  running: boolean;
  searchId: number | null;
  log: string[];
  variants: string[];
  dates: DateRange | null;
  dateSource: DateSource;
  datesReason: string | null;
  webTerms: string[];
  candidates: Candidate[];
  results: CaseResult[];
  rejected: Rejected[];
  mentions: WebMention[];
  stats: SearchStats | null;
  error: string | null;
}

const EMPTY: State = {
  running: false,
  searchId: null,
  log: [],
  variants: [],
  dates: null,
  dateSource: "none",
  datesReason: null,
  webTerms: [],
  candidates: [],
  results: [],
  rejected: [],
  mentions: [],
  stats: null,
  error: null,
};

const EXAMPLES = [
  "landlord liability for damp and mould in social housing",
  "electric vehicle battery fire product liability",
  "unfair contract terms in gym membership agreements",
];

export function SearchClient({
  initialQuery,
  initialAreas = [],
  initialDates,
}: {
  initialQuery?: string;
  initialAreas?: string[];
  initialDates?: DateInput;
}) {
  const [query, setQuery] = useState(initialQuery ?? "");
  const [areas, setAreas] = useState<string[]>(initialAreas);
  const [fromInput, setFromInput] = useState(initialDates?.from ?? "");
  const [toInput, setToInput] = useState(initialDates?.to ?? "");
  /** explicit ranges come from the inputs; "off" = user dismissed the query's inferred range */
  const [datesOff, setDatesOff] = useState(initialDates === null);
  const dateInput = (): DateInput =>
    fromInput.trim() || toInput.trim() ? { from: fromInput.trim() || undefined, to: toInput.trim() || undefined } : datesOff ? null : undefined;
  const [facet, setFacet] = useState<string | null>(null);
  const [s, setS] = useState<State>(EMPTY);
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(async (q: string, areaFilter: string[], dates: DateInput) => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setS({ ...EMPTY, running: true, log: ["Starting…"] });
    setFacet(null);
    const url = new URL(window.location.href);
    url.searchParams.set("q", q);
    if (areaFilter.length) url.searchParams.set("areas", areaFilter.join(","));
    else url.searchParams.delete("areas");
    for (const k of ["from", "to", "nodates"]) url.searchParams.delete(k);
    if (dates === null) url.searchParams.set("nodates", "1");
    else if (dates) {
      if (dates.from) url.searchParams.set("from", dates.from);
      if (dates.to) url.searchParams.set("to", dates.to);
    }
    window.history.replaceState(null, "", url);

    const apply = (e: SearchEvent) =>
      setS((prev) => {
        switch (e.type) {
          case "search":
            return { ...prev, searchId: e.searchId };
          case "status":
            return { ...prev, log: [...prev.log, e.message] };
          case "expanded":
            return { ...prev, variants: e.variants, dates: e.dates, dateSource: e.dateSource, datesReason: e.datesReason, log: [...prev.log, `Searching ${e.variants.length} keyword variants`] };
          case "web":
            return {
              ...prev,
              webTerms: e.terms,
              log: [...prev.log, `Web: ${e.sources} sources → ${e.terms.length} terms, ${e.ncns.length} citations, ${e.variants.length} extra variants`],
            };
          case "candidates":
            return { ...prev, candidates: e.candidates, log: [...prev.log, `${e.candidates.length} candidate judgments`] };
          case "result":
            return { ...prev, results: [...prev.results, e.result].sort((a, b) => b.score - a.score) };
          case "rejected":
            return { ...prev, rejected: [...prev.rejected, e].sort((a, b) => b.score - a.score) };
          case "web_mentions":
            return { ...prev, mentions: e.mentions };
          case "done":
            return { ...prev, running: false, stats: e.stats };
          case "error":
            return { ...prev, running: false, error: e.message };
        }
      });

    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q, areas: areaFilter.length ? areaFilter : undefined, dates }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        setS((p) => ({ ...p, running: false, error: err.error ?? "Search failed" }));
        return;
      }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) apply(JSON.parse(line));
      }
      setS((p) => ({ ...p, running: false }));
    } catch (err) {
      if (ac.signal.aborted) return;
      setS((p) => ({ ...p, running: false, error: err instanceof Error ? err.message : String(err) }));
    }
  }, []);

  useEffect(() => {
    if (initialQuery) run(initialQuery, initialAreas, initialDates);
    return () => abortRef.current?.abort();
    // initialAreas is a fresh array each render; only re-run when the query changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuery, run]);

  const facetCounts = new Map<string, number>();
  for (const r of s.results) for (const a of r.areas) facetCounts.set(a, (facetCounts.get(a) ?? 0) + 1);
  const visible = facet ? s.results.filter((r) => r.areas.includes(facet)) : s.results;

  const started = s.running || s.stats || s.error;
  const noMatches = !s.running && s.stats && s.results.length === 0;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (query.trim().length >= 2) run(query.trim(), areas, dateInput());
        }}
        className="flex gap-2"
      >
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setDatesOff(false); // "ignore dates" applied to the previous question only
          }}
          placeholder="Describe what you're looking for, e.g. “jaguar battery leak”"
          className="flex-1 rounded-lg border border-border bg-surface px-4 py-3 text-base outline-none focus:border-accent"
          autoFocus
        />
        <button
          type="submit"
          disabled={s.running}
          className="rounded-lg bg-accent px-5 py-3 font-medium text-white disabled:opacity-50 dark:text-black"
        >
          {s.running ? "Searching…" : "Search"}
        </button>
      </form>

      <details className="mt-3 text-sm" open={areas.length > 0}>
        <summary className="cursor-pointer text-muted">
          Area of law{areas.length > 0 && `: ${areas.map(areaLabel).join(", ")}`}
        </summary>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {AREAS.map((a) => {
            const on = areas.includes(a.id);
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => setAreas((prev) => (on ? prev.filter((x) => x !== a.id) : [...prev, a.id]))}
                className={`rounded-full border px-2.5 py-0.5 text-xs ${on ? "border-accent bg-accent text-white dark:text-black" : "border-border hover:border-accent"}`}
              >
                {a.label}
              </button>
            );
          })}
          {areas.length > 0 && (
            <button type="button" onClick={() => setAreas([])} className="px-2 text-xs text-muted underline">
              clear
            </button>
          )}
        </div>
      </details>

      <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted">Judgment dates</span>
        <input
          value={fromInput}
          onChange={(e) => setFromInput(e.target.value)}
          placeholder="from (YYYY)"
          aria-label="From date: year, YYYY-MM or YYYY-MM-DD"
          className="w-32 rounded border border-border bg-surface px-2 py-1 text-xs"
        />
        <span className="text-muted">–</span>
        <input
          value={toInput}
          onChange={(e) => setToInput(e.target.value)}
          placeholder="to (YYYY)"
          aria-label="To date: year, YYYY-MM or YYYY-MM-DD"
          className="w-32 rounded border border-border bg-surface px-2 py-1 text-xs"
        />
        {!fromInput && !toInput && (
          <span className="text-xs text-muted">{datesOff ? "ignoring dates in the question" : "or say it in the question, e.g. “since 2020”"}</span>
        )}
        {(fromInput || toInput || datesOff) && (
          <button
            type="button"
            onClick={() => { setFromInput(""); setToInput(""); setDatesOff(false); }}
            className="text-xs text-muted underline"
          >
            reset
          </button>
        )}
      </div>

      {!started && (
        <div className="mt-6 text-sm text-muted">
          <p>Searches UK judgments on The National Archives&apos; Find Case Law, reads the candidates and highlights the passages that matter.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {EXAMPLES.map((ex) => (
              <button key={ex} onClick={() => { setQuery(ex); run(ex, areas, dateInput()); }} className="rounded-full border border-border px-3 py-1 hover:border-accent">
                {ex}
              </button>
            ))}
          </div>
        </div>
      )}

      {started && (
        <section className="mt-6 rounded-lg border border-border bg-surface p-4 text-sm">
          <div className="flex items-center gap-2 text-muted">
            {s.running && <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-accent" />}
            <span>{s.log.at(-1)}</span>
          </div>
          {s.variants.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {s.variants.map((v) => (
                <span key={v} className="rounded bg-background px-2 py-0.5 font-mono text-xs">{v}</span>
              ))}
            </div>
          )}
          {s.dates && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded-full border border-accent px-2.5 py-0.5">
                Dates: {formatRange(s.dates)}
                <span className="text-muted">
                  {s.dateSource === "query" ? ` · from your question${s.datesReason ? ` (“${s.datesReason}”)` : ""}` : " · set by you"}
                </span>
              </span>
              {s.dateSource === "query" && !s.running && (
                <button
                  type="button"
                  onClick={() => { setDatesOff(true); run(query.trim(), areas, null); }}
                  className="text-muted underline"
                >
                  search all dates instead
                </button>
              )}
            </div>
          )}
          {s.webTerms.length > 0 && (
            <p className="mt-2 text-xs text-muted">Web vocabulary: {s.webTerms.join(", ")}</p>
          )}
          {s.stats && (
            <p className="mt-2 text-xs text-muted">
              {(s.stats.ms / 1000).toFixed(1)}s total
              {s.stats.firstResultMs != null && ` · first result ${(s.stats.firstResultMs / 1000).toFixed(1)}s`} · {s.stats.tnaRequests} TNA requests ·{" "}
              {s.stats.casesFromCache} cached / {s.stats.casesFetched} fetched · {(s.stats.inputTokens / 1000).toFixed(1)}k in /{" "}
              {(s.stats.outputTokens / 1000).toFixed(1)}k out tokens · web: {s.stats.webEnrichment}
            </p>
          )}
          {s.error && <p className="mt-2 text-red-600">{s.error}</p>}
        </section>
      )}

      {facetCounts.size > 1 && (
        <div className="mt-6 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-muted">Filter:</span>
          <button onClick={() => setFacet(null)} className={`rounded-full border px-2.5 py-0.5 ${!facet ? "border-accent" : "border-border"}`}>
            All ({s.results.length})
          </button>
          {[...facetCounts.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([id, n]) => (
              <button
                key={id}
                onClick={() => setFacet(facet === id ? null : id)}
                className={`rounded-full border px-2.5 py-0.5 ${facet === id ? "border-accent bg-accent text-white dark:text-black" : "border-border hover:border-accent"}`}
              >
                {areaLabel(id)} ({n})
              </button>
            ))}
        </div>
      )}

      <div className="mt-4 space-y-4">
        {visible.map((r) => (
          <ResultCard key={r.uri} r={r} searchId={s.searchId} />
        ))}
      </div>

      {noMatches && (
        <section className="mt-6 rounded-lg border border-dashed border-border p-5">
          <h2 className="font-semibold">No strong matches</h2>
          <p className="mt-1 text-sm text-muted">
            None of the {s.candidates.length} candidate judgments substantively deals with this question. Closest candidates:
          </p>
        </section>
      )}

      {s.rejected.length > 0 && (
        <details className="mt-6" open={Boolean(noMatches)}>
          <summary className="cursor-pointer text-sm text-muted">
            {s.rejected.length} candidate{s.rejected.length === 1 ? "" : "s"} rejected
          </summary>
          <ul className="mt-3 space-y-2 text-sm">
            {s.rejected.slice(0, 10).map((r) => (
              <li key={r.uri} className="rounded border border-border p-3">
                <Link href={`/case/${r.uri}`} className="font-medium hover:underline">{r.name}</Link>
                <span className="ml-2 text-xs text-muted">score {r.score.toFixed(2)}</span>
                <p className="mt-1 text-muted">{r.reason}</p>
              </li>
            ))}
          </ul>
        </details>
      )}

      {s.mentions.length > 0 && (
        <section className="mt-6 text-sm">
          <h3 className="font-medium">Mentioned on the web, not found in TNA</h3>
          <ul className="mt-2 space-y-1 text-muted">
            {s.mentions.map((m) => (
              <li key={m.sourceUrl + m.name}>
                {m.name} {m.ncn && <span className="font-mono text-xs">{m.ncn}</span>} —{" "}
                <a href={m.sourceUrl} target="_blank" rel="noreferrer" className="underline">source</a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function ResultCard({ r, searchId }: { r: CaseResult; searchId: number | null }) {
  const court = courtInfo(r.court);
  const href = `/case/${r.uri}${searchId ? `?search=${searchId}` : ""}`;
  return (
    <article className="rounded-lg border border-border bg-surface p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link href={href} className="text-lg font-semibold leading-snug hover:underline">{r.name}</Link>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            {r.ncn && <span className="font-mono">{r.ncn}</span>}
            <span>{court.label}</span>
            <span className="rounded border border-border px-1.5">{court.tier}</span>
            {r.date && <span>{r.date}</span>}
            {r.anonymised && <span className="rounded bg-background px-1.5">anonymised</span>}
          </div>
          {r.areas.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {r.areas.map((a) => (
                <span key={a} className="rounded bg-background px-1.5 py-0.5 text-[11px] text-muted">{areaLabel(a)}</span>
              ))}
            </div>
          )}
        </div>
        <div className="shrink-0 text-right">
          <div className="text-xl font-semibold tabular-nums">{Math.round(r.score * 100)}</div>
          <div className="text-[10px] uppercase tracking-wide text-muted">relevance</div>
        </div>
      </div>
      <p className="mt-3 text-sm">{r.summary}</p>
      <ul className="mt-3 space-y-2">
        {r.highlights.slice(0, 4).map((h, i) => (
          <li key={i} className="text-sm">
            <Link href={`${href}#${h.elementId}`} className="group block rounded border-l-2 border-accent bg-para-tint px-3 py-2">
              <span className="mr-2 font-mono text-xs text-muted">{labelFor(h.elementId)}</span>
              {h.kind === "quoted_clause" && <span className="mr-2 rounded bg-clause-hl px-1.5 text-xs">clause</span>}
              <span className="font-serif">“{h.quote}”</span>
              <span className="mt-1 block text-xs text-muted">{h.reason}</span>
            </Link>
          </li>
        ))}
      </ul>
      {r.highlights.length > 4 && <p className="mt-2 text-xs text-muted">+{r.highlights.length - 4} more highlights</p>}
    </article>
  );
}

function labelFor(elementId: string) {
  const m = elementId.match(/^para_(\d+)/);
  return m ? `¶${m[1]}${elementId.includes("__quote") ? " · quote" : elementId.includes("__") ? " · sub" : ""}` : elementId;
}
