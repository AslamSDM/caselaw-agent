/**
 * Citation graphs built from the citations table (parsed from every stored judgment).
 *
 *   caseGraph(uri)       one judgment: what it cites, which stored judgments cite it, statutes,
 *                        and the citation links among those neighbours
 *   searchGraph(id)      a search's verified results and the authorities several of them share
 *
 * "Cited by" and node sizes only count judgments stored locally (the past-year ingest plus cases
 * opened or searched), so they are lower bounds.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { courtInfo } from "./courts";
import { ncnToUri } from "./tna/ncn";

export type NodeRole = "center" | "cites" | "cited_by" | "both" | "result" | "shared" | "legislation";

export interface GraphNode {
  id: string;
  label: string;
  name: string | null;
  ncn: string | null;
  uri: string | null;
  court: string;
  level: number;
  year: string | null;
  role: NodeRole;
  /** stored judgments citing this node (whole local corpus) */
  citedBy: number;
  /** we have the judgment text locally */
  stored: boolean;
  /** Find Case Law publishes it (not Privy Council / House of Lords) */
  onTna: boolean;
}

const NOT_ON_TNA = /^(ukpc|ukhl)\//;

export interface GraphEdge {
  source: string;
  target: string;
  /** how many times the source cites the target */
  weight: number;
}

export interface CitationGraph {
  title: string;
  subtitle: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** cited cases left out to keep the graph readable */
  omitted: number;
}

const MAX_CITES = Number(process.env.GRAPH_MAX_CITES ?? 40);
const MAX_CITED_BY = Number(process.env.GRAPH_MAX_CITED_BY ?? 40);
const MAX_LEGISLATION = 10;
const MAX_SHARED = 30;

const yearOf = (ncn: string | null, date: string | null) => date?.slice(0, 4) ?? ncn?.match(/\[(\d{4})\]/)?.[1] ?? null;
const shortName = (name: string) => {
  const n = name.replace(/\s*\((on the application of|in substitution)[^)]*\)/gi, "").replace(/\s+&\s+(Anor|Ors)\.?/g, "");
  return n.length > 38 ? n.slice(0, 36) + "…" : n;
};

/** Metadata + local in-degree for a set of case uris. */
async function describe(uris: string[]) {
  if (!uris.length) return { meta: new Map(), indeg: new Map<string, number>() };
  const [rows, deg] = await Promise.all([
    db
      .select({ uri: schema.cases.uri, name: schema.cases.name, ncn: schema.cases.ncn, court: schema.cases.court, date: schema.cases.date })
      .from(schema.cases)
      .where(inArray(schema.cases.uri, uris)),
    db
      .select({ uri: schema.citations.toUri, n: sql<number>`count(DISTINCT ${schema.citations.fromUri})::int` })
      .from(schema.citations)
      .where(inArray(schema.citations.toUri, uris))
      .groupBy(schema.citations.toUri),
  ]);
  return {
    meta: new Map(rows.map((r) => [r.uri, r])),
    indeg: new Map(deg.map((d) => [d.uri!, Number(d.n)])),
  };
}

function caseNode(
  uri: string,
  ncn: string | null,
  role: NodeRole,
  d: Awaited<ReturnType<typeof describe>>,
): GraphNode {
  const m = d.meta.get(uri) as { name: string; ncn: string | null; court: string | null; date: string | null } | undefined;
  const ci = courtInfo(m?.court ?? uri.split("/").slice(0, 2).join("-"));
  const theNcn = m?.ncn ?? ncn;
  return {
    id: uri,
    label: m?.name ? shortName(m.name) : (theNcn ?? uri),
    name: m?.name ?? null,
    ncn: theNcn,
    uri,
    court: ci.label,
    level: ci.level,
    year: yearOf(theNcn, m?.date ?? null),
    role,
    citedBy: d.indeg.get(uri) ?? 0,
    stored: Boolean(m),
    onTna: !NOT_ON_TNA.test(uri),
  };
}

/** Links among a set of nodes (source must be a stored judgment in the set). */
async function edgesAmong(ids: string[]): Promise<GraphEdge[]> {
  if (ids.length < 2) return [];
  const rows = await db
    .select({ from: schema.citations.fromUri, to: schema.citations.toUri, n: sql<number>`count(*)::int` })
    .from(schema.citations)
    .where(and(inArray(schema.citations.fromUri, ids), inArray(schema.citations.toUri, ids), eq(schema.citations.type, "case")))
    .groupBy(schema.citations.fromUri, schema.citations.toUri);
  return rows.filter((r) => r.to && r.from !== r.to).map((r) => ({ source: r.from, target: r.to!, weight: Number(r.n) }));
}

