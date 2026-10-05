CREATE TABLE "chats" (
	"id" text PRIMARY KEY NOT NULL,
	"search_id" integer,
	"case_uri" text,
	"title" text NOT NULL,
	"messages" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_search_id_searches_id_fk" FOREIGN KEY ("search_id") REFERENCES "public"."searches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chats_search_idx" ON "chats" USING btree ("search_id");--> statement-breakpoint
CREATE INDEX "chats_case_idx" ON "chats" USING btree ("case_uri");--> statement-breakpoint
CREATE INDEX "chats_updated_idx" ON "chats" USING btree ("updated_at");