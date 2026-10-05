/**
 * Local index retrieval (plan §2 "LocalIndexSource"): hybrid search over the cases stored in
 * Postgres — semantic (pgvector HNSW over top-level paragraph embeddings, Ollama nomic-embed-text)
 * + full-text (GIN over elements).
 * Each produces a ranked CandidateList that is fused with the live TNA lists, so cases outside
 * the local corpus (older, or newer than the last ingest) are still found via TNA.
 */
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { toVectorLiteral } from "../embed";
import type { DateRange } from "../dates";
import type { CandidateList, ExpandedQuery } from "./types";

const VECTOR_CHUNKS = Number(process.env.LOCAL_VECTOR_CHUNKS ?? 300);
const LIST_SIZE = Number(process.env.LOCAL_LIST_SIZE ?? 25);

let readyCache: { at: number; ready: boolean; coverage: number } | null = null;

/**
 * True once any paragraph embeddings exist (cached 60s). LOCAL_INDEX=off disables local retrieval.
 * Also records coverage: the share of stored full-text cases with any embeddings.
 */
export async function localIndexReady(): Promise<boolean> {
  if (process.env.LOCAL_INDEX === "off") return false;
  if (readyCache && Date.now() - readyCache.at < 60_000) return readyCache.ready;
  const rows = await db.execute<{ embedded: number; total: number }>(sql`
    SELECT count(*) FILTER (WHERE embed_model IS NOT NULL)::int AS embedded,
           count(*) FILTER (WHERE availability = 'full-text')::int AS total
    FROM cases`);
  const embedded = Number(rows[0]?.embedded ?? 0);
  const total = Number(rows[0]?.total ?? 0);
  readyCache = { at: Date.now(), ready: embedded > 0, coverage: total ? embedded / total : 0 };
  return readyCache.ready;
}

/**
 * Weight multiplier for the local semantic list. A partly embedded cache is a biased sample, so
 * its hits should not outrank TNA's keyword lists until most cases are embedded.
 */
export function vectorListWeight(): number {
  const floor = Number(process.env.LOCAL_VECTOR_MIN_WEIGHT ?? 0.35);
  return Math.max(floor, Math.min(1, readyCache?.coverage ?? 0));
}

function caseFilters(dates: DateRange | null, courts: string[] | undefined): SQL {
  const parts: SQL[] = [sql`TRUE`];
  if (dates?.from) parts.push(sql`c.date >= ${dates.from}`);
  if (dates?.to) parts.push(sql`c.date <= ${dates.to}`);
  // expansion emits TNA court codes ("ewhc/ch"); stored courts look like "EWHC-Chancery", and
  // NCN-less URIs ("tna.xxxx") carry no court, so match on either
  if (courts?.length) {
    const one = (code: string) => {
      const [a, b = ""] = code.toLowerCase().split("/");
      return sql`(c.uri LIKE ${code.toLowerCase() + "/%"} OR (split_part(lower(c.court), '-', 1) = ${a} AND split_part(lower(c.court), '-', 2) LIKE ${b + "%"}))`;
    };
    parts.push(sql`(${sql.join(courts.map(one), sql` OR `)})`);
  }
  return sql.join(parts, sql` AND `);
}

type Entry = CandidateList["entries"][number];
interface Row {
  uri: string;
  name: string;
  ncn: string | null;
  court: string | null;
  date: string | null;
  [k: string]: unknown;
}
const toEntry = (r: Row): Entry => ({ uri: r.uri, name: r.name, ncn: r.ncn, court: r.court, date: r.date ? String(r.date).slice(0, 10) : null });

export interface LocalSearchResult {
  lists: CandidateList[];
  /** query embedding, reused for paragraph retrieval inside each case */
  queryVec: number[] | null;
}

/** Cosine similarity (nomic-embed-text) a paragraph needs to count as a semantic hit. */
export const VECTOR_MIN_SIM = Number(process.env.VECTOR_MIN_SIM ?? 0.65);

/**
 * `queryVecs`: the question first, then optional rephrasings (expansion variants). Each runs its
 * own nearest-neighbour scan; a case keeps its best score across them.
 */
export async function searchLocal(
  expanded: ExpandedQuery,
  dates: DateRange | null,
  queryVecs: number[][],
): Promise<LocalSearchResult> {
  const where = caseFilters(dates, expanded.filters.court);
  const [vector, fts] = await Promise.all([
    (queryVecs.length ? vectorSearch(queryVecs, where) : Promise.resolve(null)).catch((err) => {
      console.warn("[local] vector search failed:", err instanceof Error ? err.message : err);
      return null;
    }),
    ftsSearch(expanded, where).catch((err) => {
      console.warn("[local] full-text search failed:", err instanceof Error ? err.message : err);
      return null;
    }),
  ]);
  const lists: CandidateList[] = [];
  if (vector?.entries.length) lists.push(vector);
  if (fts?.entries.length) lists.push(fts);
  return { lists, queryVec: queryVecs[0] ?? null };
}

