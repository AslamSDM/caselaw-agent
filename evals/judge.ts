/**
 * LLM judge for returned cases that have no label, and for every highlight.
 * Evidence is gathered independently of the pipeline (FTS over the original query words only),
 * so the judge is not just re-reading the pipeline's own choice of paragraphs.
 * Verdicts are cached on disk so re-grading a saved run is free and stable.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { generateStructured, model, modelById, modelId, reasoningEffort } from "../src/lib/llm";
import { getCachedCase, getElements } from "../src/lib/cases/store";
import { retrieveParagraphs } from "../src/lib/search/retrieve";
import { buildCaseContext } from "../src/lib/search/relevance";
import type { JudgeVerdict, RecordedResult } from "./metrics";

const CACHE_DIR = new URL("./.cache/", import.meta.url);
const CACHE_FILE = new URL("judge.json", CACHE_DIR);
const MAX_HIGHLIGHTS = 3;

let cache: Record<string, JudgeVerdict> | null = null;
function loadCache() {
  if (cache) return cache;
  cache = existsSync(CACHE_FILE) ? JSON.parse(readFileSync(CACHE_FILE, "utf8")) : {};
  return cache!;
}
export function saveJudgeCache() {
  if (!cache) return;
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 1));
}

function judgeModel() {
  const id = process.env.EVAL_JUDGE_MODEL;
  // cache key must be the real model id, or switching models would reuse another model's grades
  return id ? { m: modelById(id), id } : { m: model("strong"), id: modelId("strong") };
}

const schema = z.object({
  grade: z.number().describe("0, 1, 2 or 3"),
  rationale: z.string(),
  highlights: z.array(z.object({ index: z.number().int(), supports: z.boolean() })),
});

const SYSTEM = `You grade search results for a UK case-law research tool. Be strict and independent.

Case grade:
3 = a leading or directly on-point authority for the question
2 = substantively deals with the question (useful to a lawyer researching it)
1 = tangential: same broad area, or the topic appears only in passing
0 = irrelevant (keyword coincidence, different subject)

Highlight check: for each numbered highlight, supports=true only if the quoted passage itself helps answer the question (not just shares words with it).`;

export async function judgeResult(query: string, r: RecordedResult): Promise<JudgeVerdict | null> {
  const { m, id } = judgeModel();
  const hls = r.highlights.slice(0, MAX_HIGHLIGHTS);
  const key = createHash("sha256")
    .update(JSON.stringify([id, query, r.uri, hls.map((h) => h.quote)]))
    .digest("hex");
  const c = loadCache();
  if (c[key]) return c[key];

  const kase = await getCachedCase(r.uri);
  if (!kase) return null;
  const elements = await getElements(r.uri);
  const words = query.split(/\s+/).filter((w) => w.length > 2);
  const ctx = await retrieveParagraphs(r.uri, elements, words, { top: 6 });
  const evidence = ctx.topLevel.length
    ? buildCaseContext(ctx)
    : elements.filter((e) => !e.parentId).slice(0, 6).map((e) => e.text.slice(0, 1200)).join("\n\n");

  const output = await generateStructured({
    model: m,
    effort: reasoningEffort("judge"),
    // free judge models are often rate-limited upstream: back off for up to ~2 min
    maxRetries: Number(process.env.EVAL_JUDGE_RETRIES ?? 6),
    system: SYSTEM,
    prompt: `Question: ${query}

Case: ${kase.name} ${kase.ncn ?? ""} (${kase.court ?? "?"}, ${kase.date ?? "?"})

Paragraphs matching the question's words:
${evidence}

Highlights the tool showed:
${hls.map((h, i) => `[${i}] (${h.elementId}) "${h.quote}"`).join("\n") || "(none)"}`,
    schema,
  });

  const verdict: JudgeVerdict = {
    grade: Math.min(3, Math.max(0, Math.round(output.grade))) as JudgeVerdict["grade"],
    rationale: output.rationale,
    highlightSupports: hls.map((_, i) => output.highlights.find((h) => h.index === i)?.supports ?? false),
  };
  c[key] = verdict;
  return verdict;
}
