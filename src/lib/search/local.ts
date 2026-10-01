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

let readyCache: { at: number; ready: boolean } | null = null;

/** True once any paragraph embeddings exist (cached 60s). LOCAL_INDEX=off disables local retrieval. */
export async function localIndexReady(): Promise<boolean> {
  if (process.env.LOCAL_INDEX === "off") return false;
  if (readyCache && Date.now() - readyCache.at < 60_000) return readyCache.ready;
  const rows = await db.execute<{ ok: boolean }>(sql`SELECT EXISTS (SELECT 1 FROM elements WHERE embedding IS NOT NULL) AS ok`);
  readyCache = { at: Date.now(), ready: Boolean(rows[0]?.ok) };
  return readyCache.ready;
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

export async function searchLocal(
  expanded: ExpandedQuery,
  dates: DateRange | null,
  queryVec: number[] | null,
): Promise<LocalSearchResult> {
  const where = caseFilters(dates, expanded.filters.court);
  const [vector, fts] = await Promise.all([
    (queryVec ? vectorSearch(queryVec, where) : Promise.resolve(null)).catch((err) => {
      console.warn("[local] vector search failed:", err instanceof Error ? err.message : err);
      return null;
    }),
    ftsSearch(expanded, where).catch((err) => {
      console.warn("[local] full-text search failed:", err instanceof Error ? err.message : err);
      return null;
    }),
  ]);
  const lists: CandidateList[] = [];
  if (vector?.list.entries.length) lists.push(vector.list);
  if (fts?.entries.length) lists.push(fts);
  return { lists, queryVec };
}

async function vectorSearch(queryVec: number[], where: SQL) {
  const v = toVectorLiteral(queryVec);
  // iterative scan keeps returning neighbours until enough pass the case filters (pgvector ≥ 0.8)
  const rows = await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL hnsw.ef_search = ${sql.raw(String(Math.max(100, VECTOR_CHUNKS)))}`);
    await tx.execute(sql`SET LOCAL hnsw.iterative_scan = relaxed_order`);
    return tx.execute<Row & { sim: number }>(sql`
      WITH hits AS (
        SELECT e.case_uri, 1 - (e.embedding <=> ${v}::vector) AS sim
        FROM elements e JOIN cases c ON c.uri = e.case_uri
        WHERE e.embedding IS NOT NULL AND ${where}
        ORDER BY e.embedding <=> ${v}::vector
        LIMIT ${VECTOR_CHUNKS}
      )
      SELECT c.uri, c.name, c.ncn, c.court, c.date, max(h.sim) AS sim
      FROM hits h JOIN cases c ON c.uri = h.case_uri
      GROUP BY c.uri
      HAVING max(h.sim) >= ${VECTOR_MIN_SIM}
      ORDER BY max(h.sim) DESC
      LIMIT ${LIST_SIZE}`);
  });
  const list: CandidateList = {
    source: "local-vector",
    label: "local: semantic",
    estimatedTotal: rows.length,
    entries: rows.map(toEntry),
  };
  return { list };
}

async function ftsSearch(expanded: ExpandedQuery, where: SQL): Promise<CandidateList> {
  // each variant is an AND of its words; variants are OR-ed (same semantics as separate TNA searches)
  const phrases = [...new Set([expanded.original, ...expanded.variants].map((s) => s.trim()).filter(Boolean))];
  const tsq = sql.join(phrases.map((p) => sql`plainto_tsquery('english', ${p})`), sql` || `);
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
