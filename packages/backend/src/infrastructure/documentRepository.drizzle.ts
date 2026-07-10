// Infrastructure adapter: the ONLY file that knows the documents-list SQL. Uses
// the `sql`/`inArray` re-exported by @hivly/shared/db so the backend never
// imports drizzle-orm directly (AD-2). Mirrors embeddingSearchRepository.drizzle.ts
// (D1 anti-join, D2 anchor join) plus a LEFT JOIN against user_read_status for
// the per-user `isRead` annotation (D3).
import { inArray, sql, type Database } from '@hivly/shared/db';

import type { DocumentFragmentRow, DocumentRepository } from '../domain/repositories/documentRepository.js';

function toIsoString(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

export function createDrizzleDocumentRepository(db: Database): DocumentRepository {
  return {
    async listDocuments(
      userId: string,
      allowedChannelIds: string[],
      limit: number,
      offset: number,
      unreadOnly: boolean,
    ): Promise<DocumentFragmentRow[]> {
      // AC7 / deny-by-default: never build `= ANY('{}')`. Short-circuit BEFORE any
      // DB round-trip — an empty array in inArray/ANY is unsafe (db/index.ts).
      if (allowedChannelIds.length === 0) return [];

      const result = await db.execute(sql`
        SELECT
          e.id                                    AS "id",
          e.title                                 AS "title",
          e.description                           AS "description",
          e.link                                  AS "link",
          e.channel_id                            AS "channelId",
          cp.name                                 AS "channelName",
          dm.author_id                            AS "authorId",
          -- 9.5-D1/D6: anchor-row display name, degrading tier 2 (OAuth username) then
          -- tier 3 (snowflake) — same COALESCE tier chain as the stats topUsers aggregate,
          -- but resolved at the anchor row here (topUsers picks the latest name across all
          -- of the author's scoped messages via array_agg). NULLIF hardens against the
          -- create path's missing runtime '' guard (9.4).
          COALESCE(NULLIF(dm.author_name, ''), u.username, dm.author_id) AS "authorName",
          dm.created_at                           AS "createdAt",
          e.created_at                            AS "indexedAt",     -- D3: the "indexado" column
          dm.id                                   AS "messageId",     -- D2: the anchor message (message_ids[1], see join below)
          (urs.embedding_id IS NOT NULL)          AS "isRead"
        FROM embeddings e
        JOIN channel_permissions cp ON cp.channel_id = e.channel_id
        -- Anchor join (D2): message_ids[1] is the anchor (Postgres arrays are 1-indexed).
        -- INTENTIONAL INNER JOIN — see embeddingSearchRepository.drizzle.ts for the
        -- anchor-absent rationale (drop rather than surface placeholder fields).
        JOIN discord_messages dm ON dm.id = e.message_ids[1]
        LEFT JOIN users u ON u.discord_id = dm.author_id
        LEFT JOIN user_read_status urs ON urs.embedding_id = e.id AND urs.user_id = ${userId}
        -- AD-12: RBAC inside the query.
        WHERE ${inArray(sql`e.channel_id`, allowedChannelIds)}
          AND NOT EXISTS (                                          -- D1: exclude-if-ANY deleted
            SELECT 1 FROM discord_messages d
            WHERE d.id = ANY(e.message_ids) AND d.deleted_at IS NOT NULL
          )
          ${unreadOnly ? sql`AND urs.embedding_id IS NULL` : sql``}
        ORDER BY e.created_at DESC, e.id DESC                       -- D4: newest indexed first, stable tiebreak
        LIMIT ${limit} OFFSET ${offset}
      `);

      return result.rows.map((raw): DocumentFragmentRow => {
        const row = raw as Record<string, unknown>;
        return {
          id: String(row.id),
          title: String(row.title),
          description: String(row.description),
          link: String(row.link),
          channelId: String(row.channelId),
          channelName: String(row.channelName),
          authorId: String(row.authorId),
          authorName: String(row.authorName),
          createdAt: toIsoString(row.createdAt),
          indexedAt: toIsoString(row.indexedAt),
          messageId: String(row.messageId),
          isRead: Boolean(row.isRead),
        };
      });
    },

    async countDocuments(
      userId: string,
      allowedChannelIds: string[],
      unreadOnly: boolean,
    ): Promise<number> {
      if (allowedChannelIds.length === 0) return 0;

      const result = await db.execute(sql`
        SELECT count(*)::int AS "total"
        FROM embeddings e
        LEFT JOIN user_read_status urs ON urs.embedding_id = e.id AND urs.user_id = ${userId}
        WHERE ${inArray(sql`e.channel_id`, allowedChannelIds)}
          AND NOT EXISTS (
            SELECT 1 FROM discord_messages d
            WHERE d.id = ANY(e.message_ids) AND d.deleted_at IS NOT NULL
          )
          ${unreadOnly ? sql`AND urs.embedding_id IS NULL` : sql``}
      `);

      const row = result.rows[0] as Record<string, unknown> | undefined;
      return Number(row?.total ?? 0);
    },
  };
}
