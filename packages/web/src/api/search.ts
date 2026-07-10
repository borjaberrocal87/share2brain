// Tiny browser-safe search client for the SPA. Talks to the same-origin
// /api/search endpoint. Imports types/schemas ONLY from @share2brain/shared/schemas —
// never the root barrel or /db, which pull `pg` into the bundle (ESLint
// no-restricted-imports enforces this, AD-3). Mirrors api/auth.ts.
import { SearchResponseSchema, type SearchResponse } from '@share2brain/shared/schemas';

/** Run a semantic search over the indexed knowledge (RBAC-scoped server-side). */
export async function search(q: string, signal?: AbortSignal): Promise<SearchResponse> {
  const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, {
    credentials: 'include',
    signal,
  });
  if (!res.ok) throw new Error(`GET /api/search failed: ${res.status}`);
  return SearchResponseSchema.parse(await res.json());
}
