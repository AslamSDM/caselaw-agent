/**
 * Cross-encoder reranker (local, no API cost): bge-reranker-base via transformers.js / ONNX.
 * Scores (question, paragraph) pairs jointly, which separates "same doctrine, different facts"
 * from on-point passages far better than embedding similarity or keyword rank.
 *
 * Model (~280 MB, q8) downloads once into the transformers.js cache on first use.
 * RERANK_ENABLED=false turns it off; any load/run failure also falls back to the old ranking.
 */
import type { PreTrainedModel, PreTrainedTokenizer } from "@huggingface/transformers";

export const RERANK_MODEL = process.env.RERANK_MODEL ?? "Xenova/bge-reranker-base";
const BATCH = 16;
/** passage length scored; the opening of a paragraph carries most of its topic, and cost grows with length */
const MAX_CHARS = Number(process.env.RERANK_MAX_CHARS ?? 1000);
const MAX_TOKENS = 320;

export function rerankEnabled(): boolean {
  return process.env.RERANK_ENABLED !== "false";
}

let loaded: Promise<{ tok: PreTrainedTokenizer; model: PreTrainedModel }> | null = null;

function load() {
  loaded ??= import("@huggingface/transformers")
    .then(async ({ AutoTokenizer, AutoModelForSequenceClassification }) => ({
      tok: await AutoTokenizer.from_pretrained(RERANK_MODEL),
      model: await AutoModelForSequenceClassification.from_pretrained(RERANK_MODEL, { dtype: "q8" }),
    }))
    .catch((err) => {
      loaded = null; // retry on the next call
      throw err;
    });
  return loaded;
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/** Relevance of each passage to the query, 0–1, in input order. */
export async function rerankScores(query: string, passages: string[]): Promise<number[]> {
  if (!passages.length) return [];
  const { tok, model } = await load();
  const out: number[] = [];
  for (let i = 0; i < passages.length; i += BATCH) {
    const slice = passages.slice(i, i + BATCH).map((p) => p.slice(0, MAX_CHARS));
    const inputs = tok(new Array(slice.length).fill(query), { text_pair: slice, padding: true, truncation: true, max_length: MAX_TOKENS });
    const { logits } = await model(inputs);
    out.push(...Array.from(logits.data as Float32Array, sigmoid));
  }
  return out;
}

/** Load the model ahead of the first search (call at server start; errors are ignored). */
export function warmReranker() {
  if (rerankEnabled()) load().catch(() => {});
}
