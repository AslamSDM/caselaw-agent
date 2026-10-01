ALTER TABLE "cases" ADD COLUMN "embed_model" text;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "embed_complete" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "elements" ADD COLUMN "embedding" vector(768);--> statement-breakpoint
CREATE INDEX "elements_embedding_idx" ON "elements" USING hnsw ("embedding" vector_cosine_ops);