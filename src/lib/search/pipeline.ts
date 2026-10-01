/**
 * Search pipeline (plan §3): expand → TNA searches (+ local index, Firecrawl web hints in parallel) → fuse →
 * fetch/parse → paragraph retrieval → relevance pass → quote verification → cutoff.
 * Yields SearchEvents so the UI can stream progress and case cards as they pass.
 */
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { searchTna, type TnaSearchParams } from "../tna/client";
import { ncnToUri } from "../tna/ncn";
import { ensureCase, getElements, setClassifiedAreas } from "../cases/store";
import { areaLabel } from "../areas";
import { formatRange, inRange, normalizeRange } from "../dates";
import { firecrawlConfigured } from "../web/firecrawl";
import type { TokenUsage } from "../llm";
import { expandQuery } from "./expand";
import { webEnrich, type WebHints } from "./enrich";
import { fuseCandidates } from "./fusion";
import { retrieveParagraphs } from "./retrieve";
import { localIndexReady, searchLocal, type LocalSearchResult } from "./local";
import { embedQuery, embeddingsEnabled } from "../embed";
import { judgeRelevance } from "./relevance";
import type { Candidate, CandidateList, CaseResult, DateSource, SearchEvent, SearchOptions, SearchStats, WebMention } from "./types";

const MAX_TNA_REQUESTS = 25;
const MAX_CANDIDATES = Number(process.env.MAX_CANDIDATES ?? 10);
const RELEVANCE_CUTOFF = Number(process.env.RELEVANCE_CUTOFF ?? 0.5);
const CONCURRENCY = 4;
/** hits taken per TNA search; one request either way, so take more than we read */
const PER_VARIANT = Number(process.env.TNA_PER_VARIANT ?? 25);

class Budget {
  used = 0;
  constructor(private max: number) {}
  take(): boolean {
    if (this.used >= this.max) return false;
    this.used++;
    return true;
  }
  get left() {
    return this.max - this.used;
  }
}

/** Async queue so parallel workers can push events to the generator consumer. */
class EventQueue {
  private items: SearchEvent[] = [];
  private waiters: ((v: void) => void)[] = [];
  push(e: SearchEvent) {
    this.items.push(e);
    this.waiters.splice(0).forEach((w) => w());
  }
  async *drain(until: Promise<unknown>): AsyncGenerator<SearchEvent> {
    let finished = false;
    until.finally(() => {
      finished = true;
      this.waiters.splice(0).forEach((w) => w());
    });
    while (true) {
      while (this.items.length) yield this.items.shift()!;
      if (finished) return;
      await new Promise<void>((r) => this.waiters.push(r));
    }
  }
}

async function mapLimit<T>(items: T[], limit: number, fn: (t: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      while (queue.length) await fn(queue.shift()!);
    }),
  );
}

