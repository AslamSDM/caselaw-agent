import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  serial,
  text,
  timestamp,
  vector,
} from "drizzle-orm/pg-core";

const tsvector = customType<{ data: string }>({
  dataType: () => "tsvector",
});

/** Must match the embedding model's output size (nomic-embed-text = 768). */
export const EMBED_DIM = 768;

/** Rendering structure for an element: literal text runs and child element slots, in document order. */
export type ElementPart = { t: string } | { c: string };

export const cases = pgTable(
  "cases",
  {
    uri: text("uri").primaryKey(), // ewhc/ch/2016/52
    ncn: text("ncn").unique(), // [2016] EWHC 52 (Ch)
    name: text("name").notNull(),
    court: text("court"),
    date: date("date"),
    judges: jsonb("judges").$type<string[]>().notNull().default([]),
    parties: jsonb("parties").$type<string[]>().notNull().default([]),
    anonymised: boolean("anonymised").notNull().default(false),
    /** area-of-law ids (src/lib/areas.ts) */
    areas: jsonb("areas").$type<string[]>().notNull().default([]),
    /** true once the LLM classified areas from the text (otherwise court-derived guess) */
    areasClassified: boolean("areas_classified").notNull().default(false),
    availability: text("availability"),
    contentHash: text("content_hash"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    /** model that produced this case's paragraph embeddings; a different model → re-embed */
    embedModel: text("embed_model"),
    /** every top-level paragraph is embedded (enables full semantic ranking + cache-wide search) */
    embedComplete: boolean("embed_complete").notNull().default(false),
  },
  (t) => [index("cases_court_idx").on(t.court), index("cases_date_idx").on(t.date)],
);

export const elements = pgTable(
  "elements",
  {
    caseUri: text("case_uri")
      .notNull()
      .references(() => cases.uri, { onDelete: "cascade" }),
    elementId: text("element_id").notNull(), // para_12 | para_12__sub_2 | para_12__quote_1 | p_40
    parentId: text("parent_id"),
    kind: text("kind").notNull(), // heading | paragraph | subparagraph | quote_block
    num: text("num"),
    ord: integer("ord").notNull(),
    text: text("text").notNull(),
    parts: jsonb("parts").$type<ElementPart[]>().notNull(),
    tsv: tsvector("tsv").generatedAlwaysAs(sql`to_tsvector('english', "text")`),
    /** top-level paragraphs only; see src/lib/embed.ts */
    embedding: vector("embedding", { dimensions: EMBED_DIM }),
  },
  (t) => [
    primaryKey({ columns: [t.caseUri, t.elementId] }),
    index("elements_case_ord_idx").on(t.caseUri, t.ord),
    index("elements_tsv_idx").using("gin", t.tsv),
    index("elements_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
);

/** Embedding dimensions of EMBED_MODEL (bge-small-en-v1.5 → 384). Changing it needs a migration. */
export const EMBED_DIMS = 384;

/**
 * Retrieval chunks for the local index: runs of consecutive top-level paragraphs (short ones are
 * merged) with a local embedding. Rebuilt by scripts/embed.ts; cleared whenever a case is re-saved.
 */
export const chunks = pgTable(
  "chunks",
  {
    id: serial("id").primaryKey(),
    caseUri: text("case_uri")
      .notNull()
      .references(() => cases.uri, { onDelete: "cascade" }),
    /** top-level element ids covered, in document order */
    elementIds: text("element_ids").array().notNull(),
    ord: integer("ord").notNull(),
    text: text("text").notNull(),
    embedding: vector("embedding", { dimensions: EMBED_DIMS }).notNull(),
    model: text("model").notNull(),
  },
  (t) => [
    index("chunks_case_idx").on(t.caseUri),
    index("chunks_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
);

export const citations = pgTable(
  "citations",
  {
    id: serial("id").primaryKey(),
    fromUri: text("from_uri")
      .notNull()
      .references(() => cases.uri, { onDelete: "cascade" }),
    fromElementId: text("from_element_id"),
    type: text("type").notNull(), // case | legislation
    toNcn: text("to_ncn"),
    toUri: text("to_uri"),
    toLegislation: text("to_legislation"),
    href: text("href"),
    raw: text("raw").notNull(),
  },
  (t) => [index("citations_from_idx").on(t.fromUri), index("citations_to_uri_idx").on(t.toUri)],
);

export const caseStubs = pgTable("case_stubs", {
  uri: text("uri").primaryKey(),
  ncn: text("ncn"),
  name: text("name"),
  court: text("court"),
  date: date("date"),
});

export const searches = pgTable("searches", {
  id: serial("id").primaryKey(),
  query: text("query").notNull(),
  filters: jsonb("filters"),
  expanded: jsonb("expanded"),
  webHints: jsonb("web_hints"),
  candidates: jsonb("candidates"),
  stats: jsonb("stats"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const results = pgTable(
  "results",
  {
    searchId: integer("search_id")
      .notNull()
      .references(() => searches.id, { onDelete: "cascade" }),
    caseUri: text("case_uri").notNull(),
    score: real("score").notNull(),
    relevant: boolean("relevant").notNull(),
    summary: text("summary"),
  },
  (t) => [primaryKey({ columns: [t.searchId, t.caseUri] })],
);

export const highlights = pgTable(
  "highlights",
  {
    id: serial("id").primaryKey(),
    searchId: integer("search_id")
      .notNull()
      .references(() => searches.id, { onDelete: "cascade" }),
    caseUri: text("case_uri").notNull(),
    elementId: text("element_id").notNull(),
    kind: text("kind").notNull(), // paragraph | quoted_clause | legislation_ref
    quote: text("quote").notNull(), // exact source text that was matched
    reason: text("reason"),
    verified: boolean("verified").notNull(),
  },
  (t) => [index("highlights_search_case_idx").on(t.searchId, t.caseUri)],
);

/** Follow-up chat conversations (UI messages incl. tool calls), scoped to a search and/or a judgment. */
export const chats = pgTable(
  "chats",
  {
    id: text("id").primaryKey(),
    searchId: integer("search_id").references(() => searches.id, { onDelete: "set null" }),
    caseUri: text("case_uri"),
    title: text("title").notNull(),
    messages: jsonb("messages").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("chats_search_idx").on(t.searchId), index("chats_case_idx").on(t.caseUri), index("chats_updated_idx").on(t.updatedAt)],
);

/** Shared TNA request counter, 10-second buckets. */
export const rateLimit = pgTable("rate_limit", {
  bucketStart: timestamp("bucket_start", { withTimezone: true }).primaryKey(),
  count: integer("count").notNull().default(0),
});

/** 24h cache of TNA atom search responses. */
export const tnaSearchCache = pgTable("tna_search_cache", {
  key: text("key").primaryKey(),
  response: jsonb("response").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
