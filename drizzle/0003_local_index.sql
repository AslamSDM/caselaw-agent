CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "chunks" (
	"id" serial PRIMARY KEY NOT NULL,
	"case_uri" text NOT NULL,
	"element_ids" text[] NOT NULL,
	"ord" integer NOT NULL,
	"text" text NOT NULL,
	"embedding" vector(384) NOT NULL,
	"model" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_case_uri_cases_uri_fk" FOREIGN KEY ("case_uri") REFERENCES "public"."cases"("uri") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chunks_case_idx" ON "chunks" USING btree ("case_uri");--> statement-breakpoint
CREATE INDEX "chunks_embedding_idx" ON "chunks" USING hnsw ("embedding" vector_cosine_ops);