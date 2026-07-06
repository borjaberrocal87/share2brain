// Infrastructure adapter: the ONLY file that knows the pgvector search SQL. Uses
// the `sql` template re-exported by @hivly/shared/db so the backend never imports
// drizzle-orm directly (AD-2). This is the first pgvector similarity query in the
// repo and the concrete home of AD-12: the RBAC filter is a clause of the vector
// query itself, never a JS post-filter.
import { inArray, sql, type Database } from '@hivly/shared/db';

import type {
  EmbeddingSearchRepository,
  SearchFragmentRow,
} from '../domain/repositories/embeddingSearchRepository.js';

export function createDrizzleEmbeddingSearchRepository(
  db: Database,
): EmbeddingSearchRepository {
  return {
    async searchByEmbedding(
      queryVector: number[],
      allowedChannelIds: string[],
      limit: number,
    ): Promise<SearchFragmentRow[]> {
      // AC3 / deny-by-default: never build `= ANY('{}')`. An empty scope can only
      // return nothing, and an empty array in the ANY clause is unsafe. Short-circuit
      // BEFORE any DB round-trip (the service also short-circuits before embedding).
      if (allowedChannelIds.length === 0) return [];

      // GOTCHA: bind the query vector as a pgvector TEXT literal and cast it. A JS
      // number[] bound raw is serialized by node-postgres as a Postgres array
      // literal (`{1,2,3}`), which pgvector's `<=>` rejects. `JSON.stringify` of a
      // number[] yields `[0.1,0.2,...]` — exactly pgvector's text format — and the
      // `::vector` cast makes Postgres parse it.
      const vecLiteral = JSON.stringify(queryVector);

      const result = await db.execute(sql`
        SELECT
          e.id                                    AS "id",
          e.content                               AS "content",
          e.channel_id                            AS "channelId",
          cp.name                                 AS "channelName",
          dm.author_id                            AS "authorId",
          dm.author_id                            AS "authorName",   -- D2: no display name persisted yet
          dm.created_at                           AS "createdAt",
          dm.id                                   AS "messageId",     -- D2: anchor = message_ids[0]
          GREATEST(0, LEAST(1, 1 - (e.embedding <=> ${vecLiteral}::vector)))::float8 AS "similarity"
        FROM embeddings e
        JOIN channel_permissions cp ON cp.channel_id = e.channel_id
        -- Anchor join (D2): message_ids[1] is the anchor (Postgres arrays are 1-indexed).
        -- INTENTIONAL INNER JOIN: if the anchor row is absent (empty message_ids, or a
        -- hard-deleted/purged anchor message) the chunk is DROPPED rather than surfaced
        -- with placeholder anchor fields. Not reachable today (the Indexer always groups
        -- >=1 message; hard-delete is Epic 6, soft-delete is handled by the NOT EXISTS
        -- below). Revisit as a LEFT JOIN + degrade when hard-delete lands (Review 2026-07-06).
        JOIN discord_messages dm ON dm.id = e.message_ids[1]
        -- AD-12: RBAC inside the query. inArray renders e.channel_id in ($1,$2,...);
        -- a raw array interpolation would be expanded by drizzle into comma-separated
        -- params and break an ANY(...) cast, so use the re-exported helper (AD-2).
        WHERE ${inArray(sql`e.channel_id`, allowedChannelIds)}
          AND NOT EXISTS (                                          -- D1: exclude-if-ANY deleted
            SELECT 1 FROM discord_messages d
            WHERE d.id = ANY(e.message_ids) AND d.deleted_at IS NOT NULL
          )
        ORDER BY (e.embedding <=> ${vecLiteral}::vector) ASC        -- ascending distance = descending similarity
        LIMIT ${limit}
      `);

      return result.rows.map((raw): SearchFragmentRow => {
        const row = raw as Record<string, unknown>;
        const createdAt =
          row.createdAt instanceof Date
            ? row.createdAt
            : new Date(String(row.createdAt));
        return {
          id: String(row.id),
          content: String(row.content),
          channelId: String(row.channelId),
          channelName: String(row.channelName),
          authorId: String(row.authorId),
          authorName: String(row.authorName),
          createdAt: createdAt.toISOString(),
          similarity: Number(row.similarity),
          messageId: String(row.messageId),
        };
      });
    },
  };
}
