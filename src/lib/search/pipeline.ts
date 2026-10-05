/**
 * Search pipeline (plan §3): expand (∥ Firecrawl web hints) → TNA searches (+ local index) → fuse →
 * fetch/parse → paragraph retrieval → relevance pass → quote verification → cutoff.
 * Yields SearchEvents so the UI can stream progress and case cards as they pass.
 *
 * Latency shape: web enrichment starts at t0 (it searches the raw question), alongside expansion.
 * Reading starts as soon as wave 1 (TNA keyword + local index) is fused, on the top FIRST_WAVE
 * candidates. Web hints, when they arrive, are fused in and fill the remaining slots.
 * Every queued case's judgment XML is fetched immediately (prefetch), while at most CONCURRENCY
 * cases are in the LLM stages at once.
 */
import { db, schema } from "@/db";
import { and, eq, inArray } from "drizzle-orm";
import { searchTna, type TnaSearchParams } from "../tna/client";
import { ncnToUri } from "../tna/ncn";
import { ensureCase, getElements, setClassifiedAreas, type CaseRow } from "../cases/store";
import { areaLabel } from "../areas";
import { formatRange, inRange, normalizeRange } from "../dates";
import { firecrawlConfigured } from "../web/firecrawl";
import type { TokenUsage } from "../llm";
import { expandQuery } from "./expand";
import { webEnrich, type WebHints } from "./enrich";
import { fuseCandidates } from "./fusion";
import { retrieveParagraphs } from "./retrieve";
import { localIndexReady, searchLocal, type LocalSearchResult } from "./local";
import { embedQueries, embeddingsEnabled } from "../embed";
import { judgeRelevance } from "./relevance";
import { RelevanceGate } from "./gate";
import { decisionKey, readDecision, writeDecision, type CaseDecision } from "./decision-cache";
import type { Candidate, CandidateList, CaseResult, DateSource, SearchEvent, SearchOptions, SearchStats, WebMention } from "./types";

const MAX_TNA_REQUESTS = 25;
const MAX_CANDIDATES = Number(process.env.MAX_CANDIDATES ?? 10);
/** candidates read before web hints are merged (the rest of MAX_CANDIDATES waits for them) */
const FIRST_WAVE = Math.min(MAX_CANDIDATES, Number(process.env.FIRST_WAVE ?? 6));
const RELEVANCE_CUTOFF = Number(process.env.RELEVANCE_CUTOFF ?? 0.5);
const CONCURRENCY = Number(process.env.CASE_CONCURRENCY ?? 4);
/** hits taken per TNA search; one request either way, so take more than we read */
const PER_VARIANT = Number(process.env.TNA_PER_VARIANT ?? 25);
/** expansion variants embedded alongside the question for local semantic search */
const VECTOR_VARIANTS = Number(process.env.LOCAL_VECTOR_VARIANTS ?? 2);
/** skip the LLM stages when no paragraph's cross-encoder score reaches this */
const RERANK_MIN = Number(process.env.RERANK_MIN ?? 0.05);
/** citation expansion: a case cited by at least CITE_MIN passing results is read too */
const CITE_MIN = Number(process.env.CITE_MIN ?? 2);
const CITE_MAX = Number(process.env.CITE_MAX ?? 3);
/** Find Case Law does not publish Privy Council or House of Lords judgments */
const NOT_ON_TNA = /^(ukpc|ukhl)\//;
/** the cheap pre-screen is skipped when the cross-encoder is this sure: the strong judge decides */
const RERANK_TRUST = Number(process.env.RERANK_TRUST ?? 0.9);
/** pre-screen rejection threshold (gate.ts); part of the decision-cache key */
const GATE_REJECT = Number(process.env.JUDGE_GATE_REJECT ?? 0.75);
/** longest wait for web hints once wave 1 is reading (web enrichment itself starts at t0) */
const WEB_WAIT_MS = Number(process.env.WEB_ENRICH_TIMEOUT_MS ?? 8000) + 4000;

