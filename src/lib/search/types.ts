import type { DateRange } from "../dates";

export interface SearchFilters {
  court?: string[];
  party?: string;
  judge?: string;
}

/** Where the active date range came from. */
export type DateSource = "query" | "user" | "none";

export interface ExpandedQuery {
  original: string;
  variants: string[];
  /** words/phrases used to rank paragraphs inside a judgment */
  ftsTerms: string[];
  filters: SearchFilters;
  /** date range inferred from the query text (null if none) */
  dates: DateRange | null;
  datesReason: string | null;
}

export type CandidateSourceKind = "keyword" | "web-keyword" | "party" | "ncn" | "local-vector" | "local-fts";

export interface CandidateList {
  source: CandidateSourceKind;
  label: string;
  estimatedTotal: number;
  /** extra multiplier on the source weight (e.g. local semantic list scaled by index coverage) */
  weight?: number;
  entries: { uri: string; name: string; ncn: string | null; court: string | null; date: string | null }[];
}

export interface Candidate {
  uri: string;
  name: string;
  ncn: string | null;
  court: string | null;
  date: string | null;
  score: number;
  matchedBy: string[];
}

export type HighlightKind = "paragraph" | "quoted_clause" | "legislation_ref";

export interface VerifiedHighlight {
  elementId: string;
  kind: HighlightKind;
  quote: string;
  reason: string;
  similarity: number;
}

export interface CaseResult {
  uri: string;
  name: string;
  ncn: string | null;
  court: string | null;
  date: string | null;
  anonymised: boolean;
  areas: string[];
  score: number;
  summary: string;
  highlights: VerifiedHighlight[];
  /** best cross-encoder paragraph score (0–1), when the reranker ran */
  rerank?: number;
  /** why this case was read, when not from search lists (e.g. "cited by 3 results") */
  via?: string;
}

export interface SearchOptions {
  /** restrict results to these area-of-law ids (src/lib/areas.ts); empty = all */
  areas?: string[];
  /** where the search came from; eval runs are hidden from the UI history */
  source?: "ui" | "eval";
  /**
   * undefined = infer from the query; a range = use it (overrides inference);
   * null = user cleared the range, ignore dates in the query.
   */
  dates?: DateRange | null;
}

export interface WebMention {
  name: string;
  ncn: string | null;
  sourceUrl: string;
}

export type SearchEvent =
  | { type: "status"; stage: string; message: string }
  | { type: "search"; searchId: number }
  | { type: "expanded"; variants: string[]; filters: SearchFilters; ftsTerms: string[]; dates: DateRange | null; dateSource: DateSource; datesReason: string | null }
  | { type: "web"; terms: string[]; variants: string[]; ncns: string[]; sources: number }
  | { type: "candidates"; candidates: Candidate[] }
  | { type: "result"; result: CaseResult }
  | { type: "rejected"; uri: string; name: string; score: number; reason: string; areas?: string[]; rerank?: number }
  | { type: "web_mentions"; mentions: WebMention[] }
  | { type: "done"; searchId: number; stats: SearchStats }
  | { type: "error"; message: string };

export interface SearchStats {
  ms: number;
  firstResultMs: number | null;
  tnaRequests: number;
  casesFetched: number;
  casesFromCache: number;
  inputTokens: number;
  outputTokens: number;
  webEnrichment: "used" | "skipped" | "timeout" | "error" | "disabled";
  /** characters of judgment text sent to the relevance pass (≈ tokens × 4) */
  contextChars: number;
  /** paragraphs embedded on demand during this search */
  paragraphsEmbedded: number;
  /** wall-clock ms per stage; per-case stages are summed across parallel workers */
  timings: StageTimings;
  /** decisions-model pre-screen (JUDGE_GATE_MODEL); null when off */
  gate: { model: string; requests: number; cases: number; rejected: number; errors: number; costUsd: number } | null;
  /** cases rejected because no paragraph cleared RERANK_MIN */
  rerankRejected: number;
  /** cases added because several passing results cite them */
  citationCandidates: number;
  /** cases whose decision came from the decision cache (no retrieval or LLM calls) */
  decisionsCached: number;
}

export interface StageTimings {
  /** query expansion (0 on a cache hit) */
  expand: number;
  /** expansion done → wave-1 candidates ready (TNA keyword + local index) */
  search: number;
  /** wave-1 ready → web hints merged (0 when web is off or already done) */
  web: number;
  /** summed across cases */
  fetch: number;
  retrieve: number;
  /** decisions-model pre-screen, summed */
  gate: number;
  judge: number;
}
