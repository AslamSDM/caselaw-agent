import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { ensureCase, getElements, markOpened } from "@/lib/cases/store";
import { tnaCaseUrl } from "@/lib/tna/client";
import { courtInfo } from "@/lib/courts";
import { areaLabel } from "@/lib/areas";
import { Judgment } from "@/components/judgment";
import type { ExpandedQuery } from "@/lib/search/types";

export default async function CasePage({ params, searchParams }: PageProps<"/case/[...uri]">) {
  const { uri: parts } = await params;
  const sp = await searchParams;
  const uri = parts.map(decodeURIComponent).join("/");
  const searchId = Number(typeof sp.search === "string" ? sp.search : NaN);

  const found = await ensureCase(uri, { refreshStale: true });
  if (!found) notFound();
  const kase = found.row;
  await markOpened(uri);

  const [elements, hls, search, cites] = await Promise.all([
    getElements(uri),
    Number.isFinite(searchId)
      ? db.select().from(schema.highlights).where(and(eq(schema.highlights.searchId, searchId), eq(schema.highlights.caseUri, uri)))
      : Promise.resolve([]),
    Number.isFinite(searchId)
      ? db.select().from(schema.searches).where(eq(schema.searches.id, searchId)).limit(1)
      : Promise.resolve([]),
    db.select().from(schema.citations).where(eq(schema.citations.fromUri, uri)),
  ]);
  const expanded = search[0]?.expanded as ExpandedQuery | null | undefined;
  const terms = search[0] ? [search[0].query, ...(expanded?.ftsTerms ?? [])] : [];
  const court = courtInfo(kase.court);
  const ordOf = new Map(elements.map((e) => [e.elementId, e.ord]));
  const sortedHls = [...hls].sort((a, b) => (ordOf.get(a.elementId) ?? 0) - (ordOf.get(b.elementId) ?? 0));

  const caseCites = dedupe(cites.filter((c) => c.type === "case"), (c) => c.toNcn ?? c.raw);
  const legislation = dedupe(cites.filter((c) => c.type === "legislation"), (c) => c.toLegislation ?? c.raw);

  return (
    <div className="mx-auto grid max-w-6xl gap-8 px-4 py-8 lg:grid-cols-[minmax(0,1fr)_320px]">
      <article className="min-w-0">
        <header className="mb-6 border-b border-border pb-4">
          {search[0] && (
            <Link href={`/?q=${encodeURIComponent(search[0].query)}`} className="text-xs text-muted hover:underline">
              ← results for “{search[0].query}”
            </Link>
          )}
          <h1 className="mt-1 text-2xl font-semibold leading-tight">{kase.name}</h1>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-sm text-muted">
            {kase.ncn && <span className="font-mono">{kase.ncn}</span>}
            <span>{court.label}</span>
            {kase.date && <span>{kase.date}</span>}
            {kase.judges.length > 0 && <span>{kase.judges.join(", ")}</span>}
            {kase.anonymised && <span className="rounded bg-surface px-1.5">anonymised</span>}
          </div>
          {kase.areas.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {kase.areas.map((a) => (
                <Link key={a} href={`/cases?area=${a}`} className="rounded bg-surface px-1.5 py-0.5 text-xs text-muted hover:underline">
                  {areaLabel(a)}
                </Link>
              ))}
              {!kase.areasClassified && <span className="text-xs text-muted">(from court)</span>}
            </div>
          )}
        </header>
        {elements.length ? (
          <Judgment elements={elements} highlights={hls} terms={terms} />
        ) : (
          <p className="text-muted">No full text available for this document.</p>
        )}
      </article>

      <aside className="space-y-6 text-sm lg:sticky lg:top-16 lg:max-h-[calc(100vh-5rem)] lg:overflow-y-auto">
        <a href={tnaCaseUrl(uri)} target="_blank" rel="noreferrer" className="block rounded border border-border px-3 py-2 text-center hover:border-accent">
          Open on Find Case Law ↗
        </a>

        {sortedHls.length > 0 && (
          <section>
            <h2 className="mb-2 font-semibold">Highlights</h2>
            <ul className="space-y-2">
              {sortedHls.map((h) => (
                <li key={h.id}>
                  <a href={`#${h.elementId}`} className="block rounded border border-border p-2 hover:border-accent">
                    <span className="font-mono text-xs text-muted">{h.elementId.replace(/^para_(\d+)/, "¶$1").replace(/__/g, " · ")}</span>
                    {h.kind === "quoted_clause" && <span className="ml-2 rounded bg-clause-hl px-1 text-[10px]">clause</span>}
                    <span className="mt-1 block font-serif line-clamp-3">“{h.quote}”</span>
                    {h.reason && <span className="mt-1 block text-xs text-muted">{h.reason}</span>}
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )}

        {legislation.length > 0 && (
          <section>
            <h2 className="mb-2 font-semibold">Legislation</h2>
            <div className="flex flex-wrap gap-1.5">
              {legislation.map((c) => (
                <a key={c.id} href={c.href?.replace("/id/", "/") ?? "#"} target="_blank" rel="noreferrer" className="rounded-full border border-border px-2 py-0.5 text-xs hover:border-accent">
                  {c.toLegislation ?? c.raw}
                </a>
              ))}
            </div>
          </section>
        )}

        {caseCites.length > 0 && (
          <section>
            <h2 className="mb-2 font-semibold">Cites {caseCites.length} cases</h2>
            <ul className="space-y-1">
              {caseCites.map((c) => (
                <li key={c.id} className="font-mono text-xs">
                  {c.toUri ? (
                    <Link href={`/case/${c.toUri}`} className="hover:underline">{c.toNcn ?? c.raw}</Link>
                  ) : (
                    <span className="text-muted">{c.raw}</span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
      </aside>
    </div>
  );
}

function dedupe<T>(xs: T[], key: (x: T) => string): T[] {
  const seen = new Set<string>();
  return xs.filter((x) => (seen.has(key(x)) ? false : (seen.add(key(x)), true)));
}
