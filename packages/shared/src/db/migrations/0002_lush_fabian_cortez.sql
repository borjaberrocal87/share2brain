ALTER TABLE "embeddings" ADD COLUMN "chunk_key" text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_embeddings_chunk_key" ON "embeddings" USING btree ("chunk_key");