export async function* runSearch(query: string, opts: SearchOptions = {}, signal?: AbortSignal): AsyncGenerator<SearchEvent> {
  const areaFilter = new Set(opts.areas ?? []);
  const inAreas = (areas: string[]) => !areaFilter.size || areas.some((a) => areaFilter.has(a));
  const outsideReason = (areas: string[]) =>
    `Outside selected areas (case is ${areas.map(areaLabel).join(", ") || "unclassified"}).`;
  const t0 = Date.now();
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  const tnaBudget = new Budget(MAX_TNA_REQUESTS);
  const stats: SearchStats = {
    ms: 0,
    firstResultMs: null,
    tnaRequests: 0,
    casesFetched: 0,
    casesFromCache: 0,
    inputTokens: 0,
    outputTokens: 0,
    webEnrichment: firecrawlConfigured() ? "skipped" : "disabled",
    contextChars: 0,
    paragraphsEmbedded: 0,
  };

  const [search] = await db.insert(schema.searches).values({ query, filters: opts }).returning({ id: schema.searches.id });
  yield { type: "search", searchId: search.id };

  // ---- B. expansion ------------------------------------------------------------------------------
  yield { type: "status", stage: "expand", message: "Expanding query…" };
  // question embedding (local Ollama) runs alongside expansion; null → keyword-only ranking
  const queryVecPromise: Promise<number[] | null> = embeddingsEnabled()
    ? embedQuery(query, signal).catch((err) => {
        console.warn("[search] query embedding failed, keyword-only ranking:", err instanceof Error ? err.message : err);
        return null;
      })
    : Promise.resolve(null);
  const expanded = await expandQuery(query, usage, signal, [...areaFilter]);
  const queryVec = await queryVecPromise;

  // user range overrides the query's; null means "user cleared it"
  const userDates = opts.dates === undefined ? undefined : normalizeRange(opts.dates);
  const dates = userDates !== undefined ? userDates : expanded.dates;
  const dateSource: DateSource = !dates ? "none" : userDates !== undefined ? "user" : "query";
  yield {
    type: "expanded",
    variants: expanded.variants,
    filters: expanded.filters,
    ftsTerms: expanded.ftsTerms,
    dates,
    dateSource,
    datesReason: dateSource === "query" ? expanded.datesReason : null,
  };

  // ---- A. web enrichment (Firecrawl), in parallel with wave 1 ---------------------------------
  const webTimeout = Number(process.env.WEB_ENRICH_TIMEOUT_MS ?? 8000) + 4000;
  const webPromise: Promise<WebHints | null> = firecrawlConfigured()
    ? Promise.race([
        webEnrich(query, usage, signal).then((h) => {
          stats.webEnrichment = "used";
          return h;
        }),
        new Promise<null>((r) =>
          setTimeout(() => {
            if (stats.webEnrichment === "skipped") stats.webEnrichment = "timeout";
            r(null);
          }, webTimeout),
        ),
      ]).catch((err) => {
        console.warn("[search] web enrichment failed:", err instanceof Error ? err.message : err);
        stats.webEnrichment = "error";
        return null;
      })
    : Promise.resolve(null);

  // ---- L. local index (hybrid semantic + full-text), in parallel with wave 1 --------------------
  const localPromise: Promise<LocalSearchResult | null> = localIndexReady()
    .then((ready) => (ready ? searchLocal(expanded, dates, queryVec) : null))
    .catch((err) => {
      console.warn("[search] local index failed:", err instanceof Error ? err.message : err);
      return null;
    });

  // ---- C1. TNA keyword searches ------------------------------------------------------------------
  yield { type: "status", stage: "tna", message: `Searching TNA (${expanded.variants.length} variants)…` };
  const lists: CandidateList[] = [];
  const runTna = async (source: CandidateList["source"], label: string, params: TnaSearchParams) => {
    try {
      const page = await searchTna({ order: "relevance", ...params, perPage: PER_VARIANT }, signal);
      if (!page.cached) {
        if (!tnaBudget.take()) return;
        stats.tnaRequests++;
      }
      lists.push({ source, label, estimatedTotal: page.estimatedTotal, entries: page.entries });
    } catch (err) {
      console.warn(`[search] TNA search failed (${label}):`, err instanceof Error ? err.message : err);
    }
  };
  const f = expanded.filters;
  const baseParams: TnaSearchParams = { court: f.court, judge: f.judge, party: f.party, dates };
  await mapLimit(expanded.variants, CONCURRENCY, (v) => runTna("keyword", v, { ...baseParams, query: v }));

  // ---- C2. web hints → NCN lists, party and new keyword searches --------------------------------
  const web = await webPromise;
  const webMentions: (WebMention & { uri: string | null })[] = [];
  if (web) {
    yield { type: "web", terms: web.terms, variants: web.variants, ncns: web.ncns, sources: web.results.length };
    expanded.ftsTerms = [...new Set([...expanded.ftsTerms, ...web.terms])].slice(0, 32);
    const ncnEntries = web.ncns
      .map((ncn) => ({ ncn, uri: ncnToUri(ncn) }))
      .filter((x): x is { ncn: string; uri: string } => Boolean(x.uri));
    if (ncnEntries.length) {
      lists.push({
        source: "ncn",
        label: "web citation",
        estimatedTotal: ncnEntries.length,
        entries: ncnEntries.map(({ ncn, uri }) => ({ uri, ncn, name: "", court: null, date: null })),
      });
    }
    for (const c of web.cases) webMentions.push({ name: c.name, ncn: c.ncn, sourceUrl: c.sourceUrl, uri: c.ncn ? ncnToUri(c.ncn) : null });

    const extra: Promise<void>[] = [];
    const known = new Set(expanded.variants.map((v) => v.toLowerCase()));
    for (const v of web.variants) {
      if (known.has(v.toLowerCase()) || tnaBudget.left <= MAX_CANDIDATES) continue;
      extra.push(runTna("web-keyword", `web: ${v}`, { ...baseParams, query: v }));
    }
    for (const c of web.cases.slice(0, 2)) {
      if (!c.partyWord || tnaBudget.left <= MAX_CANDIDATES) continue;
      extra.push(runTna("party", `party: ${c.partyWord}`, { ...baseParams, party: c.partyWord, query: expanded.variants.at(-1) }));
    }
    await Promise.all(extra);
  }

  const local = await localPromise;
  if (local) {
    lists.push(...local.lists);
    const n = local.lists.reduce((s, l) => s + l.entries.length, 0);
    yield { type: "status", stage: "local", message: `Local index: ${n} hits` };
  }

  // ---- D. fusion ---------------------------------------------------------------------------------
  const candidates = fuseCandidates(lists, MAX_CANDIDATES);
  await db.update(schema.searches).set({ filters: { ...opts, dates, dateSource }, expanded, webHints: web ? { terms: web.terms, variants: web.variants, ncns: web.ncns, cases: web.cases } : null, candidates }).where(eq(schema.searches.id, search.id));
  yield { type: "candidates", candidates };
  if (!candidates.length) {
    yield* finish();
    return;
  }

  // ---- E–I. per-case: fetch → retrieve → relevance → verify → cutoff ----------------------------
  yield { type: "status", stage: "read", message: `Reading ${candidates.length} judgments…` };
  const events = new EventQueue();
  const resolvedUris = new Set<string>();
  let passed = 0;

  /** cheap pre-fetch check from the atom date or the NCN year */
  const candidateMayBeInRange = (c: Candidate) => {
    if (c.date) return inRange(c.date, dates);
    const year = c.ncn?.match(/\[(\d{4})\]/)?.[1];
    return !year || (inRange(`${year}-12-31`, { from: dates?.from }) && inRange(`${year}-01-01`, { to: dates?.to }));
  };

  const processCase = async (c: Candidate) => {
    try {
      signal?.throwIfAborted();
      if (dates && !candidateMayBeInRange(c)) {
        const reason = `Outside date range ${formatRange(dates)} (${c.date ?? c.ncn}).`;
        events.push({ type: "rejected", uri: c.uri, name: c.name || c.ncn || c.uri, score: 0, reason });
        return;
      }
      const cached = await ensureCase(c.uri, { signal });
      if (!cached) {
        events.push({ type: "rejected", uri: c.uri, name: c.name || c.ncn || c.uri, score: 0, reason: "Not found on TNA." });
        return;
      }
      if (cached.fromCache) stats.casesFromCache++;
      else {
        stats.casesFetched++;
        stats.tnaRequests++;
      }
      resolvedUris.add(c.uri);
      const kase = cached.row;
      // web citations / party searches bypass TNA's date filter, so check every case
      if (!inRange(kase.date, dates)) {
        const reason = `Outside date range ${formatRange(dates)} (judgment dated ${kase.date ?? "unknown"}).`;
        events.push({ type: "rejected", uri: kase.uri, name: kase.name, score: 0, reason, areas: kase.areas });
        await saveResult(search.id, kase.uri, 0, false, reason);
        return;
      }
      // already classified outside the selected areas → skip the LLM call
      if (kase.areasClassified && !inAreas(kase.areas)) {
        const reason = outsideReason(kase.areas);
        events.push({ type: "rejected", uri: kase.uri, name: kase.name, score: 0, reason, areas: kase.areas });
        await saveResult(search.id, kase.uri, 0, false, reason);
        return;
      }
      const elements = await getElements(kase.uri);
      const terms = expanded.ftsTerms.length ? expanded.ftsTerms : [expanded.original];
      const ctx = await retrieveParagraphs(kase.uri, elements, terms, { queryVec, signal });
      stats.contextChars += ctx.stats.chars;
      stats.paragraphsEmbedded += ctx.stats.embedded;
      if (!ctx.hitCount) {
        events.push({ type: "rejected", uri: kase.uri, name: kase.name, score: 0, reason: "No paragraph matches the query terms." });
        await saveResult(search.id, kase.uri, 0, false, "No paragraph matches the query terms.");
        return;
      }
      const verdict = await judgeRelevance(query, kase, ctx, usage, signal);
      const areas = await setClassifiedAreas(kase.uri, kase.court, verdict.areas);
      const relevant = verdict.relevant && verdict.score >= RELEVANCE_CUTOFF;
      const pass = relevant && verdict.highlights.length > 0 && inAreas(areas);
      await saveResult(search.id, kase.uri, verdict.score, pass, verdict.summary);
      if (!pass) {
        const reason = !relevant
          ? verdict.summary
          : !inAreas(areas)
            ? outsideReason(areas)
            : `No highlight could be verified against the judgment text (${verdict.proposed} proposed). ${verdict.summary}`;
        events.push({ type: "rejected", uri: kase.uri, name: kase.name, score: verdict.score, reason, areas });
        return;
      }
      if (verdict.highlights.length) {
        await db.insert(schema.highlights).values(
          verdict.highlights.map((h) => ({
            searchId: search.id,
            caseUri: kase.uri,
            elementId: h.elementId,
            kind: h.kind,
            quote: h.quote,
            reason: h.reason,
            verified: true,
          })),
        );
      }
      const result: CaseResult = {
        uri: kase.uri,
        name: kase.name,
        ncn: kase.ncn,
        court: kase.court,
        date: kase.date,
        anonymised: kase.anonymised,
        areas,
        score: verdict.score,
        summary: verdict.summary,
        highlights: verdict.highlights,
      };
      passed++;
      stats.firstResultMs ??= Date.now() - t0;
      events.push({ type: "result", result });
    } catch (err) {
      if (signal?.aborted) return;
      console.error(`[search] case ${c.uri} failed:`, err);
      events.push({ type: "rejected", uri: c.uri, name: c.name || c.uri, score: 0, reason: `Error: ${err instanceof Error ? err.message : String(err)}` });
    }
  };

  const work = mapLimit(candidates, CONCURRENCY, processCase);
  yield* events.drain(work);
  await work;

  // web cases that TNA does not have (never shown next to anonymised cases: only unresolved ones)
  const notInTna = webMentions.filter((m) => !m.uri || !resolvedUris.has(m.uri));
  if (notInTna.length) {
    yield { type: "web_mentions", mentions: notInTna.map(({ name, ncn, sourceUrl }) => ({ name, ncn, sourceUrl })) };
  }
  if (!passed) yield { type: "status", stage: "none", message: "No strong matches." };
  yield* finish();

  async function* finish(): AsyncGenerator<SearchEvent> {
    stats.ms = Date.now() - t0;
    stats.inputTokens = usage.inputTokens;
    stats.outputTokens = usage.outputTokens;
    await db.update(schema.searches).set({ stats }).where(eq(schema.searches.id, search.id));
    yield { type: "done", searchId: search.id, stats };
  }
}

async function saveResult(searchId: number, caseUri: string, score: number, relevant: boolean, summary: string) {
  await db
    .insert(schema.results)
    .values({ searchId, caseUri, score, relevant, summary })
    .onConflictDoUpdate({ target: [schema.results.searchId, schema.results.caseUri], set: { score, relevant, summary } });
}

