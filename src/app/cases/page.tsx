import Link from "next/link";
import { and, desc, ilike, or, sql, type SQL } from "drizzle-orm";
import { db, schema } from "@/db";
import { courtInfo } from "@/lib/courts";
import { AREAS, areaLabel } from "@/lib/areas";
import { parseDateInput } from "@/lib/dates";

export default async function CasesPage({ searchParams }: PageProps<"/cases">) {
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q.trim() : "";
  const court = typeof sp.court === "string" ? sp.court : "";
  const area = typeof sp.area === "string" ? sp.area : "";
  const fromRaw = typeof sp.from === "string" ? sp.from : "";
  const toRaw = typeof sp.to === "string" ? sp.to : "";
  const from = parseDateInput(fromRaw, "from");
  const to = parseDateInput(toRaw, "to");

  const where: SQL[] = [];
  if (q) {
    where.push(
      or(
        ilike(schema.cases.name, `%${q}%`),
        ilike(schema.cases.ncn, `%${q}%`),
        sql`${schema.cases.judges}::text ILIKE ${`%${q}%`}`,
        sql`${schema.cases.parties}::text ILIKE ${`%${q}%`}`,
      )!,
    );
  }
  if (court) where.push(ilike(schema.cases.court, `${court}%`));
  if (area) where.push(sql`${schema.cases.areas} ? ${area}`);
  if (from) where.push(sql`${schema.cases.date} >= ${from}`);
  if (to) where.push(sql`${schema.cases.date} <= ${to}`);

  const [cases, courts, searches, [{ count }]] = await Promise.all([
    db
      .select({
        uri: schema.cases.uri,
        name: schema.cases.name,
        ncn: schema.cases.ncn,
        court: schema.cases.court,
        date: schema.cases.date,
        anonymised: schema.cases.anonymised,
        areas: schema.cases.areas,
        paragraphs: sql<number>`(SELECT count(*)::int FROM elements e WHERE e.case_uri = ${schema.cases.uri} AND e.parent_id IS NULL)`,
      })
      .from(schema.cases)
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(schema.cases.fetchedAt))
      .limit(200),
    db.selectDistinct({ court: schema.cases.court }).from(schema.cases),
    db
      .select({
        id: schema.searches.id,
        query: schema.searches.query,
        createdAt: schema.searches.createdAt,
        relevant: sql<number>`(SELECT count(*)::int FROM results r WHERE r.search_id = ${schema.searches.id} AND r.relevant)`,
      })
      .from(schema.searches)
      .where(sql`coalesce(${schema.searches.filters}->>'source', 'ui') <> 'eval'`)
      .orderBy(desc(schema.searches.createdAt))
      .limit(30),
    db.select({ count: sql<number>`count(*)::int` }).from(schema.cases),
  ]);

  return (
    <div className="mx-auto grid max-w-6xl gap-8 px-4 py-8 lg:grid-cols-[minmax(0,1fr)_300px]">
      <section>
        <h1 className="text-xl font-semibold">Cached cases <span className="text-muted">({count})</span></h1>
        <form className="mt-4 flex flex-wrap gap-2 text-sm">
          <input name="q" defaultValue={q} placeholder="Name, citation, judge or party" className="flex-1 rounded border border-border bg-surface px-3 py-2" />
          <select name="court" defaultValue={court} className="rounded border border-border bg-surface px-2 py-2">
            <option value="">All courts</option>
            {courts
              .map((c) => c.court)
              .filter((c): c is string => Boolean(c))
              .sort()
              .map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
          </select>
          <select name="area" defaultValue={area} className="rounded border border-border bg-surface px-2 py-2">
            <option value="">All areas</option>
            {AREAS.map((a) => (
              <option key={a.id} value={a.id}>{a.label}</option>
            ))}
          </select>
          <input name="from" defaultValue={fromRaw} placeholder="from YYYY" className="w-28 rounded border border-border bg-surface px-2 py-2" />
          <input name="to" defaultValue={toRaw} placeholder="to YYYY" className="w-28 rounded border border-border bg-surface px-2 py-2" />
          <button className="rounded bg-accent px-4 py-2 text-white dark:text-black">Filter</button>
        </form>
        <table className="mt-4 w-full text-sm">
          <thead className="text-left text-xs text-muted">
            <tr>
              <th className="py-2">Case</th>
              <th>Court</th>
              <th>Date</th>
              <th className="text-right">¶</th>
            </tr>
          </thead>
          <tbody>
            {cases.map((c) => (
              <tr key={c.uri} className="border-t border-border align-top">
                <td className="py-2 pr-3">
                  <Link href={`/case/${c.uri}`} className="hover:underline">{c.name}</Link>
                  <div className="font-mono text-xs text-muted">{c.ncn}{c.anonymised && " · anonymised"}</div>
                  {c.areas.length > 0 && <div className="text-xs text-muted">{c.areas.map(areaLabel).join(" · ")}</div>}
                </td>
                <td className="pr-3 text-muted">{courtInfo(c.court).label}</td>
                <td className="whitespace-nowrap pr-3 text-muted">{c.date}</td>
                <td className="text-right tabular-nums text-muted">{c.paragraphs}</td>
              </tr>
            ))}
            {!cases.length && (
              <tr>
                <td colSpan={4} className="py-6 text-center text-muted">No cached cases yet — run a search.</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
      <aside className="text-sm">
        <h2 className="font-semibold">Search history</h2>
        <ul className="mt-3 space-y-2">
          {searches.map((s) => (
            <li key={s.id} className="rounded border border-border p-2">
              <Link href={`/?q=${encodeURIComponent(s.query)}`} className="hover:underline">{s.query}</Link>
              <div className="text-xs text-muted">
                {s.relevant} relevant · {s.createdAt.toISOString().slice(0, 16).replace("T", " ")}
              </div>
            </li>
          ))}
          {!searches.length && <li className="text-muted">No searches yet.</li>}
        </ul>
      </aside>
    </div>
  );
}
