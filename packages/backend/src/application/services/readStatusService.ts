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
  markRead(
    userId: string,
    embeddingId: string,
    allowedChannelIds: string[],
    isGuest?: boolean,
  ): Promise<MarkReadResult>;

  /** Unmark `embeddingId` as read for `userId` — always succeeds (idempotent, AC4). */
  unmarkRead(userId: string, embeddingId: string, isGuest?: boolean): Promise<void>;

  /**
   * Mark every visible fragment as read for `userId` (D6): `channelId` present
   * ⇒ that channel (must be in `allowedChannelIds`, else `forbidden`); absent ⇒
   * every `allowedChannelIds`.
   */
  markAll(
    userId: string,
    channelId: string | undefined,
    allowedChannelIds: string[],
    isGuest?: boolean,
  ): Promise<MarkAllResult>;

  /** Per-channel unread count for `userId`, restricted to `allowedChannelIds` (D7). */
  unreadCount(userId: string, allowedChannelIds: string[]): Promise<UnreadCountResponse>;
}

export function createReadStatusService(deps: {
  readStatusRepo: ReadStatusRepository;
}): ReadStatusService {
  const { readStatusRepo } = deps;

  // Story 2.5 (review): all guests share one sentinel userId, so PERSISTING read
  // status under it would bleed one guest's reads into another's and deflate the
  // shared unread badge. Guest read-status is ephemeral: the write methods below
  // no-op (keeping the visibility/forbidden contract), so the sentinel accumulates
  // NO read rows — which makes `unreadCount` return all-unread for every guest with
  // no special branch (the `NOT EXISTS urs.user_id = sentinel` never matches).

  return {
    async markRead(userId, embeddingId, allowedChannelIds, isGuest = false): Promise<MarkReadResult> {
      const channelId = await readStatusRepo.findVisibleEmbeddingChannel(embeddingId, allowedChannelIds);
      if (channelId === null) return { ok: false, reason: 'not-found' };

      // Ephemeral for guests: report success but never persist (isolation).
      if (isGuest) return { ok: true };

      await readStatusRepo.markRead(userId, embeddingId);
      return { ok: true };
    },

    async unmarkRead(userId, embeddingId, isGuest = false): Promise<void> {
      if (isGuest) return; // no persisted guest read rows to unmark (ephemeral)
      await readStatusRepo.unmarkRead(userId, embeddingId);
    },

    async markAll(userId, channelId, allowedChannelIds, isGuest = false): Promise<MarkAllResult> {
      if (channelId !== undefined && !allowedChannelIds.includes(channelId)) {
        return { ok: false, reason: 'forbidden' };
      }

      // Ephemeral for guests: nothing is persisted, so nothing was "marked".
      if (isGuest) return { ok: true, response: MarkAllResponseSchema.parse({ markedCount: 0 }) };

      const targetChannelIds = channelId !== undefined ? [channelId] : allowedChannelIds;
      const markedCount = await readStatusRepo.markAllInChannels(userId, targetChannelIds);

      return { ok: true, response: MarkAllResponseSchema.parse({ markedCount }) };
    },

    async unreadCount(userId, allowedChannelIds): Promise<UnreadCountResponse> {
      // No guest branch needed: guests never persist read rows (see the note above),
      // so this naturally returns all-unread for a guest session.
      const counts = await readStatusRepo.unreadCountByChannel(userId, allowedChannelIds);
      return UnreadCountResponseSchema.parse(counts);
    },
  };
}
