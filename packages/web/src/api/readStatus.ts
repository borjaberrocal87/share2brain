// Tiny browser-safe read-status client for the SPA. Talks to the same-origin
// /api/read-status endpoints. Imports types/schemas ONLY from @hivly/shared/schemas —
// never the root barrel or /db, which pull `pg` into the bundle (ESLint
// no-restricted-imports enforces this, AD-3). Mirrors api/search.ts.
import {
  MarkAllResponseSchema,
  UnreadCountResponseSchema,
  type MarkAllResponse,
  type UnreadCountResponse,
} from '@hivly/shared/schemas';

/** Mark a single fragment as read for the current user. Throws on failure (caller reverts optimistically). */
export async function markRead(embeddingId: string): Promise<void> {
  const res = await fetch(`/api/read-status/${embeddingId}`, {
    method: 'POST',
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`POST /api/read-status/${embeddingId} failed: ${res.status}`);
}

/** Mark every visible fragment as read, optionally narrowed to one channel. */
export async function markAll(channelId?: string): Promise<MarkAllResponse> {
  const res = await fetch('/api/read-status/mark-all', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(channelId ? { channelId } : {}),
  });
  if (!res.ok) throw new Error(`POST /api/read-status/mark-all failed: ${res.status}`);
  return MarkAllResponseSchema.parse(await res.json());
}

/** Per-channel unread count map for the current user (RBAC-scoped server-side). */
export async function fetchUnreadCount(signal?: AbortSignal): Promise<UnreadCountResponse> {
  const res = await fetch('/api/read-status/unread-count', { credentials: 'include', signal });
  if (!res.ok) throw new Error(`GET /api/read-status/unread-count failed: ${res.status}`);
  return UnreadCountResponseSchema.parse(await res.json());
}
