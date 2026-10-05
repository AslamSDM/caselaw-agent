import { createHash } from "node:crypto";
import { z } from "zod";
import { and, eq, gt, sql } from "drizzle-orm";
import { db, schema as tables } from "@/db";
import { generateStructured, model, modelId, reasoningEffort, type TokenUsage } from "../llm";
import type { ExpandedQuery } from "./types";
import { areaLabel } from "../areas";
import { normalizeRange } from "../dates";

const schema = z.object({
  variants: z
    .array(z.string())
    .describe("5-8 TNA keyword queries, most specific first. 1-4 words each; use \"double quotes\" for exact phrases."),
  ftsTerms: z
    .array(z.string())
    .describe("8-20 single words or short phrases (synonyms, legal terms of art) to rank paragraphs inside a judgment"),
  filters: z
    .object({
      court: z.array(z.string()).nullish().describe("TNA court codes like ewca/civ, ewhc/ch, uksc — ONLY if the user asked for a court"),
      party: z.string().nullish().describe("one distinctive word from a party name, ONLY if the user named a party"),
      judge: z.string().nullish().describe("judge surname, ONLY if the user named a judge"),
    })
    .nullish(),
  dates: z
    .object({
      from: z.string().nullish().describe("YYYY-MM-DD inclusive start, or null"),
      to: z.string().nullish().describe("YYYY-MM-DD inclusive end, or null"),
      reason: z.string().nullish().describe("the words in the question that set this range"),
    })
    .nullish()
    .describe("judgment date range ONLY if the question states or clearly implies one; otherwise null"),
});

const SYSTEM = `You turn a natural-language legal research question into searches for the UK National Archives "Find Case Law" service (judgments of UK courts and tribunals).

How TNA search works: literal full-text AND matching over the judgment text. Every word must appear in the judgment. There is no stemming or relevance ranking. So:
- Long queries return nothing. Use 1-4 words per variant.
- Use the words a UK judge would actually write (e.g. "defective", "merchantable quality", "Consumer Rights Act", "battery pack", "thermal runaway", "negligent misstatement"), British spelling.
- Include specific variants (distinctive phrases, product names, statute names) and a couple of broader ones.
- Put multi-word terms of art in double quotes, e.g. "battery pack".
- Only set filters the user explicitly asked for.
- Dates: set a judgment date range only when the question asks for one ("since 2020", "in 2019", "last five years", "before March 2021", "recent" = last 5 years, "latest" = last 2 years). Resolve relative phrases against today's date. Do not infer dates from the subject matter (e.g. a statute's year or when events happened) — the user may want older or newer judgments about it. Keep date words out of the keyword variants.`;

/**
 * Cached for 24h in tna_search_cache under an "expand:" key. The key includes today's date
 * (relative dates like "recent" resolve against it), the model and the area filter.
 * EXPAND_CACHE=off disables it (e.g. to measure expansion variance in evals).
 */
export async function expandQuery(
  query: string,
  usage: TokenUsage,
  signal?: AbortSignal,
  areas: string[] = [],
): Promise<ExpandedQuery & { cached?: boolean }> {
  if (process.env.EXPAND_CACHE === "off") return expandUncached(query, usage, signal, areas);
  const today = new Date().toISOString().slice(0, 10);
  const norm = query.trim().toLowerCase().replace(/\s+/g, " ");
  const key = "expand:" + createHash("sha256").update(JSON.stringify([modelId("fast"), today, norm, [...areas].sort()])).digest("hex");
  try {
    const [hit] = await db
      .select()
      .from(tables.tnaSearchCache)
      .where(and(eq(tables.tnaSearchCache.key, key), gt(tables.tnaSearchCache.createdAt, sql`now() - interval '24 hours'`)))
      .limit(1);
    if (hit) return { ...(hit.response as ExpandedQuery), original: query, cached: true };
  } catch (err) {
    console.warn("[expand] cache read failed:", err instanceof Error ? err.message : err);
  }
  const out = await expandUncached(query, usage, signal, areas);
  await db
    .insert(tables.tnaSearchCache)
    .values({ key, response: out })
    .onConflictDoUpdate({ target: tables.tnaSearchCache.key, set: { response: out, createdAt: sql`now()` } })
    .catch((err) => console.warn("[expand] cache write failed:", err instanceof Error ? err.message : err));
  return out;
}

async function expandUncached(
  query: string,
  usage: TokenUsage,
  signal: AbortSignal | undefined,
  areas: string[],
): Promise<ExpandedQuery> {
  const areaHint = areas.length
    ? `\nThe user only wants cases in these areas of law: ${areas.map(areaLabel).join(", ")}. Use that field's vocabulary.`
    : "";
  const output = await generateStructured({
    model: model("fast"),
    effort: reasoningEffort("fast"),
    system: SYSTEM,
    prompt: `Today's date: ${new Date().toISOString().slice(0, 10)}\nResearch question: ${query}${areaHint}`,
    schema,
    usage,
    abortSignal: signal,
  });
  const variants = [...new Set(output.variants.map((v) => v.trim()).filter(Boolean))].slice(0, 8);
  return {
    original: query,
    variants: variants.length ? variants : [query],
    // expansion phrases only: the raw question's words ("are", "app", "entitled"…) matched almost
    // every paragraph and blew up the relevance prompt
    ftsTerms: [...new Set(output.ftsTerms.map((t) => t.trim()).filter(Boolean))].slice(0, 24),
    filters: {
      court: output.filters?.court?.length ? output.filters.court : undefined,
      party: output.filters?.party || undefined,
      judge: output.filters?.judge || undefined,
    },
    dates: output.dates ? normalizeRange({ from: output.dates.from ?? undefined, to: output.dates.to ?? undefined }) : null,
    datesReason: output.dates?.reason ?? null,
  };
}
