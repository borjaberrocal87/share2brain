// Domain port: conversation + message persistence. Pure — no Drizzle. The
// Drizzle implementation lives in infrastructure/ so the application layer
// depends only on this contract (AD-2 spirit). Mirrors embeddingSearchRepository.ts.
import type { Citation } from '@share2brain/shared/db';

export interface Conversation {
  id: string;
  userId: string;
  /** ISO 8601. Present on the owned-conversation lookup so the detail endpoint can
   * return the conversation's own timestamps without a second round-trip (5.2). */
  createdAt: string;
  updatedAt: string;
}

/** One row of the conversation LIST (Story 5.2, AC1). `firstUserMessage` is the raw
 * content of the conversation's first user message (or `''` when the conversation has
 * none); the SERVICE derives the display `title` from it (D1/D10 — the truncation
 * constant lives in one place, not in SQL). */
export interface ConversationSummaryRow {
  id: string;
  firstUserMessage: string;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

/** One persisted message row (Story 5.2). Serves BOTH the detail endpoint (AC2) and
 * history loading (AC4 — chatService maps these rows → ChatTurn[]). */
export interface MessageRow {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  citations: Citation[];
  createdAt: string; // ISO 8601
}

export interface ConversationRepository {
  /** Create a new conversation owned by `userId`. */
  createConversation(userId: string): Promise<Conversation>;

  /** The conversation if it exists AND is owned by `userId`, else `null`. */
  getOwnedConversation(id: string, userId: string): Promise<Conversation | null>;

  /** Append a message (user or assistant turn) to a conversation. */
  appendMessage(input: {
    conversationId: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    citations: Citation[];
  }): Promise<void>;

  /** Bump `conversations.updated_at` to now. */
  touchConversation(id: string): Promise<void>;

  /** A page of the caller's own conversations, ordered `updated_at DESC` (AC1). */
  listConversations(
    userId: string,
    limit: number,
    offset: number,
  ): Promise<ConversationSummaryRow[]>;

  /** Total count of the caller's own conversations (for the pagination envelope). */
  countConversations(userId: string): Promise<number>;

  /** All message rows of a conversation, ordered `created_at ASC` (chronological).
   * Used by the detail endpoint (AC2) and history loading (AC4). */
  getMessages(conversationId: string): Promise<MessageRow[]>;
}
