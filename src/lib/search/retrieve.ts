/**
 * Paragraph retrieval inside one judgment, feeding the relevance pass.
 *
 * Ranking is hybrid: Postgres full-text (ts_rank_cd over the expanded search terms) interleaved
 * with semantic hits (nomic-embed-text over top-level paragraphs), so paragraphs that discuss the
 * topic in different words are not missed. Paragraphs are embedded on demand: a case that is not
 * fully embedded gets its best keyword-matching paragraphs embedded first (cached for next time).
 *
 * Selection is budgeted (this step is most of a search's input tokens): top N paragraphs, one
 * neighbour each side for the best few, and a character budget per case that matches what
 * buildCaseContext() actually renders.
 */
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import type { ElementRow } from "../cases/store";
import { EMBED_MODEL, ensureEmbeddings } from "../embed";
import { ftsQueryString } from "../text";
import { rerankEnabled, rerankScores } from "../rerank";
import { VECTOR_MIN_SIM, vectorParagraphHits } from "./local";

export { ftsQueryString };

/** Rendering caps shared with buildCaseContext() so the budget estimate is exact. */
export const RENDER_CAPS = { ownChars: 1400, childChars: 700, maxChildren: 8 };

const TOP = Number(process.env.RETRIEVE_TOP ?? 8);
const NEIGHBOURS_FOR = Number(process.env.RETRIEVE_NEIGHBOURS_FOR ?? 3);
const BUDGET_CHARS = Number(process.env.RETRIEVE_BUDGET_CHARS ?? 12_000); // ≈ 3k tokens
/** paragraphs embedded on demand per case when the case is not fully embedded */
const EMBED_PREFILTER = Number(process.env.EMBED_PREFILTER ?? 40);
/**
 * With fewer keyword hits than this, the keyword prefilter can't find the passage, so embed the
 * whole case (if it has at most EMBED_FULL_MAX paragraphs). Lets meaning-only matches through.
 */
const EMBED_FULL_BELOW = Number(process.env.EMBED_FULL_BELOW ?? 5);
const EMBED_FULL_MAX = Number(process.env.EMBED_FULL_MAX ?? 400);
/** keyword + semantic paragraphs scored by the cross-encoder per case */
const RERANK_POOL = Number(process.env.RERANK_POOL ?? 16);

export interface RetrievedContext {
  /** top-level elements chosen for the prompt, in document order */
  topLevel: ElementRow[];
  /** every element in those subtrees (for prompt + verification) */
  all: ElementRow[];
  hitCount: number;
  /** diagnostics */
  stats: {
    ftsHits: number;
    vectorHits: number;
    embedded: number;
    chars: number;
    /** best cross-encoder score (0–1) of any paragraph; null when the reranker did not run */
    rerankTop: number | null;
  };
}

export interface RetrieveOptions {
  top?: number;
  neighboursFor?: number;
  budgetChars?: number;
  /** query embedding; enables semantic ranking (and on-demand embedding of this case) */
  queryVec?: number[] | null;
  /** the user's question; enables cross-encoder reranking of the candidate paragraphs */
  rerankQuery?: string;
  signal?: AbortSignal;
}

