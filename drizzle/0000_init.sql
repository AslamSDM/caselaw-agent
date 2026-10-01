CREATE TABLE "case_stubs" (
	"uri" text PRIMARY KEY NOT NULL,
	"ncn" text,
	"name" text,
	"court" text,
	"date" date
);
--> statement-breakpoint
CREATE TABLE "cases" (
	"uri" text PRIMARY KEY NOT NULL,
	"ncn" text,
	"name" text NOT NULL,
	"court" text,
	"date" date,
	"judges" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"parties" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"anonymised" boolean DEFAULT false NOT NULL,
	"availability" text,
	"content_hash" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opened_at" timestamp with time zone,
	CONSTRAINT "cases_ncn_unique" UNIQUE("ncn")
);
--> statement-breakpoint
CREATE TABLE "citations" (
	"id" serial PRIMARY KEY NOT NULL,
	"from_uri" text NOT NULL,
	"from_element_id" text,
	"type" text NOT NULL,
	"to_ncn" text,
	"to_uri" text,
	"to_legislation" text,
	"href" text,
	"raw" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "elements" (
	"case_uri" text NOT NULL,
	"element_id" text NOT NULL,
	"parent_id" text,
	"kind" text NOT NULL,
	"num" text,
	"ord" integer NOT NULL,
	"text" text NOT NULL,
	"parts" jsonb NOT NULL,
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', "text")) STORED,
	CONSTRAINT "elements_case_uri_element_id_pk" PRIMARY KEY("case_uri","element_id")
);
--> statement-breakpoint
CREATE TABLE "highlights" (
	"id" serial PRIMARY KEY NOT NULL,
	"search_id" integer NOT NULL,
	"case_uri" text NOT NULL,
	"element_id" text NOT NULL,
	"kind" text NOT NULL,
	"quote" text NOT NULL,
	"reason" text,
	"verified" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limit" (
	"bucket_start" timestamp with time zone PRIMARY KEY NOT NULL,
	"count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "results" (
	"search_id" integer NOT NULL,
	"case_uri" text NOT NULL,
	"score" real NOT NULL,
	"relevant" boolean NOT NULL,
	"summary" text,
	CONSTRAINT "results_search_id_case_uri_pk" PRIMARY KEY("search_id","case_uri")
);
--> statement-breakpoint
CREATE TABLE "searches" (
	"id" serial PRIMARY KEY NOT NULL,
	"query" text NOT NULL,
	"expanded" jsonb,
	"web_hints" jsonb,
	"candidates" jsonb,
	"stats" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tna_search_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "citations_from_uri_cases_uri_fk" FOREIGN KEY ("from_uri") REFERENCES "public"."cases"("uri") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "elements" ADD CONSTRAINT "elements_case_uri_cases_uri_fk" FOREIGN KEY ("case_uri") REFERENCES "public"."cases"("uri") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "highlights" ADD CONSTRAINT "highlights_search_id_searches_id_fk" FOREIGN KEY ("search_id") REFERENCES "public"."searches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "results" ADD CONSTRAINT "results_search_id_searches_id_fk" FOREIGN KEY ("search_id") REFERENCES "public"."searches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cases_court_idx" ON "cases" USING btree ("court");--> statement-breakpoint
CREATE INDEX "cases_date_idx" ON "cases" USING btree ("date");--> statement-breakpoint
CREATE INDEX "citations_from_idx" ON "citations" USING btree ("from_uri");--> statement-breakpoint
CREATE INDEX "citations_to_uri_idx" ON "citations" USING btree ("to_uri");--> statement-breakpoint
CREATE INDEX "elements_case_ord_idx" ON "elements" USING btree ("case_uri","ord");--> statement-breakpoint
CREATE INDEX "elements_tsv_idx" ON "elements" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "highlights_search_case_idx" ON "highlights" USING btree ("search_id","case_uri");