/**
 * Model selection, in order of precedence:
 *   OPENROUTER_API_KEY → OpenRouter (any model id, e.g. stealth/space-bunny-alpha)
 *   ANTHROPIC_API_KEY  → Anthropic directly
 *   otherwise          → Vercel AI Gateway (AI_GATEWAY_API_KEY locally, OIDC on Vercel)
 * A model id "ollama/<name>" always runs on local Ollama (e.g. LLM_FALLBACK_MODEL=ollama/gemma4:12b-mlx).
 * Fast tier: query expansion / web extraction. Strong tier: relevance pass.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { gateway, generateText, tool, type LanguageModel } from "ai";
import type { z } from "zod";

type Tier = "fast" | "strong";
type Provider = "openrouter" | "anthropic" | "gateway";

const DEFAULTS: Record<Provider, Record<Tier, string>> = {
  openrouter: { fast: "anthropic/claude-haiku-4.5", strong: "anthropic/claude-sonnet-5.5" },
  anthropic: { fast: "claude-haiku-4-5", strong: "claude-sonnet-5-5" },
  gateway: { fast: "anthropic/claude-haiku-4.5", strong: "anthropic/claude-sonnet-5.5" },
};

export function provider(): Provider {
  if (process.env.OPENROUTER_API_KEY) return "openrouter";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  return "gateway";
}

let anthropic: ReturnType<typeof createAnthropic> | null = null;
let openrouter: ReturnType<typeof createOpenRouter> | null = null;
let ollama: ReturnType<typeof createOpenAICompatible> | null = null;

/** "ollama/<model>" runs on the local Ollama server (OpenAI-compatible API), whatever the provider. */
export function modelById(id: string): LanguageModel {
  if (id.startsWith("ollama/")) {
    ollama ??= createOpenAICompatible({
      name: "ollama",
      baseURL: `${process.env.OLLAMA_URL ?? "http://localhost:11434"}/v1`,
    });
    return ollama(id.slice("ollama/".length));
  }
  switch (provider()) {
    case "openrouter":
      openrouter ??= createOpenRouter({
        apiKey: process.env.OPENROUTER_API_KEY,
        appName: "caselaw-agent",
      });
      return openrouter(id);
    case "anthropic":
      anthropic ??= createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      return anthropic(id);
    default:
      return gateway(id);
  }
}

export function modelId(tier: Tier): string {
  const override = tier === "fast" ? process.env.LLM_FAST_MODEL : process.env.LLM_STRONG_MODEL;
  return override || DEFAULTS[provider()][tier];
}

export function model(tier: Tier): LanguageModel {
  return modelById(modelId(tier));
}

type Effort = "xhigh" | "high" | "medium" | "low" | "minimal" | "none";
const EFFORTS = new Set<string>(["xhigh", "high", "medium", "low", "minimal", "none"]);

/** Reasoning effort per tier (OpenRouter only): LLM_FAST_REASONING / LLM_STRONG_REASONING. */
export function reasoningEffort(tier: Tier | "judge"): Effort | undefined {
  const v =
    tier === "fast" ? process.env.LLM_FAST_REASONING : tier === "strong" ? process.env.LLM_STRONG_REASONING : process.env.EVAL_JUDGE_REASONING;
  return v && EFFORTS.has(v) ? (v as Effort) : undefined;
}

/**
 * OpenRouter provider pinning per model: OPENROUTER_PROVIDERS="model=prov1,prov2;model2=prov3",
 * e.g. "deepseek/deepseek-v4-flash-0731=streamlake/fp8". Pinned models don't fall back to other
 * providers; a failure goes to LLM_FALLBACK_MODEL instead (see generateStructured).
 */
function providerRouting(id: string) {
  for (const rule of (process.env.OPENROUTER_PROVIDERS ?? "").split(";")) {
    const [m, provs] = rule.split("=").map((x) => x?.trim());
    if (m && provs && m === id) return { order: provs.split(",").map((p) => p.trim()), allow_fallbacks: false };
  }
  return undefined;
}

function providerOptionsFor(effort: Effort | undefined, id: string) {
  if (provider() !== "openrouter") return undefined;
  const routing = providerRouting(id);
  if (!effort && !routing) return undefined;
  return { openrouter: { ...(effort && { reasoning: { effort } }), ...(routing && { provider: routing }) } };
}

const idOf = (m: LanguageModel) => (typeof m === "string" ? m : m.modelId);

export function llmConfigured(): boolean {
  return Boolean(
    process.env.OPENROUTER_API_KEY ||
      process.env.ANTHROPIC_API_KEY ||
      process.env.AI_GATEWAY_API_KEY ||
      process.env.VERCEL_OIDC_TOKEN,
  );
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export function addUsage(acc: TokenUsage, u: { inputTokens?: number; outputTokens?: number } | undefined) {
  acc.inputTokens += u?.inputTokens ?? 0;
  acc.outputTokens += u?.outputTokens ?? 0;
}

/**
 * Structured output via a forced tool call. Some models (e.g. OpenRouter stealth models) ignore
 * `response_format: json_schema` but reliably fill tool arguments, and tool calling works on every
 * provider we use. The SDK validates the arguments against `schema`; one retry on failure.
 */
export async function generateStructured<S extends z.ZodType>(opts: {
  model: LanguageModel;
  system: string;
  prompt: string;
  schema: S;
  usage?: TokenUsage;
  abortSignal?: AbortSignal;
  /** OpenRouter reasoning effort; see reasoningEffort() */
  effort?: Effort;
  /** SDK retries for 429/5xx with exponential backoff (default 2) */
  maxRetries?: number;
}): Promise<z.infer<S>> {
  let lastErr: unknown;
  // second attempt: LLM_FALLBACK_MODEL if set (e.g. a free model when the pinned provider fails)
  const fallback = process.env.LLM_FALLBACK_MODEL;
  for (let attempt = 0; attempt < 2; attempt++) {
    const m = attempt === 1 && fallback ? modelById(fallback) : opts.model;
    if (attempt === 1 && fallback) console.warn(`[llm] ${idOf(opts.model)} failed (${String(lastErr).slice(0, 120)}); retrying with ${fallback}`);
    try {
      const result = await generateText({
        model: m,
        system: `${opts.system}\n\nReturn your answer by calling the \`submit\` tool exactly once.`,
        prompt: opts.prompt,
        tools: { submit: tool({ description: "Submit the final answer", inputSchema: opts.schema }) },
        toolChoice: { type: "tool", toolName: "submit" },
        abortSignal: opts.abortSignal,
        maxRetries: opts.maxRetries ?? (Number(process.env.LLM_MAX_RETRIES) || undefined),
        providerOptions: providerOptionsFor(opts.effort, idOf(m)),
      });
      if (opts.usage) addUsage(opts.usage, result.usage);
      const call = result.toolCalls.find((c) => c.toolName === "submit");
      if (!call) throw new Error(`model did not call submit (finish: ${result.finishReason})`);
      return opts.schema.parse(call.input);
    } catch (err) {
      if (opts.abortSignal?.aborted) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}
