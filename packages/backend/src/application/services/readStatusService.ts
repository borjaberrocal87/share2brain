// Application service: read-status orchestration (mark/unmark/mark-all/unread
// count). Depends ONLY on the domain port (ReadStatusRepository) — no Drizzle,
// no Express — so it is unit-testable with plain fakes. Mirrors
// documentService.ts. Every method enforces AD-12 by requiring the caller's
// RBAC scope and returns a typed result; HTTP status mapping lives in the
// controller (D5, D6).
import {
  MarkAllResponseSchema,
  UnreadCountResponseSchema,
  type MarkAllResponse,
  type UnreadCountResponse,
} from '@share2brain/shared/schemas';

import type { ReadStatusRepository } from '../../domain/repositories/readStatusRepository.js';

export type MarkReadResult = { ok: true } | { ok: false; reason: 'not-found' };
export type MarkAllResult = { ok: true; response: MarkAllResponse } | { ok: false; reason: 'forbidden' };

export interface ReadStatusService {
  /**
   * Mark `embeddingId` as read for `userId`. `not-found` when the fragment
   * doesn't exist, is outside `allowedChannelIds`, or is D1-excluded — an
   * undifferentiated signal so the controller's 404 never leaks scope (D5).
   */
  markRead(userId: string, embeddingId: string, allowedChannelIds: string[]): Promise<MarkReadResult>;

  /** Unmark `embeddingId` as read for `userId` — always succeeds (idempotent, AC4). */
  unmarkRead(userId: string, embeddingId: string): Promise<void>;

  /**
   * Mark every visible fragment as read for `userId` (D6): `channelId` present
   * ⇒ that channel (must be in `allowedChannelIds`, else `forbidden`); absent ⇒
   * every `allowedChannelIds`.
   */
  markAll(userId: string, channelId: string | undefined, allowedChannelIds: string[]): Promise<MarkAllResult>;

  /** Per-channel unread count for `userId`, restricted to `allowedChannelIds` (D7). */
  unreadCount(userId: string, allowedChannelIds: string[]): Promise<UnreadCountResponse>;
}

export function createReadStatusService(deps: {
  readStatusRepo: ReadStatusRepository;
}): ReadStatusService {
  const { readStatusRepo } = deps;

  return {
    async markRead(userId, embeddingId, allowedChannelIds): Promise<MarkReadResult> {
      const channelId = await readStatusRepo.findVisibleEmbeddingChannel(embeddingId, allowedChannelIds);
      if (channelId === null) return { ok: false, reason: 'not-found' };

      await readStatusRepo.markRead(userId, embeddingId);
      return { ok: true };
    },

    async unmarkRead(userId, embeddingId): Promise<void> {
      await readStatusRepo.unmarkRead(userId, embeddingId);
    },

    async markAll(userId, channelId, allowedChannelIds): Promise<MarkAllResult> {
      if (channelId !== undefined && !allowedChannelIds.includes(channelId)) {
        return { ok: false, reason: 'forbidden' };
      }

      const targetChannelIds = channelId !== undefined ? [channelId] : allowedChannelIds;
      const markedCount = await readStatusRepo.markAllInChannels(userId, targetChannelIds);

      return { ok: true, response: MarkAllResponseSchema.parse({ markedCount }) };
    },

    async unreadCount(userId, allowedChannelIds): Promise<UnreadCountResponse> {
      const counts = await readStatusRepo.unreadCountByChannel(userId, allowedChannelIds);
      return UnreadCountResponseSchema.parse(counts);
    },
  };
}
