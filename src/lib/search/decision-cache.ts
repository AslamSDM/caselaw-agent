/**
 * Per-case decision cache: the outcome of retrieval → rerank → pre-screen → judge for one
 * (question, judgment) pair. A repeated search then skips those stages for every case it has
 * already decided, which is nearly all of a search's time and tokens.
 *
 * The key covers everything the decision depends on: the strong and pre-screen models, the
 * thresholds that reject before the judge, the normalised question, the case and its content
 * hash (a re-published judgment is decided again). The relevance cutoff and area filter are
 * applied after the cache, so changing them needs no re-run.
 *
 * Stored in tna_search_cache under a "decision:" key for DECISION_CACHE_DAYS (default 30).
 * DECISION_CACHE=off disables it (evals turn it off so every run measures the pipeline).
 */
import { createHash } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { modelId } from "../llm";
import { gateModel } from "./gate";
import type { RelevanceOutcome } from "./relevance";

/** bump when prompts or retrieval change enough that old decisions should not be reused */
const VERSION = 1;
const DAYS = Number(process.env.DECISION_CACHE_DAYS ?? 30);

export type CaseDecision =
  | { kind: "reject"; score: number; reason: string; rerank?: number; by: "rerank" | "no-hits" | "gate" }
  | { kind: "judged"; verdict: RelevanceOutcome; rerank?: number };

export function decisionCacheEnabled(): boolean {
  return process.env.DECISION_CACHE !== "off";
}

export function decisionKey(query: string, caseUri: string, contentHash: string | null, thresholds: Record<string, number>): string {
  const norm = query.trim().toLowerCase().replace(/\s+/g, " ");
  const parts = [VERSION, modelId("strong"), gateModel(), thresholds, norm, caseUri, contentHash];
  return "decision:" + createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export async function readDecision(key: string): Promise<CaseDecision | null> {
  if (!decisionCacheEnabled()) return null;
  try {
    const [hit] = await db
      .select({ response: schema.tnaSearchCache.response })
      .from(schema.tnaSearchCache)
      .where(and(eq(schema.tnaSearchCache.key, key), gt(schema.tnaSearchCache.createdAt, sql`now() - make_interval(days => ${DAYS})`)))
      .limit(1);
    return (hit?.response as CaseDecision | undefined) ?? null;
  } catch (err) {
    console.warn("[decision-cache] read failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

export async function writeDecision(key: string, decision: CaseDecision): Promise<void> {
  if (!decisionCacheEnabled()) return;
  await db
    .insert(schema.tnaSearchCache)
    .values({ key, response: decision })
    .onConflictDoUpdate({ target: schema.tnaSearchCache.key, set: { response: decision, createdAt: sql`now()` } })
    .catch((err) => console.warn("[decision-cache] write failed:", err instanceof Error ? err.message : err));
}
