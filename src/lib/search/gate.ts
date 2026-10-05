/**
 * Relevance pre-screen with a decisions model (TypeSafe Jev via OpenRouter's /api/alpha/decisions).
 *
 * Jev returns a typed choice with probabilities, not text, so it cannot produce the verbatim
 * quotes the highlights need. It runs before the strong judge: cases it is confident are
 * tangential or unrelated are rejected without a strong-model call. Everything else goes on to
 * judgeRelevance() as before.
 *
 * Batching: one decisions request carries several cases (state = question + case_1..n, one
 * question per case), so the instructions and request overhead are paid once per batch. Cases
 * arrive one at a time from the pipeline's workers; a batch flushes when it is full, when the
 * next case would overflow the model's context, or GATE_BATCH_WAIT_MS after its first case.
 *
 * Enabled when JUDGE_GATE_MODEL is set (e.g. typesafe/jev-1.13) and OPENROUTER_API_KEY exists.
 */
import type { CaseRow } from "../cases/store";
import { buildCaseContext } from "./relevance";
import type { RetrievedContext } from "./retrieve";

const URL = process.env.OPENROUTER_DECISIONS_URL ?? "https://openrouter.ai/api/alpha/decisions";
/** reject when P(tangential) + P(irrelevant) is at least this */
const REJECT_AT = Number(process.env.JUDGE_GATE_REJECT ?? 0.75);
/** Jev's context is 32k tokens (~4 chars each); keep a batch's state well inside it */
const MAX_BATCH_CHARS = Number(process.env.GATE_BATCH_CHARS ?? 80_000);
const MAX_BATCH = Number(process.env.GATE_BATCH_SIZE ?? 6);
const WAIT_MS = Number(process.env.GATE_BATCH_WAIT_MS ?? 400);
const TIMEOUT_MS = Number(process.env.JUDGE_GATE_TIMEOUT_MS ?? 20_000);

export function gateModel(): string | null {
  const m = process.env.JUDGE_GATE_MODEL;
  return m && process.env.OPENROUTER_API_KEY ? m : null;
}

export interface GateVerdict {
  choice: "on_point" | "tangential" | "irrelevant";
  probabilities: Record<string, number>;
  confidence: number;
  /** P(on_point); stored as the case score when the gate rejects */
  onPoint: number;
  reject: boolean;
}

export interface GateStats {
  model: string;
  /** decisions requests sent */
  requests: number;
  /** cases screened */
  cases: number;
  rejected: number;
  errors: number;
  costUsd: number;
}

const CRITERIA = {
  on_point: "decides the legal issue the question asks about, on similar facts or as the governing authority",
  tangential: "same area of law or statute, but different facts or a different issue",
  irrelevant: "unrelated; matches are keyword coincidences",
};

/** Render one case for the batch state (also used to size batches). */
export function caseState(kase: CaseRow, ctx: Pick<RetrievedContext, "topLevel" | "all">, maxChars = MAX_BATCH_CHARS): string {
  return (
    `${kase.name}${kase.ncn ? ` ${kase.ncn}` : ""} (${kase.court ?? "unknown court"}, ${kase.date ?? "undated"})\n` +
    `Retrieved paragraphs:\n${buildCaseContext(ctx)}`
  ).slice(0, maxChars);
}

/** Request body for a batch: one question per case, keys case_1..case_n. */
export function buildBatchRequest(model: string, query: string, cases: string[]) {
  const state: Record<string, string> = { research_question: query };
  const questions: Record<string, unknown> = {};
  cases.forEach((text, i) => {
    const key = `case_${i + 1}`;
    state[key] = text;
    questions[key] = {
      type: "choice",
      instructions: `How does the UK judgment in ${key} relate to the research_question? Judge by its facts and the legal issue it decides, not by shared keywords. Sharing only an area of law, a statute or a doctrine is tangential.`,
      criteria: CRITERIA,
    };
  });
  return { model, state, questions };
}

interface Pending {
  text: string;
  resolve: (v: GateVerdict) => void;
  reject: (e: unknown) => void;
}

interface DecisionsResponse {
  answers?: Record<string, { choice: GateVerdict["choice"]; probabilities: Record<string, number>; confidence: number }>;
  usage?: { cost?: number };
  error?: { message: string };
}

/** Per-search batcher. `screen()` resolves with that case's verdict once its batch returns. */
export class RelevanceGate {
  readonly stats: GateStats;
  private pending: Pending[] = [];
  private chars = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private model: string,
    private query: string,
    private signal?: AbortSignal,
  ) {
    this.stats = { model, requests: 0, cases: 0, rejected: 0, errors: 0, costUsd: 0 };
  }

  static forSearch(query: string, signal?: AbortSignal): RelevanceGate | null {
    const m = gateModel();
    return m ? new RelevanceGate(m, query, signal) : null;
  }

  screen(kase: CaseRow, ctx: Pick<RetrievedContext, "topLevel" | "all">): Promise<GateVerdict> {
    const text = caseState(kase, ctx, Math.floor(MAX_BATCH_CHARS / 2));
    if (this.pending.length && this.chars + text.length > MAX_BATCH_CHARS) this.flush();
    return new Promise<GateVerdict>((resolve, reject) => {
      this.pending.push({ text, resolve, reject });
      this.chars += text.length;
      if (this.pending.length >= MAX_BATCH) this.flush();
      else this.timer ??= setTimeout(() => this.flush(), WAIT_MS);
    });
  }

  /** Send whatever is waiting now (call when no more cases will arrive soon). */
  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const batch = this.pending.splice(0);
    this.chars = 0;
    if (batch.length) void this.send(batch);
  }

  private async send(batch: Pending[]) {
    this.stats.requests++;
    try {
      const res = await fetch(URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(buildBatchRequest(this.model, this.query, batch.map((b) => b.text))),
        signal: this.signal ? AbortSignal.any([this.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
      });
      const body = (await res.json().catch(() => ({}))) as DecisionsResponse;
      if (!res.ok || !body.answers) throw new Error(`decisions ${res.status}: ${(body.error?.message ?? "no answers").slice(0, 200)}`);
      this.stats.costUsd += body.usage?.cost ?? 0;
      batch.forEach((b, i) => {
        const a = body.answers![`case_${i + 1}`];
        if (!a) {
          this.stats.errors++;
          return b.reject(new Error(`decisions: no answer for case_${i + 1}`));
        }
        const p = a.probabilities ?? {};
        const verdict: GateVerdict = {
          choice: a.choice,
          probabilities: p,
          confidence: a.confidence,
          onPoint: p.on_point ?? 0,
          reject: (p.tangential ?? 0) + (p.irrelevant ?? 0) >= REJECT_AT,
        };
        this.stats.cases++;
        if (verdict.reject) this.stats.rejected++;
        b.resolve(verdict);
      });
    } catch (err) {
      this.stats.errors += batch.length;
      batch.forEach((b) => b.reject(err));
    }
  }
}
