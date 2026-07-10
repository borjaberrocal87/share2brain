// Application service: conversation list + detail orchestration. Turns a page
// request / a conversationId into a validated response, deriving the display title
// from each conversation's first user message (D1/D10). Depends ONLY on the domain
// port (ConversationRepository) — no Drizzle, no Express — so it is unit-testable
// with plain fakes. Mirrors documentService.ts.
import {
  CONVERSATION_TITLE_MAX_LENGTH,
  ConversationDetailSchema,
  ConversationsResponseSchema,
  type ConversationDetail,
  type ConversationsResponse,
} from '@share2brain/shared/schemas';

import type { ConversationRepository } from '../../domain/repositories/conversationRepository.js';

/** Fallback title (Spanish, user-facing like the controllers' messages) when a
 * conversation has no user message yet — never crash, never show a blank title. */
const TITLE_FALLBACK = 'Nueva conversación';

/**
 * Derive a display title from a conversation's first user message (D10): trim,
 * collapse internal whitespace, truncate to CONVERSATION_TITLE_MAX_LENGTH. An
 * empty/whitespace-only message yields the stable fallback (AC5 — never a crash).
 */
export function deriveTitle(firstUserMessage: string): string {
  const normalized = firstUserMessage.replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) return TITLE_FALLBACK;
  // Array.from splits by Unicode code point, not UTF-16 code unit — String.slice
  // would risk cutting a surrogate pair (e.g. an emoji) in half at the boundary.
  return Array.from(normalized).slice(0, CONVERSATION_TITLE_MAX_LENGTH).join('');
}

export interface ConversationService {
  /** A page of the caller's own conversations, most-recently-active first (AC1). */
  listConversations(userId: string, page: number, limit: number): Promise<ConversationsResponse>;

  /**
   * The conversation detail with its messages (chronological), or `null` when the
   * conversation is unknown or not owned by `userId` (the controller maps `null`
   * to a 404 — no existence leak, AC2/D2).
   */
  getConversation(userId: string, conversationId: string): Promise<ConversationDetail | null>;
}

export function createConversationService(deps: {
  conversationRepo: ConversationRepository;
}): ConversationService {
  const { conversationRepo } = deps;

  return {
    async listConversations(userId, page, limit): Promise<ConversationsResponse> {
      const offset = (page - 1) * limit;
      const [rows, total] = await Promise.all([
        conversationRepo.listConversations(userId, limit, offset),
        conversationRepo.countConversations(userId),
      ]);

      const results = rows.map((r) => ({
        id: r.id,
        title: deriveTitle(r.firstUserMessage),
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }));

      // Validate against the shared contract before it leaves the service (AD-6).
      return ConversationsResponseSchema.parse({ results, page, limit, total });
    },

    async getConversation(userId, conversationId): Promise<ConversationDetail | null> {
      // Ownership FIRST (D2): a non-owned/unknown id yields null → 404, so a user
      // can never learn another user's conversation exists.
      const conversation = await conversationRepo.getOwnedConversation(conversationId, userId);
      if (!conversation) return null;

      const messages = await conversationRepo.getMessages(conversationId);
      const payload = {
        id: conversation.id,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        messages: messages.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          citations: m.citations,
          createdAt: m.createdAt,
        })),
      };

      return ConversationDetailSchema.parse(payload);
    },
  };
}
