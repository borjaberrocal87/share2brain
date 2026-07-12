// Tiny browser-safe auth client for the SPA. Talks to the same-origin /api/auth/*
// endpoints (nginx in prod, the Vite dev proxy in dev — see vite.config.ts). Imports
// types/schemas ONLY from @share2brain/shared/schemas — never the root barrel or /db,
// which pull `pg` into the bundle (ESLint no-restricted-imports enforces this, AD-3).
import {
  AuthMeResponseSchema,
  GuestAvailabilityResponseSchema,
  type AuthMeResponse,
} from '@share2brain/shared/schemas';

import { CSRF_HEADER } from './csrf';

/** Full-page navigation target to start the Discord OAuth2 login (AC6). */
export const LOGIN_URL = '/api/auth/login';

/**
 * Resolve the current session's profile. 200 → the parsed profile; 401 → null
 * (unauthenticated). Any other status is an unexpected server error and throws.
 */
export async function fetchMe(): Promise<AuthMeResponse | null> {
  const res = await fetch('/api/auth/me', { credentials: 'include' });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`GET /api/auth/me failed: ${res.status}`);
  return AuthMeResponseSchema.parse(await res.json());
}

/** End the session server-side (deletes the Redis session key). */
export async function logout(): Promise<void> {
  await fetch('/api/auth/logout', {
    method: 'POST',
    credentials: 'include',
    headers: { ...CSRF_HEADER },
  });
}

/**
 * Probe whether guest access is enabled (Story 2.5, D1). 200 → the parsed
 * `enabled` flag; ANY non-200 (404 included, or a probe failure) → `false`, so a
 * disabled deployment simply hides the guest link and a probe error never breaks
 * the Discord path.
 */
export async function fetchGuestAvailability(): Promise<boolean> {
  const res = await fetch('/api/auth/guest', { credentials: 'include' });
  if (res.status !== 200) return false;
  return GuestAvailabilityResponseSchema.parse(await res.json()).enabled;
}

/** Create a guest session and resolve the guest profile (Story 2.5, AC6). */
export async function loginAsGuest(): Promise<AuthMeResponse> {
  const res = await fetch('/api/auth/guest', {
    method: 'POST',
    credentials: 'include',
    headers: { ...CSRF_HEADER },
  });
  if (!res.ok) throw new Error(`POST /api/auth/guest failed: ${res.status}`);
  return AuthMeResponseSchema.parse(await res.json());
}
