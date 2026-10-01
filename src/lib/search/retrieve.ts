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
import { ensureEmbeddings } from "../embed";
import { VECTOR_MIN_SIM, vectorParagraphHits } from "./local";

export function ftsQueryString(terms: string[]): string {
  return terms
    .map((t) => t.replace(/["()]/g, " ").trim())
    .filter((t) => t.length > 1)
    .map((t) => (t.includes(" ") ? `"${t}"` : t))
    .join(" OR ");
}

/** Rendering caps shared with buildCaseContext() so the budget estimate is exact. */
export const RENDER_CAPS = { ownChars: 1400, childChars: 700, maxChildren: 8 };

const TOP = Number(process.env.RETRIEVE_TOP ?? 8);
const NEIGHBOURS_FOR = Number(process.env.RETRIEVE_NEIGHBOURS_FOR ?? 3);
const BUDGET_CHARS = Number(process.env.RETRIEVE_BUDGET_CHARS ?? 12_000); // ≈ 3k tokens
/** paragraphs embedded on demand per case when the case is not fully embedded */
const EMBED_PREFILTER = Number(process.env.EMBED_PREFILTER ?? 40);

export interface RetrievedContext {
  /** top-level elements chosen for the prompt, in document order */
  topLevel: ElementRow[];
  /** every element in those subtrees (for prompt + verification) */
  all: ElementRow[];
  hitCount: number;
  /** diagnostics */
  stats: { ftsHits: number; vectorHits: number; embedded: number; chars: number };
}

export interface RetrieveOptions {
  top?: number;
  neighboursFor?: number;
  budgetChars?: number;
  /** query embedding; enables semantic ranking (and on-demand embedding of this case) */
  queryVec?: number[] | null;
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
        .select({ complete: schema.cases.embedComplete })
        .from(schema.cases)
        .where(eq(schema.cases.uri, caseUri));
      embedded = await ensureEmbeddings(caseUri, c?.complete ? [] : ftsRoots.slice(0, EMBED_PREFILTER), opts.signal);
      const vh = await vectorParagraphHits(caseUri, opts.queryVec);
      vecRoots = byScore(new Map([...vh].filter(([, sim]) => sim >= VECTOR_MIN_SIM)));
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[retrieve] semantic ranking skipped for ${caseUri}: ${msg.slice(0, 200)}`);
    }
  }

  const sel = selectParagraphs(elements, ftsRoots, vecRoots, {
    top: opts.top ?? TOP,
    neighboursFor: opts.neighboursFor ?? NEIGHBOURS_FOR,
    budgetChars: opts.budgetChars ?? BUDGET_CHARS,
  });
  return {
    ...sel,
    hitCount: new Set([...ftsRoots, ...vecRoots]).size,
    stats: { ftsHits: ftsRoots.length, vectorHits: vecRoots.length, embedded, chars: sel.chars },
  };
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