class Budget {
  used = 0;
  constructor(private max: number) {}
  take(): boolean {
    if (this.used >= this.max) return false;
    this.used++;
    return true;
  }
  refund() {
    this.used = Math.max(0, this.used - 1);
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
    until
      .catch(() => {})
      .finally(() => {
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

/** Fixed number of workers over a queue that can grow until close(). */
class WorkPool<T> {
  private queue: T[] = [];
  private waiters: (() => void)[] = [];
  private closed = false;
  private active = 0;
  private idleWaiters: (() => void)[] = [];
  readonly done: Promise<void>;
  constructor(limit: number, fn: (t: T) => Promise<void>) {
    this.done = Promise.all(
      Array.from({ length: Math.max(1, limit) }, async () => {
        while (true) {
          if (this.queue.length) {
            this.active++;
            try {
              await fn(this.queue.shift()!);
            } finally {
              this.active--;
              if (!this.active && !this.queue.length) this.idleWaiters.splice(0).forEach((w) => w());
            }
            continue;
          }
          if (this.closed) return;
          await new Promise<void>((r) => this.waiters.push(r));
        }
      }),
    ).then(() => {});
  }
  push(items: T[]) {
    this.queue.push(...items);
    this.wake();
  }
  close() {
    this.closed = true;
    this.wake();
  }
  /** resolves once everything queued so far has been processed */
  idle(): Promise<void> {
    if (!this.active && !this.queue.length) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }
  private wake() {
    this.waiters.splice(0).forEach((w) => w());
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
    timings: { expand: 0, search: 0, web: 0, fetch: 0, retrieve: 0, gate: 0, judge: 0 },
    gate: null,
    rerankRejected: 0,
    citationCandidates: 0,
    decisionsCached: 0,
  };
  // decisions-model pre-screen, batched across this search's cases
  const gate = RelevanceGate.forSearch(query, signal);
  stats.gate = gate?.stats ?? null;

  const [search] = await db.insert(schema.searches).values({ query, filters: opts }).returning({ id: schema.searches.id });
  yield { type: "search", searchId: search.id };

  // ---- A. web enrichment (Firecrawl), from t0: it needs only the raw question, not the expansion -
  // the wait is capped in C2, counted from when wave 1 starts reading, so starting early only helps
  const webPromise: Promise<WebHints | null> = firecrawlConfigured()
    ? webEnrich(query, usage, signal).catch((err) => {
        console.warn("[search] web enrichment failed:", err instanceof Error ? err.message : err);
        stats.webEnrichment = "error";
        return null;
      })
    : Promise.resolve(null);

  // ---- B. expansion ------------------------------------------------------------------------------
  yield { type: "status", stage: "expand", message: "Expanding query…" };
  // question embedding (local Ollama) runs alongside expansion; null → keyword-only ranking
  const embedOn = embeddingsEnabled();
  const questionVec: Promise<number[] | null> = embedOn
    ? embedQueries([query], signal).then(
        ([v]) => v ?? null,
        (err) => {
          console.warn("[search] query embedding failed, keyword-only ranking:", err instanceof Error ? err.message : err);
          return null;
        },
      )
    : Promise.resolve(null);
  // the index readiness check is a cached DB count; start it now too
  const localReady = localIndexReady().catch(() => false);
  const tExpand = Date.now();
  const expanded = await expandQuery(query, usage, signal, [...areaFilter]);
  stats.timings.expand = expanded.cached ? 0 : Date.now() - tExpand;
  const tSearch = Date.now();

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

  // ---- L. local index: question + top variants embedded, semantic + full-text -----------------
  const queryVec = await questionVec;
  const localPromise: Promise<LocalSearchResult | null> = localReady
    .then(async (ready) => {
      if (!ready) return null;
      const extra = queryVec && VECTOR_VARIANTS > 0
        ? await embedQueries(expanded.variants.slice(0, VECTOR_VARIANTS), signal).catch(() => [])
        : [];
      return searchLocal(expanded, dates, queryVec ? [queryVec, ...extra] : []);
    })
    .catch((err) => {
      console.warn("[search] local index failed:", err instanceof Error ? err.message : err);
      return null;
    });

  // ---- C1. TNA keyword searches ------------------------------------------------------------------
  yield { type: "status", stage: "tna", message: `Searching TNA (${expanded.variants.length} variants)…` };
  const lists: CandidateList[] = [];
  const runTna = async (source: CandidateList["source"], label: string, params: TnaSearchParams) => {
    // reserve the slot before the request; cache hits give it back
    if (!tnaBudget.take()) return;
    try {
      const page = await searchTna({ order: "relevance", ...params, perPage: PER_VARIANT }, signal);
      if (page.cached) tnaBudget.refund();
      else stats.tnaRequests++;
      lists.push({ source, label, estimatedTotal: page.estimatedTotal, entries: page.entries });
    } catch (err) {
      console.warn(`[search] TNA search failed (${label}):`, err instanceof Error ? err.message : err);
    }
  };
  const f = expanded.filters;
  const baseParams: TnaSearchParams = { court: f.court, judge: f.judge, party: f.party, dates };
  await mapLimit(expanded.variants, CONCURRENCY, (v) => runTna("keyword", v, { ...baseParams, query: v }));

  const local = await localPromise;
  if (local) {
    lists.push(...local.lists);
    const n = local.lists.reduce((s, l) => s + l.entries.length, 0);
    yield { type: "status", stage: "local", message: `Local index: ${n} hits` };
  }
  stats.timings.search = Date.now() - tSearch;

  // ---- E–I. per-case: fetch → retrieve → relevance → verify → cutoff ----------------------------
  const events = new EventQueue();
  const resolvedUris = new Set<string>();
  const queued: (Candidate & { via?: string })[] = [];
  const passedUris: string[] = [];
  const prefetched = new Map<string, ReturnType<typeof ensureCase>>();
  let passed = 0;

  /** cheap pre-fetch check from the atom date or the NCN year */
  const candidateMayBeInRange = (c: Candidate) => {
    if (c.date) return inRange(c.date, dates);
    const year = c.ncn?.match(/\[(\d{4})\]/)?.[1];
    return !year || (inRange(`${year}-12-31`, { from: dates?.from }) && inRange(`${year}-01-01`, { to: dates?.to }));
  };

  /** The expensive per-case stages. Every outcome is cacheable; errors propagate (never cached). */
  const decide = async (kase: CaseRow): Promise<CaseDecision> => {
    const tRetrieve = Date.now();
    const elements = await getElements(kase.uri);
    const terms = expanded.ftsTerms.length ? expanded.ftsTerms : [expanded.original];
    const ctx = await retrieveParagraphs(kase.uri, elements, terms, { queryVec, rerankQuery: query, signal });
    const rerank = ctx.stats.rerankTop ?? undefined;
    stats.timings.retrieve += Date.now() - tRetrieve;
    stats.contextChars += ctx.stats.chars;
    stats.paragraphsEmbedded += ctx.stats.embedded;
    // cross-encoder says no retrieved paragraph is about the question → no LLM calls
    if (rerank !== undefined && rerank < RERANK_MIN) {
      const reason = `No passage is about the question (best reranker score ${rerank.toFixed(3)} < ${RERANK_MIN}).`;
      return { kind: "reject", by: "rerank", score: rerank, reason, rerank };
    }
    if (!ctx.hitCount) {
      return { kind: "reject", by: "no-hits", score: 0, reason: "No paragraph matches the query by keyword or meaning.", rerank };
    }
    // cheap pre-screen: confident "tangential / unrelated" skips the strong model
    if (gate && !(rerank !== undefined && rerank >= RERANK_TRUST)) {
      const tGate = Date.now();
      try {
        const g = await gate.screen(kase, ctx);
        if (g.reject) {
          const pct = (n: number | undefined) => `${Math.round((n ?? 0) * 100)}%`;
          const reason = `Pre-screen: ${g.choice} (on point ${pct(g.probabilities.on_point)}, tangential ${pct(g.probabilities.tangential)}, unrelated ${pct(g.probabilities.irrelevant)}).`;
          return { kind: "reject", by: "gate", score: g.onPoint, reason, rerank };
        }
      } catch (err) {
        if (signal?.aborted) throw err;
        // fail open: the strong judge still runs (errors are counted in gate.stats)
        console.warn(`[gate] ${kase.uri}:`, err instanceof Error ? err.message : err);
      } finally {
        stats.timings.gate += Date.now() - tGate;
      }
    }
    const tJudge = Date.now();
    const verdict = await judgeRelevance(query, kase, ctx, usage, signal);
    stats.timings.judge += Date.now() - tJudge;
    return { kind: "judged", verdict, rerank };
  };

  const processCase = async (c: Candidate & { via?: string }) => {
    try {
      signal?.throwIfAborted();
      if (dates && !candidateMayBeInRange(c)) {
        const reason = `Outside date range ${formatRange(dates)} (${c.date ?? c.ncn}).`;
        events.push({ type: "rejected", uri: c.uri, name: c.name || c.ncn || c.uri, score: 0, reason });
        return;
      }
      const tFetch = Date.now();
      const cached = await (prefetched.get(c.uri) ?? ensureCase(c.uri, { signal }));
      stats.timings.fetch += Date.now() - tFetch;
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
      // retrieval → rerank → pre-screen → judge, or the cached outcome of a previous search
      const key = decisionKey(query, kase.uri, kase.contentHash, { RERANK_MIN, RERANK_TRUST, JUDGE_GATE_REJECT: GATE_REJECT });
      let decision = await readDecision(key);
      if (decision) stats.decisionsCached++;
      else {
        decision = await decide(kase);
        await writeDecision(key, decision);
      }
      const rerank = decision.rerank;
      if (decision.kind === "reject") {
        if (decision.by === "rerank") stats.rerankRejected++;
        events.push({ type: "rejected", uri: kase.uri, name: kase.name, score: decision.score, reason: decision.reason, areas: kase.areas, rerank });
        await saveResult(search.id, kase.uri, decision.score, false, decision.reason);
        return;
      }
      const verdict = decision.verdict;
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
        events.push({ type: "rejected", uri: kase.uri, name: kase.name, score: verdict.score, reason, areas, rerank });
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
        rerank,
        via: c.via,
      };
      passed++;
      passedUris.push(kase.uri);
      stats.firstResultMs ??= Date.now() - t0;
      events.push({ type: "result", result });
    } catch (err) {
      if (signal?.aborted) return;
      console.error(`[search] case ${c.uri} failed:`, err);
      events.push({ type: "rejected", uri: c.uri, name: c.name || c.uri, score: 0, reason: `Error: ${err instanceof Error ? err.message : String(err)}` });
    }
  };

  const pool = new WorkPool<Candidate>(CONCURRENCY, processCase);
  /** queue new candidates (skipping ones already queued) and start their downloads now */
  const enqueue = (cands: Candidate[], max: number) => {
    const seen = new Set(queued.map((c) => c.uri));
    const fresh = cands.filter((c) => !seen.has(c.uri)).slice(0, Math.max(0, max - queued.length));
    for (const c of fresh) {
      if (!dates || candidateMayBeInRange(c)) {
        const p = ensureCase(c.uri, { signal });
        p.catch(() => {}); // surfaced when the worker awaits it
        prefetched.set(c.uri, p);
      }
    }
    queued.push(...fresh);
    pool.push(fresh);
    return fresh.length;
  };

  const webMentions: (WebMention & { uri: string | null })[] = [];

  // wave 1 starts reading now; web hints (C2) are merged in when they arrive
  const orchestrate = (async () => {
    const wave1 = fuseCandidates(lists, MAX_CANDIDATES);
    if (wave1.length) {
      events.push({ type: "status", stage: "read", message: `Reading top ${Math.min(FIRST_WAVE, wave1.length)} judgments…` });
      enqueue(wave1, FIRST_WAVE);
    }

    // ---- C2. web hints → NCN lists, party and new keyword searches ------------------------------
    const tWeb = Date.now();
    let webTimer: ReturnType<typeof setTimeout> | undefined;
    const web = await Promise.race([
      webPromise,
      new Promise<null>((r) => (webTimer = setTimeout(() => r(null), WEB_WAIT_MS))),
    ]).finally(() => clearTimeout(webTimer));
    if (web) stats.webEnrichment = "used";
    else if (stats.webEnrichment === "skipped") stats.webEnrichment = "timeout";
    if (web) {
      events.push({ type: "web", terms: web.terms, variants: web.variants, ncns: web.ncns, sources: web.results.length });
      // later cases also rank paragraphs with the web vocabulary
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
    stats.timings.web = Date.now() - tWeb;

    // ---- D. final fusion: fill the remaining slots ---------------------------------------------
    const added = enqueue(fuseCandidates(lists, MAX_CANDIDATES + queued.length), MAX_CANDIDATES);
    if (added && queued.length > added) {
      events.push({ type: "status", stage: "read", message: `Reading ${added} more judgments…` });
    } else if (added) {
      events.push({ type: "status", stage: "read", message: `Reading ${added} judgments…` });
    }
    events.push({ type: "candidates", candidates: [...queued] });

    // ---- K. citation expansion: authorities several passing results rely on --------------------
    // Leading cases are often worded differently from the question (so keyword and semantic search
    // miss them) but every later judgment on the point cites them.
    await pool.idle();
    const cited = await citedByResults(passedUris, new Set(queued.map((c) => c.uri)));
    if (cited.length) {
      stats.citationCandidates = cited.length;
      events.push({ type: "status", stage: "citations", message: `Following citations: reading ${cited.length} case${cited.length === 1 ? "" : "s"} cited by several results…` });
      for (const c of cited) {
        const p = ensureCase(c.uri, { signal });
        p.catch(() => {});
        prefetched.set(c.uri, p);
      }
      queued.push(...cited);
      pool.push(cited);
      events.push({ type: "candidates", candidates: [...queued] });
    }
    await db
      .update(schema.searches)
      .set({
        filters: { ...opts, dates, dateSource },
        expanded,
        webHints: web ? { terms: web.terms, variants: web.variants, ncns: web.ncns, cases: web.cases } : null,
        candidates: queued,
      })
      .where(eq(schema.searches.id, search.id));
    pool.close();
    await pool.done;
  })();

  yield* events.drain(orchestrate);
  await orchestrate;

  // web cases that TNA does not have (never shown next to anonymised cases: only unresolved ones)
  const notInTna = webMentions.filter((m) => !m.uri || !resolvedUris.has(m.uri));
  if (notInTna.length) {
    yield { type: "web_mentions", mentions: notInTna.map(({ name, ncn, sourceUrl }) => ({ name, ncn, sourceUrl })) };
  }
  if (!passed) yield { type: "status", stage: "none", message: "No strong matches." };
  stats.ms = Date.now() - t0;
  stats.inputTokens = usage.inputTokens;
  stats.outputTokens = usage.outputTokens;
  await db.update(schema.searches).set({ stats }).where(eq(schema.searches.id, search.id));
  yield { type: "done", searchId: search.id, stats };
}

/** Cases cited by at least CITE_MIN of the passing results, most-cited first (not already read). */
async function citedByResults(passed: string[], exclude: Set<string>): Promise<(Candidate & { via: string })[]> {
  if (passed.length < CITE_MIN || CITE_MAX <= 0) return [];
  const rows = await db
    .select({ from: schema.citations.fromUri, toUri: schema.citations.toUri, toNcn: schema.citations.toNcn })
    .from(schema.citations)
    .where(and(inArray(schema.citations.fromUri, passed), eq(schema.citations.type, "case")));
  const citers = new Map<string, { ncn: string | null; from: Set<string> }>();
  for (const r of rows) {
    const uri = r.toUri ?? (r.toNcn ? ncnToUri(r.toNcn) : null);
    if (!uri || exclude.has(uri) || passed.includes(uri) || NOT_ON_TNA.test(uri)) continue;
    const e = citers.get(uri) ?? { ncn: r.toNcn, from: new Set<string>() };
    e.from.add(r.from);
    citers.set(uri, e);
  }
  return [...citers.entries()]
    .filter(([, e]) => e.from.size >= CITE_MIN)
    .sort((a, b) => b[1].from.size - a[1].from.size)
    .slice(0, CITE_MAX)
    .map(([uri, e]) => ({
      uri,
      ncn: e.ncn,
      name: "",
      court: null,
      date: null,
      score: e.from.size,
      matchedBy: [`cited by ${e.from.size} results`],
      via: `cited by ${e.from.size} of the results`,
    }));
}

async function saveResult(searchId: number, caseUri: string, score: number, relevant: boolean, summary: string) {
  await db
    .insert(schema.results)
    .values({ searchId, caseUri, score, relevant, summary })
    .onConflictDoUpdate({ target: [schema.results.searchId, schema.results.caseUri], set: { score, relevant, summary } });
}
