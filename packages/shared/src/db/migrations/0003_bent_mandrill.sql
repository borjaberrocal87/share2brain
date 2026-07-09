ALTER TABLE "embeddings" ADD COLUMN "title" text NOT NULL;--> statement-breakpoint
ALTER TABLE "embeddings" ADD COLUMN "description" text NOT NULL;--> statement-breakpoint
ALTER TABLE "embeddings" ADD COLUMN "link" text NOT NULL;--> statement-breakpoint
ALTER TABLE "embeddings" DROP COLUMN "content";