async function vectorSearch(queryVecs: number[][], where: SQL): Promise<CandidateList> {
  const perQuery = await Promise.all(queryVecs.map((v) => vectorSearchOne(v, where)));
  // best score per case across phrasings
  const best = new Map<string, Row & { score: number }>();
  for (const rows of perQuery) {
    for (const r of rows) {
      const cur = best.get(r.uri);
      if (!cur || Number(r.score) > cur.score) best.set(r.uri, { ...r, score: Number(r.score) });
    }
  }
  const ranked = [...best.values()].sort((a, b) => b.score - a.score).slice(0, LIST_SIZE);
  return {
    source: "local-vector",
    label: "local: semantic",
    estimatedTotal: ranked.length,
    weight: vectorListWeight(),
    entries: ranked.map(toEntry),
  };
}

async function vectorSearchOne(queryVec: number[], where: SQL) {
  const v = toVectorLiteral(queryVec);
  // iterative scan keeps returning neighbours until enough pass the case filters (pgvector ≥ 0.8)
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL hnsw.ef_search = ${sql.raw(String(Math.max(100, VECTOR_CHUNKS)))}`);
    await tx.execute(sql`SET LOCAL hnsw.iterative_scan = relaxed_order`);
    // case score = sum of its 3 best paragraph similarities / 3, so a judgment needs several
    // on-topic paragraphs to rank high (one lucky sentence no longer promotes a whole case)
    return tx.execute<Row & { score: number }>(sql`
      WITH hits AS (
        SELECT e.case_uri, 1 - (e.embedding <=> ${v}::vector) AS sim
        FROM elements e JOIN cases c ON c.uri = e.case_uri
        WHERE e.embedding IS NOT NULL AND ${where}
        ORDER BY e.embedding <=> ${v}::vector
        LIMIT ${VECTOR_CHUNKS}
      ),
      ranked AS (
        SELECT case_uri, sim, row_number() OVER (PARTITION BY case_uri ORDER BY sim DESC) AS rn FROM hits
      )
      SELECT c.uri, c.name, c.ncn, c.court, c.date, sum(r.sim) / 3 AS score
      FROM ranked r JOIN cases c ON c.uri = r.case_uri
      WHERE r.rn <= 3
      GROUP BY c.uri
      HAVING max(r.sim) >= ${VECTOR_MIN_SIM}
      ORDER BY score DESC
      LIMIT ${LIST_SIZE}`);
  });
}

async function ftsSearch(expanded: ExpandedQuery, where: SQL): Promise<CandidateList> {
  // Keyword variants (1-4 words) are AND-ed like separate TNA searches, then OR-ed together.
  // The raw question is left out: AND-ing every word of a sentence matches almost nothing.
  // The ranking terms (ftsTerms) are left out too: OR-ing ~20 broad words ("landlord", "notice")
  // matched tens of thousands of paragraphs, took 1-2 s to rank over 1M elements, and pushed the
  // on-point cases out of the top 25. They still rank paragraphs inside each case (retrieve.ts).
  const phrases = [...new Set(expanded.variants.map((s) => s.trim()).filter(Boolean))];
  const parts = phrases.map((p) => sql`plainto_tsquery('english', ${p})`);
  if (!parts.length) parts.push(sql`plainto_tsquery('english', ${expanded.original})`);
  const tsq = sql.join(parts, sql` || `);
  const rows = await db.execute<Row & { score: number; total: number }>(sql`
    WITH q AS (SELECT ${tsq} AS q),
    hits AS (
      SELECT e.case_uri, ts_rank_cd(e.tsv, q.q) AS rank
      FROM elements e, q
      WHERE e.tsv @@ q.q AND e.parent_id IS NULL
    ),
    per_case AS (
      SELECT case_uri, max(rank) * ln(1 + count(*)) AS score
      FROM hits GROUP BY case_uri
    )
    SELECT c.uri, c.name, c.ncn, c.court, c.date, p.score, count(*) OVER () AS total
    FROM per_case p JOIN cases c ON c.uri = p.case_uri
    WHERE ${where}
    ORDER BY p.score DESC
    LIMIT ${LIST_SIZE}`);
  return {
    source: "local-fts",
    label: "local: full-text",
    estimatedTotal: Number(rows[0]?.total ?? 0),
    entries: rows.map(toEntry),
  };
}

/** Best-matching embedded top-level paragraphs inside one case, with cosine similarity. */
export async function vectorParagraphHits(caseUri: string, queryVec: number[], limit = 12): Promise<Map<string, number>> {
  const v = toVectorLiteral(queryVec);
  const rows = await db.execute<{ element_id: string; sim: number }>(sql`
    SELECT element_id, 1 - (embedding <=> ${v}::vector) AS sim
    FROM elements
    WHERE case_uri = ${caseUri} AND parent_id IS NULL AND embedding IS NOT NULL
    ORDER BY embedding <=> ${v}::vector
    LIMIT ${limit}`);
  return new Map(rows.map((r) => [r.element_id, Number(r.sim)]));
}
