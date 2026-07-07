// Tiny browser-safe documents client for the SPA. Talks to the same-origin
// /api/documents endpoint. Imports types/schemas ONLY from @hivly/shared/schemas —
// never the root barrel or /db, which pull `pg` into the bundle (ESLint
// no-restricted-imports enforces this, AD-3). Mirrors api/search.ts.
import { DocumentsResponseSchema, type DocumentsResponse } from '@hivly/shared/schemas';

export interface FetchDocumentsParams {
  page: number;
  limit: number;
  channelId?: string;
  unreadOnly?: boolean;
}

/** A page of indexed document fragments (RBAC-scoped + read-annotated server-side). */
export async function fetchDocuments(
  params: FetchDocumentsParams,
  signal?: AbortSignal,
): Promise<DocumentsResponse> {
  const qs = new URLSearchParams({ page: String(params.page), limit: String(params.limit) });
  if (params.channelId) qs.set('channelId', params.channelId);
  if (params.unreadOnly) qs.set('unreadOnly', 'true');

  const res = await fetch(`/api/documents?${qs}`, { credentials: 'include', signal });
  if (!res.ok) throw new Error(`GET /api/documents failed: ${res.status}`);
  return DocumentsResponseSchema.parse(await res.json());
}
