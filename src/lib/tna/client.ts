/**
 * TNA Find Case Law API client: atom search + judgment XML fetch, through the shared limiter
 * with 429/5xx exponential backoff. Search responses are cached for 24h.
 */
import { createHash } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { acquireTnaSlot } from "./limiter";
import { parseAtom, type AtomPage } from "./atom";
import { TNA_BASE } from "./parser";
import { searchUrl, type TnaSearchParams } from "./urls";

export { searchUrl, type TnaSearchParams };

const UA = "caselaw-agent/0.1 (+https://github.com/; research prototype)";

async function tnaFetch(url: string, signal?: AbortSignal): Promise<Response> {
  let delay = 1000;
  for (let attempt = 0; attempt < 5; attempt++) {
    await acquireTnaSlot(signal);
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/xml" },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
    if (res.status !== 429 && res.status < 500) return res;
    const retryAfter = Number(res.headers.get("retry-after"));
    await new Promise((r) => setTimeout(r, retryAfter > 0 ? retryAfter * 1000 : delay));
    delay *= 2;
  }
  throw new Error(`TNA request failed after retries: ${url}`);
}

export async function searchTna(p: TnaSearchParams, signal?: AbortSignal): Promise<AtomPage & { cached: boolean }> {
  const url = searchUrl(p);
  const key = createHash("sha256").update(url).digest("hex");
  const hit = await db
    .select()
    .from(schema.tnaSearchCache)
    .where(and(eq(schema.tnaSearchCache.key, key), gt(schema.tnaSearchCache.createdAt, sql`now() - interval '24 hours'`)))
    .limit(1);
  if (hit[0]) return { ...(hit[0].response as AtomPage), cached: true };

  let res = await tnaFetch(url, signal);
  if (res.status === 400) {
    // TNA occasionally returns transient 400s: retry the identical request once
    await new Promise((r) => setTimeout(r, 1500));
    res = await tnaFetch(url, signal);
  }
  if (!res.ok && p.order === "relevance" && res.status >= 400 && res.status < 500) {
    // still rejected → maybe the undocumented sort; date order beats no results
    const body = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 160);
    console.warn(`[tna] ${res.status} with order=relevance (${body}); retrying in date order: ${url}`);
    return searchTna({ ...p, order: undefined }, signal);
  }
  if (!res.ok) throw new Error(`TNA search ${res.status} for ${url}`);
  const page = parseAtom(await res.text(), Math.min(p.perPage ?? 10, 50));
  await db
    .insert(schema.tnaSearchCache)
    .values({ key, response: page })
    .onConflictDoUpdate({ target: schema.tnaSearchCache.key, set: { response: page, createdAt: sql`now()` } });
  return { ...page, cached: false };
}

/** Returns null when the judgment does not exist (404). */
export async function fetchJudgmentXml(uri: string, signal?: AbortSignal): Promise<string | null> {
  const res = await tnaFetch(`${TNA_BASE}/${uri}/data.xml`, signal);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`TNA fetch ${res.status} for ${uri}`);
  return res.text();
}

export function tnaCaseUrl(uri: string, elementId?: string) {
  return `${TNA_BASE}/${uri}${elementId ? `#${elementId.split("__")[0]}` : ""}`;
}
