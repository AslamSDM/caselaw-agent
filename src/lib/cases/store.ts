/**
 * Cache-first case store. Cases are parsed from TNA XML and stored as metadata + elements +
 * citations (raw XML is not kept). Stale cases (checked > 7 days ago) are re-fetched on open.
 */
import { asc, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { fetchJudgmentXml } from "../tna/client";
import { parseJudgment, type ParsedCase } from "../tna/parser";
import { courtAreas } from "../areas";

export type CaseRow = typeof schema.cases.$inferSelect;
export type ElementRow = Omit<typeof schema.elements.$inferSelect, "tsv" | "embedding">;

const STALE_MS = 7 * 24 * 3600 * 1000;

export async function getCachedCase(uri: string): Promise<CaseRow | null> {
  const rows = await db.select().from(schema.cases).where(eq(schema.cases.uri, uri)).limit(1);
  return rows[0] ?? null;
}

/** Fetch + parse + store if missing (or stale when `refreshStale`). Returns null if TNA has no such case. */
export async function ensureCase(
  uri: string,
  opts: { signal?: AbortSignal; refreshStale?: boolean } = {},
): Promise<{ row: CaseRow; fromCache: boolean } | null> {
  const cached = await getCachedCase(uri);
  const stale = cached && Date.now() - cached.checkedAt.getTime() > STALE_MS;
  if (cached && !(opts.refreshStale && stale)) return { row: cached, fromCache: true };

  const xml = await fetchJudgmentXml(uri, opts.signal);
  if (!xml) return cached ? { row: cached, fromCache: true } : null;
  const parsed = parseJudgment(xml);
  parsed.uri ||= uri;

  if (cached && cached.contentHash && cached.contentHash === parsed.contentHash) {
    await db.update(schema.cases).set({ checkedAt: new Date() }).where(eq(schema.cases.uri, uri));
    return { row: { ...cached, checkedAt: new Date() }, fromCache: true };
  }
  // keep LLM-classified areas across re-fetches
  const row = await saveParsedCase(parsed, uri, cached?.areasClassified ? cached.areas : undefined);
  return { row, fromCache: false };
}

export async function saveParsedCase(p: ParsedCase, requestedUri: string, classifiedAreas?: string[]): Promise<CaseRow> {
  const uri = requestedUri || p.uri;
  return db.transaction(async (tx) => {
    // an NCN can only belong to one row
    if (p.ncn) await tx.execute(sql`UPDATE cases SET ncn = NULL WHERE ncn = ${p.ncn} AND uri <> ${uri}`);
    const values = {
      uri,
      ncn: p.ncn,
      name: p.name,
      court: p.court,
      date: p.date,
      judges: p.judges,
      parties: p.parties,
      anonymised: p.anonymised,
      areas: classifiedAreas ?? courtAreas(p.court),
      areasClassified: Boolean(classifiedAreas),
      availability: p.elements.length ? "full-text" : "metadata",
      contentHash: p.contentHash,
      fetchedAt: new Date(),
      checkedAt: new Date(),
    };
    const [row] = await tx
      .insert(schema.cases)
      .values(values)
      .onConflictDoUpdate({ target: schema.cases.uri, set: values })
      .returning();
    await tx.delete(schema.elements).where(eq(schema.elements.caseUri, uri));
    await tx.delete(schema.citations).where(eq(schema.citations.fromUri, uri));
    await tx.delete(schema.chunks).where(eq(schema.chunks.caseUri, uri)); // legacy bge-small index (local-index branch); kept so that table stays consistent
    for (let i = 0; i < p.elements.length; i += 500) {
      await tx.insert(schema.elements).values(
        p.elements.slice(i, i + 500).map((e) => ({
          caseUri: uri,
          elementId: e.elementId,
          parentId: e.parentId,
          kind: e.kind,
          num: e.num,
          ord: e.ord,
          text: e.text,
          parts: e.parts,
        })),
      );
    }
    if (p.citations.length) {
      await tx.insert(schema.citations).values(p.citations.map((c) => ({ ...c, fromUri: uri })));
    }
    return row;
  });
}

export async function getElements(uri: string): Promise<ElementRow[]> {
  return db
    .select({
      caseUri: schema.elements.caseUri,
      elementId: schema.elements.elementId,
      parentId: schema.elements.parentId,
      kind: schema.elements.kind,
      num: schema.elements.num,
      ord: schema.elements.ord,
      text: schema.elements.text,
      parts: schema.elements.parts,
    })
    .from(schema.elements)
    .where(eq(schema.elements.caseUri, uri))
    .orderBy(asc(schema.elements.ord));
}

export async function markOpened(uri: string) {
  await db.update(schema.cases).set({ openedAt: new Date() }).where(eq(schema.cases.uri, uri));
}

/** Store areas classified by the relevance pass (merged with the court-derived guess). */
export async function setClassifiedAreas(uri: string, court: string | null, areas: string[]) {
  const merged = [...new Set([...areas, ...courtAreas(court)])].slice(0, 4);
  await db.update(schema.cases).set({ areas: merged, areasClassified: true }).where(eq(schema.cases.uri, uri));
  return merged;
}
