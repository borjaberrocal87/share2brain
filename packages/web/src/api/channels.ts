// Tiny browser-safe channels client for the SPA. Talks to the same-origin
// /api/channels endpoint. Imports types/schemas ONLY from @share2brain/shared/schemas —
// never the root barrel or /db, which pull `pg` into the bundle (ESLint
// no-restricted-imports enforces this, AD-3). Mirrors api/search.ts.
import { ChannelsResponseSchema, type Channel } from '@share2brain/shared/schemas';

/** Channels the current session's Discord roles may access (RBAC-scoped server-side). */
export async function fetchChannels(): Promise<Channel[]> {
  const res = await fetch('/api/channels', { credentials: 'include' });
  if (!res.ok) throw new Error(`GET /api/channels failed: ${res.status}`);
  return ChannelsResponseSchema.parse(await res.json()).channels;
}