export async function retrieveParagraphs(
  caseUri: string,
  elements: ElementRow[],
  terms: string[],
  opts: RetrieveOptions = {},
): Promise<RetrievedContext> {
  const q = ftsQueryString(terms);
  const hits = q
    ? await db
        .select({
          elementId: schema.elements.elementId,
          rank: sql<number>`ts_rank_cd(${schema.elements.tsv}, websearch_to_tsquery('english', ${q}))`,
        })
        .from(schema.elements)
        .where(
          and(
            eq(schema.elements.caseUri, caseUri),
            sql`${schema.elements.tsv} @@ websearch_to_tsquery('english', ${q})`,
          ),
        )
    : [];

  const byId = new Map(elements.map((e) => [e.elementId, e]));
  const rootOf = (id: string) => {
    let e = byId.get(id);
    while (e?.parentId && byId.get(e.parentId)) e = byId.get(e.parentId);
    return e;
  };
  const rootScore = new Map<string, number>();
  for (const h of hits) {
    const root = rootOf(h.elementId);
    if (!root || root.kind === "heading") continue;
    rootScore.set(root.elementId, Math.max(rootScore.get(root.elementId) ?? 0, Number(h.rank)));
  }
  const ftsRoots = byScore(rootScore);

  // semantic hits: embed what we are about to rank (if not already), then nearest paragraphs
  let vecRoots: string[] = [];
  let embedded = 0;
  if (opts.queryVec) {
    try {
      const [c] = await db
        .select({ complete: schema.cases.embedComplete, model: schema.cases.embedModel })
        .from(schema.cases)
        .where(eq(schema.cases.uri, caseUri));
      const complete = Boolean(c?.complete && c.model === EMBED_MODEL);
      const paragraphs = elements.filter((e) => !e.parentId && e.kind !== "heading").length;
      const toEmbed = complete
        ? []
        : ftsRoots.length < EMBED_FULL_BELOW && paragraphs <= EMBED_FULL_MAX
          ? undefined // whole case
          : ftsRoots.slice(0, EMBED_PREFILTER);
      embedded = await ensureEmbeddings(caseUri, toEmbed, opts.signal);
      const vh = await vectorParagraphHits(caseUri, opts.queryVec);
      vecRoots = byScore(new Map([...vh].filter(([, sim]) => sim >= VECTOR_MIN_SIM)));
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[retrieve] semantic ranking skipped for ${caseUri}: ${msg.slice(0, 200)}`);
    }
  }

  // cross-encoder: score the union of keyword and semantic paragraphs against the question and
  // select by that score alone (it reads question and passage together, so it can tell
  // "same doctrine, different facts" apart from an on-point passage)
  let rankA = ftsRoots;
  let rankB = vecRoots;
  let rerankTop: number | null = null;
  const pool = interleave(ftsRoots, vecRoots, RERANK_POOL);
  if (opts.rerankQuery && rerankEnabled() && pool.length) {
    try {
      const byId = new Map(elements.map((e) => [e.elementId, e]));
      const scores = await rerankScores(opts.rerankQuery, pool.map((id) => byId.get(id)?.text ?? ""));
      const scored = pool.map((id, i) => [id, scores[i]] as const).sort((a, b) => b[1] - a[1]);
      rankA = scored.map(([id]) => id);
      rankB = [];
      rerankTop = scored[0]?.[1] ?? null;
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      console.warn(`[retrieve] rerank skipped for ${caseUri}:`, err instanceof Error ? err.message : err);
    }
  }

  const sel = selectParagraphs(elements, rankA, rankB, {
    top: opts.top ?? TOP,
    neighboursFor: opts.neighboursFor ?? NEIGHBOURS_FOR,
    budgetChars: opts.budgetChars ?? BUDGET_CHARS,
  });
  return {
    ...sel,
    hitCount: new Set([...ftsRoots, ...vecRoots]).size,
    stats: { ftsHits: ftsRoots.length, vectorHits: vecRoots.length, embedded, chars: sel.chars, rerankTop },
  };
}

/** Alternate two rankings without duplicates, up to `limit`. */
export function interleave(a: string[], b: string[], limit: number): string[] {
  const out: string[] = [];
  for (let i = 0; out.length < limit && (i < a.length || i < b.length); i++) {
    for (const id of [a[i], b[i]]) if (id && !out.includes(id) && out.length < limit) out.push(id);
  }
  return out;
}

function byScore(m: Map<string, number>): string[] {
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/** Descendants rendered for a root (depth-first, capped) — shared with buildCaseContext(). */
export function renderedDescendants(root: ElementRow, children: Map<string, ElementRow[]>): ElementRow[] {
  const out: ElementRow[] = [];
  const walk = (e: ElementRow) => {
    for (const k of children.get(e.elementId) ?? []) {
      if (out.length >= RENDER_CAPS.maxChildren) return;
      out.push(k);
      walk(k);
    }
  };
  walk(root);
  return out;
}

/** Characters buildCaseContext() will render for this root and its descendants. */
export function renderCost(root: ElementRow, children: Map<string, ElementRow[]>): number {
  let cost = Math.min(root.text.length, RENDER_CAPS.ownChars) + 40;
  for (const k of renderedDescendants(root, children)) cost += Math.min(k.text.length, RENDER_CAPS.childChars) + 40;
  return cost;
}

/**
 * Pure selection: interleave keyword and semantic rankings (neither crowds the other out), take
 * up to `top`, add short neighbours for the first `neighboursFor`, and stop at the char budget.
 * Always keeps at least the best paragraph.
 */
export function selectParagraphs(
  elements: ElementRow[],
  ftsRoots: string[],
  vecRoots: string[],
  opts: { top: number; neighboursFor: number; budgetChars: number },
): { topLevel: ElementRow[]; all: ElementRow[]; chars: number } {
  const topLevel = elements.filter((e) => !e.parentId);
  const index = new Map(topLevel.map((e, i) => [e.elementId, i]));
  const children = new Map<string, ElementRow[]>();
  for (const e of elements) {
    if (!e.parentId) continue;
    const list = children.get(e.parentId) ?? [];
    list.push(e);
    children.set(e.parentId, list);
  }

  const ranked: string[] = [];
  for (let i = 0; ranked.length < opts.top && (i < ftsRoots.length || i < vecRoots.length); i++) {
    for (const id of [ftsRoots[i], vecRoots[i]]) {
      if (id && index.has(id) && !ranked.includes(id) && ranked.length < opts.top) ranked.push(id);
    }
  }

  const chosen = new Set<number>();
  let chars = 0;
  const take = (i: number) => {
    if (chosen.has(i)) return true;
    const cost = renderCost(topLevel[i], children);
    if (chosen.size > 0 && chars + cost > opts.budgetChars) return false;
    chosen.add(i);
    chars += cost;
    return true;
  };
  ranked.forEach((id, rank) => {
    const i = index.get(id)!;
    if (!take(i)) return;
    if (rank < opts.neighboursFor) {
      for (const j of [i - 1, i + 1]) {
        const n = topLevel[j];
        if (n && n.kind !== "heading" && n.text.length < 1000) take(j);
      }
    }
  });

  const picked = [...chosen].sort((a, b) => a - b).map((i) => topLevel[i]);
  const pickedIds = new Set(picked.map((e) => e.elementId));
  const byId = new Map(elements.map((x) => [x.elementId, x]));
  const rootOf = (e: ElementRow): string => {
    let cur = e;
    while (cur.parentId && byId.get(cur.parentId)) cur = byId.get(cur.parentId)!;
    return cur.elementId;
  };
  const all = elements.filter((e) => pickedIds.has(rootOf(e)));
  return { topLevel: picked, all, chars };
}
