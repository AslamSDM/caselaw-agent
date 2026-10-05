/**
 * Follow-up chat agent (plan §6): answers questions about a search's results or one judgment,
 * using tools over the same building blocks as the search pipeline.
 *
 *   read_case       best paragraphs of a judgment for a question (keyword + semantic + reranker)
 *   get_citations   cases/statutes a judgment cites, or stored judgments citing it
 *   search_cases    the full search pipeline, for a new question
 *
 * Every factual statement must come from tool output or the provided context; quotes are copied
 * from paragraph text and linked to the paragraph in the judgment viewer.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { tool } from "ai";
import { z } from "zod";
import { db, schema } from "@/db";
import { ensureCase, getElements } from "../cases/store";
import { retrieveParagraphs } from "../search/retrieve";
import { runSearch } from "../search/pipeline";
import { embedQueries, embeddingsEnabled } from "../embed";
import { tnaCaseUrl } from "../tna/client";
import { paragraphLabel } from "./citations";

export interface ChatScope {
  searchId?: number;
  caseUri?: string;
}

/** "Mohamud v WM Morrison Supermarkets Plc" → "Mohamud v WM Morrison" (for citation links) */
const shortCaseName = (name: string) => {
  const n = name.replace(/\s*\((on the application of|in substitution)[^)]*\)/gi, "").replace(/\s+(&\s+)?(Anor|Ors|and others|and another)\.?$/i, "");
  const [a, b] = n.split(/\s+v\.?\s+/);
  const trim = (s: string) => s.split(/\s+/).slice(0, 3).join(" ").replace(/[,(]+$/, "");
  return b ? `${trim(a)} v ${trim(b)}` : trim(a);
};

const caseLink = (uri: string, elementId?: string) => `/case/${uri}${elementId ? `#${elementId}` : ""}`;

/** Context block describing what the user is looking at (search results or one judgment). */
export async function scopeContext(scope: ChatScope): Promise<string> {
  const parts: string[] = [];
  if (scope.searchId) {
    const [s] = await db.select().from(schema.searches).where(eq(schema.searches.id, scope.searchId));
    if (s) {
      const results = await db
        .select({ uri: schema.results.caseUri, score: schema.results.score, summary: schema.results.summary, name: schema.cases.name, ncn: schema.cases.ncn, court: schema.cases.court, date: schema.cases.date })
        .from(schema.results)
        .leftJoin(schema.cases, eq(schema.cases.uri, schema.results.caseUri))
        .where(and(eq(schema.results.searchId, s.id), eq(schema.results.relevant, true)))
        .orderBy(desc(schema.results.score));
      const hls = results.length
        ? await db
            .select()
            .from(schema.highlights)
            .where(and(eq(schema.highlights.searchId, s.id), inArray(schema.highlights.caseUri, results.map((r) => r.uri))))
        : [];
      parts.push(`The user ran the search: "${s.query}". ${results.length ? `Verified results (best first):` : "It found no strong matches."}`);
      for (const r of results) {
        parts.push(`- ${r.name} ${r.ncn ?? ""} (${r.court ?? "?"}, ${r.date ?? "?"}) uri=${r.uri} score=${r.score.toFixed(2)}\n  Summary: ${r.summary}`);
        for (const h of hls.filter((x) => x.caseUri === r.uri).slice(0, 4)) {
          parts.push(`  [${h.elementId}] "${h.quote.slice(0, 300)}"`);
        }
      }
    }
  }
  if (scope.caseUri) {
    const [c] = await db.select().from(schema.cases).where(eq(schema.cases.uri, scope.caseUri));
    if (c) parts.push(`The user is reading the judgment ${c.name} ${c.ncn ?? ""} (${c.court ?? "?"}, ${c.date ?? "?"}) uri=${c.uri}. Questions about "this case" mean this one.`);
  }
  return parts.join("\n") || "No search or judgment is selected.";
}

export function chatInstructions(context: string): string {
  return `You are a careful UK case-law research assistant. You help a lawyer follow up on search results from The National Archives' Find Case Law.

Rules:
- Base every statement about a judgment on tool output or the context below. If the tools do not show it, say you could not find it. Never rely on memory for what a judgment says.
- Before answering a question about what a judgment says, call read_case with a focused question. Call it once per judgment you discuss.
- Cite paragraphs for everything you say about a judgment: end each sentence or bullet with the citation link(s) of the paragraph(s) it comes from. Copy the "cite" value of that paragraph from read_case output exactly, e.g. [Uber v Aslam, ¶87](/case/uksc/2021/5#para_87). Never invent a link or paragraph number, and never cite a paragraph you have not read.
- Quote verbatim, in double quotes, copying text exactly from read_case output (no paraphrase inside quotes; use ... only to join parts of one paragraph). Quotes are checked word-for-word against what you read.
- For "who cites this", "what does it rely on", or follow-on authorities, use get_citations. Note that "cited by" only covers judgments stored locally.
- Use search_cases only for a genuinely new research question; it is slow (about 20 seconds).
- Be concise: short paragraphs or bullets, answer first. This is research help, not legal advice.

Context:
${context}`;
}

