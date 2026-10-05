/**
 * Web enrichment (Firecrawl search): the web is used for vocabulary and citations only.
 * Terms are accepted from any source; case names / NCNs only from UK legal sources.
 * Everything found here is verified against TNA before it is shown.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { and, eq, gt, sql } from "drizzle-orm";
import { db, schema as tables } from "@/db";
import { generateStructured, model, modelId, reasoningEffort, type TokenUsage } from "../llm";
import { webSearch, type WebResult } from "../web/firecrawl";
import { extractNcns } from "../tna/ncn";

export const UK_LEGAL_DOMAINS = [
  "judiciary.uk",
  "bailii.org",
  "nationalarchives.gov.uk",
  "supremecourt.uk",
  "lawgazette.co.uk",
  "legalfutures.co.uk",
  "casemine.com",
  "vlex.co.uk",
  "lawteacher.net",
  "legislation.gov.uk",
  "gov.uk",
  "11kbw.com",
  "brickcourt.co.uk",
  "4pb.com",
  "lexology.com",
  "localgovernmentlawyer.co.uk",
  "ukhumanrightsblog.com",
  "lawcf.co.uk",
];

export function isUkLegalSource(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return UK_LEGAL_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

const schema = z.object({
  terms: z.array(z.string()).describe("useful UK-English legal/technical vocabulary for the topic, max 12"),
  variants: z.array(z.string()).describe("up to 3 NEW short TNA keyword queries (1-4 words) suggested by the results"),
  cases: z
    .array(
      z.object({
        name: z.string(),
        ncn: z.string().nullish().describe("neutral citation like [2019] EWHC 123 (QB), if shown"),
        partyWord: z.string().nullish().describe("one distinctive word from a party name, e.g. Frazer-Nash"),
        sourceUrl: z.string(),
      }),
    )
    .describe("UK (England & Wales, Scotland, NI, UK-wide) court judgments explicitly mentioned. Exclude US, EU, Guernsey, Jersey and other jurisdictions."),
});

export interface WebHints {
  terms: string[];
  variants: string[];
  cases: { name: string; ncn: string | null; partyWord: string | null; sourceUrl: string }[];
  ncns: string[];
  results: WebResult[];
}

/** appended to the question so the web search leans towards UK judgments and commentary on them */
const QUERY_SUFFIX = process.env.WEB_QUERY_SUFFIX ?? "case law UK judgment";

/**
 * Cached for 24h in tna_search_cache under a "web:" key (fast model + suffix + normalised question),
 * so a repeated search does not pay for the web search and the extraction call again.
 * Empty results are not cached (a Firecrawl hiccup should not stick for a day).
 */
export async function webEnrich(query: string, usage: TokenUsage, signal?: AbortSignal): Promise<WebHints> {
  const norm = query.trim().toLowerCase().replace(/\s+/g, " ");
  const key = "web:" + createHash("sha256").update(JSON.stringify([modelId("fast"), QUERY_SUFFIX, norm])).digest("hex");
  try {
    const [hit] = await db
      .select({ response: tables.tnaSearchCache.response })
      .from(tables.tnaSearchCache)
      .where(and(eq(tables.tnaSearchCache.key, key), gt(tables.tnaSearchCache.createdAt, sql`now() - interval '24 hours'`)))
      .limit(1);
    if (hit) return hit.response as WebHints;
  } catch (err) {
    console.warn("[web] cache read failed:", err instanceof Error ? err.message : err);
  }
  const hints = await webEnrichUncached(query, usage, signal);
  if (hints.results.length) {
    await db
      .insert(tables.tnaSearchCache)
      .values({ key, response: hints })
      .onConflictDoUpdate({ target: tables.tnaSearchCache.key, set: { response: hints, createdAt: sql`now()` } })
      .catch((err) => console.warn("[web] cache write failed:", err instanceof Error ? err.message : err));
  }
  return hints;
}

async function webEnrichUncached(query: string, usage: TokenUsage, signal?: AbortSignal): Promise<WebHints> {
  const timeoutMs = Number(process.env.WEB_ENRICH_TIMEOUT_MS ?? 8000);
  const results = await webSearch(`${query} ${QUERY_SUFFIX}`.trim(), { limit: 8, timeoutMs });
  if (!results.length) return { terms: [], variants: [], cases: [], ncns: [], results };

  const listing = results
    .map((r, i) => `[${i + 1}] ${r.url}\n${r.title}\n${r.description}`)
    .join("\n\n");
  const output = await generateStructured({
    model: model("fast"),
    effort: reasoningEffort("fast"),
    system:
      "You extract research hints from web search results for a UK case-law search. Only report cases a result explicitly names; never invent citations.",
    prompt: `User question: ${query}\n\nSearch results:\n${listing}`,
    schema,
    usage,
    abortSignal: signal,
  });

  // citations only from UK legal sources; NCNs also regex-extracted from those snippets
  const ukResults = results.filter((r) => isUkLegalSource(r.url));
  const cases = output.cases
    .filter((c) => isUkLegalSource(c.sourceUrl))
    .map((c) => ({ ...c, ncn: c.ncn ?? null, partyWord: c.partyWord ?? null }));
  const ncns = new Set<string>();
  for (const r of ukResults) extractNcns(`${r.title} ${r.description}`).forEach((n) => ncns.add(n));
  for (const c of cases) if (c.ncn) extractNcns(c.ncn).forEach((n) => ncns.add(n));

  return {
    terms: output.terms.slice(0, 12),
    variants: output.variants.slice(0, 3),
    cases,
    ncns: [...ncns].slice(0, 5),
    results,
  };
}
