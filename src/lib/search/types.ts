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
  | { type: "rejected"; uri: string; name: string; score: number; reason: string; areas?: string[] }
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
}
