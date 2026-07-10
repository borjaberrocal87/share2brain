// Tiny browser-safe conversations client for the SPA (Story 5.3). Talks to the
// same-origin /api/conversations LIST endpoint (Story 5.2 read side). Imports
// types/schemas ONLY from @share2brain/shared/schemas — never the root barrel or /db,
// which pull `pg` into the bundle (ESLint no-restricted-imports enforces this,
// AD-3). Mirrors api/documents.ts.
//
// The LIST client (`fetchConversations`) landed in 5.3; the DETAIL client
// (`fetchConversation`, GET /api/conversations/:id) is Story 5.4 — it loads a
// selected conversation's messages into the chat. The chat/SSE client lives in
// api/chat.ts.
import {
  ConversationDetailSchema,
  ConversationsResponseSchema,
  type ConversationDetail,
  type ConversationsResponse,
} from '@share2brain/shared/schemas';

/** A page of the caller's own conversation summaries (title derived server-side,
 * ordered updated_at DESC). */
export async function fetchConversations(
  params: { page?: number; limit?: number } = {},
  signal?: AbortSignal,
): Promise<ConversationsResponse> {
  const qs = new URLSearchParams();
  if (params.page) qs.set('page', String(params.page));
  if (params.limit) qs.set('limit', String(params.limit));

  const res = await fetch(`/api/conversations${qs.toString() ? `?${qs}` : ''}`, {
    credentials: 'include',
    signal,
  });
  if (!res.ok) throw new Error(`GET /api/conversations failed: ${res.status}`);
  return ConversationsResponseSchema.parse(await res.json());
}

/** A single conversation with its messages, ordered chronologically (Story 5.4).
 * Ownership is enforced server-side — a non-owned/unknown/malformed id yields 404. */
export async function fetchConversation(
  id: string,
  signal?: AbortSignal,
): Promise<ConversationDetail> {
  const res = await fetch(`/api/conversations/${encodeURIComponent(id)}`, {
    credentials: 'include',
    signal,
  });
  if (!res.ok) throw new Error(`GET /api/conversations/:id failed: ${res.status}`);
  return ConversationDetailSchema.parse(await res.json());
}