export async function caseGraph(uri: string): Promise<CitationGraph | null> {
  const [center] = await db.select().from(schema.cases).where(eq(schema.cases.uri, uri));
  if (!center) return null;

  const out = await db
    .select({ toUri: schema.citations.toUri, toNcn: schema.citations.toNcn, type: schema.citations.type, leg: schema.citations.toLegislation, raw: schema.citations.raw })
    .from(schema.citations)
    .where(eq(schema.citations.fromUri, uri));
  // cases it cites (resolved to a TNA uri), with counts
  const cites = new Map<string, { ncn: string | null; n: number }>();
  const legislation = new Map<string, number>();
  for (const c of out) {
    if (c.type === "legislation") {
      const k = (c.leg ?? c.raw).trim();
      legislation.set(k, (legislation.get(k) ?? 0) + 1);
      continue;
    }
    const u = c.toUri ?? (c.toNcn ? ncnToUri(c.toNcn) : null);
    if (!u || u === uri) continue;
    const e = cites.get(u) ?? { ncn: c.toNcn, n: 0 };
    e.n++;
    cites.set(u, e);
  }
  const citesTop = [...cites.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, MAX_CITES);

  // stored judgments citing it (by uri, or by NCN text when the link was not resolved)
  const inbound = await db.execute<{ from_uri: string; n: number }>(sql`
    SELECT from_uri, count(*)::int AS n FROM citations
    WHERE type = 'case' AND from_uri <> ${uri}
      AND (to_uri = ${uri} ${center.ncn ? sql`OR (to_uri IS NULL AND to_ncn = ${center.ncn})` : sql``})
    GROUP BY from_uri ORDER BY n DESC LIMIT ${MAX_CITED_BY}`);

  const citedBy = new Map(inbound.map((r) => [r.from_uri, Number(r.n)]));
  const ids = [uri, ...new Set([...citesTop.map(([u]) => u), ...citedBy.keys()])];
  const d = await describe(ids);

  const nodes: GraphNode[] = [caseNode(uri, center.ncn, "center", d)];
  const edges: GraphEdge[] = [];
  for (const [u, e] of citesTop) {
    nodes.push(caseNode(u, e.ncn, citedBy.has(u) ? "both" : "cites", d));
    edges.push({ source: uri, target: u, weight: e.n });
  }
  for (const [u, n] of citedBy) {
    if (!nodes.some((x) => x.id === u)) nodes.push(caseNode(u, null, "cited_by", d));
    edges.push({ source: u, target: uri, weight: n });
  }
  // links among the neighbours themselves (shows clusters of related authorities)
  const seen = new Set(edges.map((e) => `${e.source}>${e.target}`));
  for (const e of await edgesAmong(ids)) if (!seen.has(`${e.source}>${e.target}`)) edges.push(e);

  for (const [k, n] of [...legislation.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_LEGISLATION)) {
    const id = `leg:${k}`;
    nodes.push({ id, label: k.length > 34 ? k.slice(0, 32) + "…" : k, name: k, ncn: null, uri: null, court: "Legislation", level: 0, year: null, role: "legislation", citedBy: 0, stored: false, onTna: false });
    edges.push({ source: uri, target: id, weight: n });
  }

  return {
    title: center.name,
    subtitle: `${center.ncn ?? uri} · cites ${cites.size} cases and ${legislation.size} statutory provisions · cited by ${citedBy.size} stored judgments`,
    nodes,
    edges,
    omitted: Math.max(0, cites.size - citesTop.length),
  };
}

export async function searchGraph(searchId: number): Promise<CitationGraph | null> {
  const [s] = await db.select().from(schema.searches).where(eq(schema.searches.id, searchId));
  if (!s) return null;
  const results = await db
    .select({ uri: schema.results.caseUri })
    .from(schema.results)
    .where(and(eq(schema.results.searchId, searchId), eq(schema.results.relevant, true)));
  const resultUris = results.map((r) => r.uri);
  if (!resultUris.length) return { title: s.query, subtitle: "No verified results to graph.", nodes: [], edges: [], omitted: 0 };

  const rows = await db
    .select({ from: schema.citations.fromUri, toUri: schema.citations.toUri, toNcn: schema.citations.toNcn })
    .from(schema.citations)
    .where(and(inArray(schema.citations.fromUri, resultUris), eq(schema.citations.type, "case")));
  // authorities cited by 2+ results; links between results are always kept
  const citers = new Map<string, { ncn: string | null; from: Map<string, number> }>();
  for (const r of rows) {
    const u = r.toUri ?? (r.toNcn ? ncnToUri(r.toNcn) : null);
    if (!u || u === r.from) continue;
    const e = citers.get(u) ?? { ncn: r.toNcn, from: new Map<string, number>() };
    e.from.set(r.from, (e.from.get(r.from) ?? 0) + 1);
    citers.set(u, e);
  }
  const resultSet = new Set(resultUris);
  const shared = [...citers.entries()]
    .filter(([u, e]) => !resultSet.has(u) && e.from.size >= 2)
    .sort((a, b) => b[1].from.size - a[1].from.size);
  const sharedTop = shared.slice(0, MAX_SHARED);

  const ids = [...resultUris, ...sharedTop.map(([u]) => u)];
  const d = await describe(ids);
  const nodes = [
    ...resultUris.map((u) => caseNode(u, null, "result", d)),
    ...sharedTop.map(([u, e]) => caseNode(u, e.ncn, "shared", d)),
  ];
  const edges: GraphEdge[] = [];
  for (const [u, e] of citers) {
    if (!resultSet.has(u) && !sharedTop.some(([x]) => x === u)) continue;
    for (const [from, n] of e.from) edges.push({ source: from, target: u, weight: n });
  }
  return {
    title: s.query,
    subtitle: `${resultUris.length} verified results · ${shared.length} authorities cited by two or more of them`,
    nodes,
    edges,
    omitted: Math.max(0, shared.length - sharedTop.length),
  };
}
