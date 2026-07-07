// Tiny browser-safe conversations client for the SPA (Story 5.3). Talks to the
// same-origin /api/conversations LIST endpoint (Story 5.2 read side). Imports
// types/schemas ONLY from @hivly/shared/schemas — never the root barrel or /db,
// which pull `pg` into the bundle (ESLint no-restricted-imports enforces this,
// AD-3). Mirrors api/documents.ts.
//
// This is the LIST client only. The detail client (GET /api/conversations/:id)
// and the chat/SSE client are Story 5.4's concern — do not add them here.
import { ConversationsResponseSchema, type ConversationsResponse } from '@hivly/shared/schemas';

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
