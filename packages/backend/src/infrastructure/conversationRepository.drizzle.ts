// Infrastructure adapter: the ONLY file that knows the conversations/messages
// SQL. Uses the `sql` re-exported by @share2brain/shared/db so the backend never
// imports drizzle-orm directly (AD-2). Mirrors readStatusRepository.drizzle.ts.
import { sql, type Citation, type Database } from '@share2brain/shared/db';

import type {
  Conversation,
  ConversationRepository,
  ConversationSummaryRow,
  MessageRow,
} from '../domain/repositories/conversationRepository.js';

/** Serialize a pg timestamp column (a JS Date, or a string on some driver paths)
 * to the ISO 8601 string the API contract requires. Mirrors documentRepository. */
function toIsoString(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

/** Coerce the jsonb `citations` column to Citation[]. The column is NOT NULL and
 * always written as a JSON array by appendMessage; guard defensively anyway. */
function toCitations(value: unknown): Citation[] {
  return Array.isArray(value) ? (value as Citation[]) : [];
}

export function createDrizzleConversationRepository(db: Database): ConversationRepository {
  return {
    async createConversation(userId: string): Promise<Conversation> {
      const result = await db.execute(sql`
        INSERT INTO conversations (user_id)
        VALUES (${userId})
        RETURNING id, user_id AS "userId", created_at AS "createdAt", updated_at AS "updatedAt"
      `);
      const row = result.rows[0] as Record<string, unknown>;
      return {
        id: String(row.id),
        userId: String(row.userId),
        createdAt: toIsoString(row.createdAt),
        updatedAt: toIsoString(row.updatedAt),
      };
    },

    async getOwnedConversation(id: string, userId: string): Promise<Conversation | null> {
      const result = await db.execute(sql`
        SELECT id, user_id AS "userId", created_at AS "createdAt", updated_at AS "updatedAt"
        FROM conversations
        WHERE id = ${id} AND user_id = ${userId}
        LIMIT 1
      `);
      const row = result.rows[0] as Record<string, unknown> | undefined;
      return row
        ? {
            id: String(row.id),
            userId: String(row.userId),
            createdAt: toIsoString(row.createdAt),
            updatedAt: toIsoString(row.updatedAt),
          }
        : null;
    },

    async appendMessage(input: {
      conversationId: string;
      role: 'user' | 'assistant' | 'system';
      content: string;
      citations: Citation[];
    }): Promise<void> {
      await db.execute(sql`
        INSERT INTO messages (conversation_id, role, content, citations)
        VALUES (
          ${input.conversationId},
          ${input.role},
          ${input.content},
          ${JSON.stringify(input.citations)}::jsonb
        )
      `);
    },

    async touchConversation(id: string): Promise<void> {
      await db.execute(sql`
        UPDATE conversations SET updated_at = now() WHERE id = ${id}
      `);
    },

    async listConversations(
      userId: string,
      limit: number,
      offset: number,
    ): Promise<ConversationSummaryRow[]> {
      // Scope to the caller's own conversations (D2 — ownership is the access
      // control, NOT allowedChannelIds). The title is the conversation's first
      // USER message, fetched as a correlated subquery; the SERVICE derives the
      // display title from it (trim + truncate — D1/D10), so the constant isn't
      // duplicated into SQL. `updated_at DESC` = most-recently-active first (AC1).
      const result = await db.execute(sql`
        SELECT
          c.id                                    AS "id",
          COALESCE((
            SELECT m.content FROM messages m
            WHERE m.conversation_id = c.id AND m.role = 'user'
            ORDER BY m.created_at ASC, m.id ASC
            LIMIT 1
          ), '')                                  AS "firstUserMessage",
          c.created_at                            AS "createdAt",
          c.updated_at                            AS "updatedAt"
        FROM conversations c
        WHERE c.user_id = ${userId}
        ORDER BY c.updated_at DESC, c.id DESC
        LIMIT ${limit} OFFSET ${offset}
      `);

      return result.rows.map((raw): ConversationSummaryRow => {
        const row = raw as Record<string, unknown>;
        return {
          id: String(row.id),
          firstUserMessage: String(row.firstUserMessage ?? ''),
          createdAt: toIsoString(row.createdAt),
          updatedAt: toIsoString(row.updatedAt),
        };
      });
    },

    async countConversations(userId: string): Promise<number> {
      const result = await db.execute(sql`
        SELECT count(*)::int AS "total" FROM conversations WHERE user_id = ${userId}
      `);
      const row = result.rows[0] as Record<string, unknown> | undefined;
      return Number(row?.total ?? 0);
    },

    async getMessages(conversationId: string): Promise<MessageRow[]> {
      const result = await db.execute(sql`
        SELECT
          id                    AS "id",
          role                  AS "role",
          content               AS "content",
          citations             AS "citations",
          created_at            AS "createdAt"
        FROM messages
        WHERE conversation_id = ${conversationId}
        ORDER BY created_at ASC, id ASC
      `);

      return result.rows.map((raw): MessageRow => {
        const row = raw as Record<string, unknown>;
        return {
          id: String(row.id),
          role: row.role as MessageRow['role'],
          content: String(row.content),
          citations: toCitations(row.citations),
          createdAt: toIsoString(row.createdAt),
        };
      });
    },
  };
}
