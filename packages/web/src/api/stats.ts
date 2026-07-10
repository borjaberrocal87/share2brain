// Tiny browser-safe stats client for the SPA. Talks to the same-origin
// /api/stats endpoint. Imports types/schemas ONLY from @hivly/shared/schemas —
// never the root barrel or /db, which pull `pg` into the bundle (ESLint
// no-restricted-imports enforces this, AD-3). Mirrors api/search.ts.
import { StatsResponseSchema, type StatsResponse } from '@hivly/shared/schemas';

/** Fetch RBAC-scoped knowledge stats for the current session (server-side scoped, AD-12). */
export async function fetchStats(signal?: AbortSignal): Promise<StatsResponse> {
  const res = await fetch('/api/stats', { credentials: 'include', signal });
  if (!res.ok) throw new Error(`GET /api/stats failed: ${res.status}`);
  return StatsResponseSchema.parse(await res.json());
}
