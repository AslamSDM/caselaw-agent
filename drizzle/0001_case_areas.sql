ALTER TABLE "cases" ADD COLUMN "areas" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "areas_classified" boolean DEFAULT false NOT NULL;