// Infrastructure adapter: the ONLY file that knows the read-status SQL. Uses the
// `sql`/`inArray` re-exported by @share2brain/shared/db so the backend never imports
// drizzle-orm directly (AD-2). Mirrors documentRepository.drizzle.ts (D1
// anti-join, RBAC-inside-query).
import { inArray, sql, type Database } from '@share2brain/shared/db';

import type { ReadStatusRepository } from '../domain/repositories/readStatusRepository.js';

/** Keyset batch size for mark-all (AC5 — "lotes de 1 000"). */
const MARK_ALL_BATCH_SIZE = 1000;

/** Smallest possible uuid — the keyset cursor's starting point. */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

export function createDrizzleReadStatusRepository(db: Database): ReadStatusRepository {
  return {
    async findVisibleEmbeddingChannel(
      embeddingId: string,
      allowedChannelIds: string[],
    ): Promise<string | null> {
      if (allowedChannelIds.length === 0) return null;

      const result = await db.execute(sql`
        SELECT e.channel_id AS "channelId"
        FROM embeddings e
        WHERE e.id = ${embeddingId}
          AND ${inArray(sql`e.channel_id`, allowedChannelIds)}
          AND NOT EXISTS (
            SELECT 1 FROM discord_messages d
            WHERE d.id = ANY(e.message_ids) AND d.deleted_at IS NOT NULL
          )
        LIMIT 1
      `);

      const row = result.rows[0] as Record<string, unknown> | undefined;
      return row ? String(row.channelId) : null;
    },

    async markRead(userId: string, embeddingId: string): Promise<void> {
      await db.execute(sql`
        INSERT INTO user_read_status (user_id, embedding_id)
        VALUES (${userId}, ${embeddingId})
        ON CONFLICT DO NOTHING
      `);
    },

    async unmarkRead(userId: string, embeddingId: string): Promise<void> {
      await db.execute(sql`
        DELETE FROM user_read_status
        WHERE user_id = ${userId} AND embedding_id = ${embeddingId}
      `);
    },

    async markAllInChannels(userId: string, channelIds: string[]): Promise<number> {
      if (channelIds.length === 0) return 0;

      let markedCount = 0;
      let lastId = NIL_UUID;

      for (;;) {
        // Single round-trip: `batch` selects the candidate id set (the keyset
        // cursor advances from THIS, not from `RETURNING`, which omits ON
        // CONFLICT skips — so already-read rows never stall the cursor); `ins`
        // inserts and reports only the newly-inserted count.
        const result = await db.execute(sql`
          WITH batch AS (
            SELECT e.id
            FROM embeddings e
            WHERE ${inArray(sql`e.channel_id`, channelIds)}
              AND e.id > ${lastId}
              AND NOT EXISTS (
                SELECT 1 FROM discord_messages d
                WHERE d.id = ANY(e.message_ids) AND d.deleted_at IS NOT NULL
              )
            ORDER BY e.id
            LIMIT ${MARK_ALL_BATCH_SIZE}
          ),
          ins AS (
            INSERT INTO user_read_status (user_id, embedding_id)
            SELECT ${userId}, id FROM batch
            ON CONFLICT DO NOTHING
            RETURNING embedding_id
          )
          SELECT
            (SELECT count(*) FROM batch)::int                        AS "selectedCount",
            (SELECT count(*) FROM ins)::int                          AS "insertedCount",
            (SELECT id FROM batch ORDER BY id DESC LIMIT 1)          AS "maxId"
        `);

        const row = result.rows[0] as Record<string, unknown>;
        const selectedCount = Number(row.selectedCount);
        markedCount += Number(row.insertedCount);

        if (selectedCount === 0) break;
        lastId = String(row.maxId);
        if (selectedCount < MARK_ALL_BATCH_SIZE) break;
      }

      return markedCount;
    },

    async unreadCountByChannel(
      userId: string,
      allowedChannelIds: string[],
    ): Promise<Record<string, number>> {
      if (allowedChannelIds.length === 0) return {};

      const result = await db.execute(sql`
        SELECT e.channel_id AS "channelId", count(*)::int AS "count"
        FROM embeddings e
        WHERE ${inArray(sql`e.channel_id`, allowedChannelIds)}
          AND NOT EXISTS (
            SELECT 1 FROM discord_messages d
            WHERE d.id = ANY(e.message_ids) AND d.deleted_at IS NOT NULL
          )
          AND NOT EXISTS (
            SELECT 1 FROM user_read_status urs
            WHERE urs.embedding_id = e.id AND urs.user_id = ${userId}
          )
        GROUP BY e.channel_id
      `);

      const counts: Record<string, number> = {};
      for (const raw of result.rows) {
        const row = raw as Record<string, unknown>;
        counts[String(row.channelId)] = Number(row.count);
      }
      return counts;
    },
  };
}