export function chatTools(signal?: AbortSignal) {
  return {
    read_case: tool({
      description:
        "Read the paragraphs of one judgment that best answer a question. Returns paragraph ids, numbers, text and links. Use the uri from the context or other tool results.",
      inputSchema: z.object({
        uri: z.string().describe("judgment uri, e.g. uksc/2021/5"),
        question: z.string().describe("what to look for in this judgment, in plain words"),
      }),
      execute: async ({ uri, question }) => {
        const found = await ensureCase(uri.replace(/^\/?case\//, "").replace(/^\/+|\/+$/g, ""), { signal });
        if (!found) return { error: `No judgment ${uri} on Find Case Law.` };
        const kase = found.row;
        const elements = await getElements(kase.uri);
        const [queryVec] = embeddingsEnabled() ? await embedQueries([question], signal).catch(() => [null]) : [null];
        const terms = question.split(/\W+/).filter((w) => w.length > 3);
        const ctx = await retrieveParagraphs(kase.uri, elements, terms.length ? terms : [question], {
          queryVec,
          rerankQuery: question,
          top: 8,
          neighboursFor: 2,
          signal,
        });
        const kids = new Map<string, string[]>();
        for (const e of ctx.all) if (e.parentId) kids.set(e.parentId, [...(kids.get(e.parentId) ?? []), e.elementId]);
        return {
          name: kase.name,
          ncn: kase.ncn,
          court: kase.court,
          date: kase.date,
          tnaUrl: tnaCaseUrl(kase.uri),
          paragraphs: ctx.topLevel.map((p, i) => {
            const label = paragraphLabel(p.num, p.elementId, i);
            const link = caseLink(kase.uri, p.elementId);
            return {
              id: p.elementId,
              num: p.num,
              label,
              link,
              /** copy this exactly to cite the paragraph */
              cite: `[${shortCaseName(kase.name)}, ${label}](${link})`,
              text: p.text.slice(0, 2500),
            };
          }),
          note: ctx.topLevel.length ? undefined : "No paragraph matched; try different wording.",
        };
      },
    }),

    get_citations: tool({
      description:
        "Citation graph for one judgment: direction 'cites' lists the cases and legislation it cites (with how often); 'cited_by' lists stored judgments that cite it.",
      inputSchema: z.object({
        uri: z.string(),
        direction: z.enum(["cites", "cited_by"]),
        limit: z.number().int().min(1).max(50).nullish(),
      }),
      execute: async ({ uri, direction, limit }) => {
        const n = limit ?? 20;
        const u = uri.replace(/^\/?case\//, "").replace(/^\/+|\/+$/g, "");
        if (direction === "cites") {
          const rows = await db.execute<{ type: string; target: string; to_uri: string | null; name: string | null; n: number }>(sql`
            SELECT ci.type, coalesce(ci.to_ncn, ci.to_legislation, ci.raw) AS target, ci.to_uri, c.name, count(*)::int AS n
            FROM citations ci LEFT JOIN cases c ON c.uri = ci.to_uri
            WHERE ci.from_uri = ${u}
            GROUP BY 1, 2, 3, 4 ORDER BY n DESC LIMIT ${n}`);
          if (!rows.length) return { note: "Judgment not stored yet: call read_case first, then retry." };
          return {
            cites: rows.map((r) => ({ type: r.type, target: r.target, name: r.name, times: r.n, link: r.to_uri ? caseLink(r.to_uri) : null })),
          };
        }
        const rows = await db.execute<{ uri: string; name: string; ncn: string | null; date: string | null; n: number }>(sql`
          SELECT c.uri, c.name, c.ncn, c.date::text, count(*)::int AS n
          FROM citations ci JOIN cases c ON c.uri = ci.from_uri
          WHERE ci.to_uri = ${u}
          GROUP BY c.uri ORDER BY c.date DESC NULLS LAST LIMIT ${n}`);
        return {
          citedBy: rows.map((r) => ({ name: r.name, ncn: r.ncn, date: r.date, times: r.n, link: caseLink(r.uri) })),
          note: "Only judgments stored locally (recent ingest + previously opened cases) are covered.",
        };
      },
    }),

    search_cases: tool({
      description: "Run a new case-law search (slow, ~20 s). Returns verified relevant judgments with summaries.",
      inputSchema: z.object({ query: z.string().describe("natural-language research question") }),
      execute: async ({ query }) => {
        const results: { name: string; ncn: string | null; date: string | null; summary: string; link: string; topQuote?: string }[] = [];
        for await (const e of runSearch(query, {}, signal)) {
          if (e.type === "result") {
            const h = e.result.highlights[0];
            results.push({
              name: e.result.name,
              ncn: e.result.ncn,
              date: e.result.date,
              summary: e.result.summary,
              link: caseLink(e.result.uri, h?.elementId),
              topQuote: h?.quote.slice(0, 300),
            });
          }
        }
        return results.length ? { results } : { note: "No strong matches." };
      },
    }),
  };
}
