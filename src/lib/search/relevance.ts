/**
 * Relevance pass: the strong model reads the retrieved paragraphs of one judgment and decides
 * whether the case is genuinely about the user's question, returning verbatim quotes to highlight.
 * Quotes are then verified against the source (verify.ts); unverifiable ones are dropped.
 */
import { z } from "zod";
import { generateStructured, model, reasoningEffort, type TokenUsage } from "../llm";
import type { CaseRow, ElementRow } from "../cases/store";
import { RENDER_CAPS, renderedDescendants, type RetrievedContext } from "./retrieve";
import { verifyQuote } from "./verify";
import { AREAS, AREA_IDS, isAreaId } from "../areas";
import type { HighlightKind, VerifiedHighlight } from "./types";

const schema = z.object({
  relevant: z.boolean().describe("true only if the case substantively deals with the question"),
  score: z.number().describe("0-1 relevance; incidental keyword mentions score below 0.3"),
  summary: z.string().describe("one sentence: what the case is about and how it bears on the question"),
  areas: z
    .array(z.string())
    .describe(`1-3 area ids the CASE itself is about (independent of the question), most important first. One of: ${AREA_IDS.join(", ")}`),
  highlights: z
    .array(
      // fields are optional so one truncated highlight (seen with long outputs) is dropped
      // below instead of failing validation for the whole case
      z.object({
        element_id: z.string().nullish().describe("id of the SMALLEST element containing the quote (a quote/sub id if applicable)"),
        kind: z.string().nullish().describe('one of "paragraph", "quoted_clause", "legislation_ref"'),
        quote: z.string().nullish().describe("verbatim text copied exactly from that element, 8-60 words"),
        reason: z.string().nullish().describe("why this passage matters for the question, max 20 words"),
      }),
    )
    .describe("at most 8"),
});

function renderElement(
  e: ElementRow,
  children: Map<string, ElementRow[]>,
  shown: Set<string>,
  indent = "",
): string {
  // show own text parts only; nested elements are rendered as their own tagged lines
  const cap = indent ? RENDER_CAPS.childChars : RENDER_CAPS.ownChars;
  const own = e.parts
    .map((p) => ("t" in p ? p.t : `{${p.c}}`))
    .join(" ")
    .slice(0, cap);
  const label = e.num ? ` n="${e.num}"` : "";
  const lines = [`${indent}<el id="${e.elementId}" kind="${e.kind}"${label}>${own}`];
  const kids = children.get(e.elementId) ?? [];
  for (const k of kids) if (shown.has(k.elementId)) lines.push(renderElement(k, children, shown, indent + "  "));
  lines.push(`${indent}</el>`);
  return lines.join("\n");
}

/** Renders the selected paragraphs with the same caps retrieve.ts budgets for (RENDER_CAPS). */
export function buildCaseContext(ctx: Pick<RetrievedContext, "topLevel" | "all">): string {
  const children = new Map<string, ElementRow[]>();
  for (const e of ctx.all) {
    if (!e.parentId) continue;
    const list = children.get(e.parentId) ?? [];
    list.push(e);
    children.set(e.parentId, list);
  }
  return ctx.topLevel
    .map((root) => {
      const desc = renderedDescendants(root, children);
      const shown = new Set(desc.map((d) => d.elementId));
      let omitted = 0;
      const count = (e: ElementRow) => (children.get(e.elementId) ?? []).forEach((k) => (omitted++, count(k)));
      count(root);
      omitted -= desc.length;
      const out = renderElement(root, children, shown);
      return omitted > 0 ? `${out}\n  (${omitted} more nested passages omitted)` : out;
    })
    .join("\n");
}

export interface RelevanceOutcome {
  relevant: boolean;
  score: number;
  summary: string;
  areas: string[];
  highlights: VerifiedHighlight[];
  proposed: number;
}

export async function judgeRelevance(
  query: string,
  kase: CaseRow,
  ctx: RetrievedContext,
  usage: TokenUsage,
  signal?: AbortSignal,
): Promise<RelevanceOutcome> {
  const system = `You are a careful UK legal research assistant. Decide whether a judgment is genuinely relevant to the user's research question, and point to the exact passages that show it.

Rules:
- A case is relevant only if its facts, issues or reasoning deal with the question. Keyword coincidences (a word appearing in passing, a party name, a cited case title) are NOT relevance.
- Sharing only the general area of law, a statute or a doctrine with the question is NOT enough. If the case's facts and the issue it decides differ from what the question asks about, it is tangential: relevant=false, score at most 0.4, and say what is missing. Exception: a case that decides the very legal issue the question turns on is relevant even on different facts.
- When the question describes an unusual situation (a specific product, animal, place or activity) and the judgment does not involve anything like it, treat it as tangential unless the reasoning is clearly the governing authority for that situation.
- Quotes must be copied character-for-character from the element text. Do not paraphrase, join separate passages, or add ellipses.
- Use the id of the smallest element containing the quote. Use kind "quoted_clause" when the quote is from a contract/statute/document quoted in the judgment (quote_block elements), "legislation_ref" when the passage turns on a statutory provision.
- If not relevant, return relevant=false, a low score, a summary saying why it falls short, and no highlights.
- Always classify the case's areas of law from: ${AREAS.map((a) => `${a.id} (${a.label})`).join(", ")}.`;

  const prompt = `Research question: ${query}

Case: ${kase.name}${kase.ncn ? ` ${kase.ncn}` : ""} — ${kase.court ?? "unknown court"}, ${kase.date ?? "undated"}

Paragraphs retrieved from the judgment (by keyword and meaning similarity; other paragraphs omitted). Retrieval casts a wide net, so most cases you see will NOT be relevant:
${buildCaseContext(ctx)}`;

  const output = await generateStructured({
    model: model("strong"),
    effort: reasoningEffort("strong"),
    system,
    prompt,
    schema,
    usage,
    abortSignal: signal,
  });

  const verified: VerifiedHighlight[] = [];
  const seen = new Set<string>();
  // weaker models overshoot bounds; clamp instead of failing the case
  const KINDS = new Set<string>(["paragraph", "quoted_clause", "legislation_ref"]);
  for (const h of output.highlights.slice(0, 8)) {
    if (!h.quote || !h.element_id) continue;
    const m = verifyQuote(h.quote, h.element_id, ctx.all);
    if (!m) continue;
    const key = `${m.elementId}|${m.matchedText}`;
    if (seen.has(key)) continue;
    seen.add(key);
    verified.push({
      elementId: m.elementId,
      kind: (h.kind && KINDS.has(h.kind) ? h.kind : "paragraph") as HighlightKind,
      quote: m.matchedText,
      reason: h.reason ?? "",
      similarity: m.similarity,
    });
  }

  return {
    relevant: output.relevant,
    score: Math.min(1, Math.max(0, output.score)),
    summary: output.summary,
    // unknown ids (e.g. "employment law") are dropped rather than failing the case
    areas: [...new Set(output.areas.map((a) => a.trim().toLowerCase()).filter(isAreaId))].slice(0, 3),
    highlights: verified,
    proposed: output.highlights.length,
  };
}
