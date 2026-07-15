// Auth API contract (AD-6). The response shape for GET /api/auth/me plus the
// stable error codes the auth endpoints emit. Kept in shared so the web app can
// reference them via z.infer / the AUTH_ERROR map instead of hardcoding strings.
import { z } from 'zod';

import { isHttpUrl } from './linkRefine.js';

/** GET /api/auth/me — the authenticated user's public profile. */
export const AuthMeResponseSchema = z.object({
  id: z.uuid(),
  discordId: z.string(),
  username: z.string(),
  avatar: z.string().nullable(),
  guildId: z.string().min(1), // Discord guild snowflake; empty would break "ver en Discord" links.
  // Story 2.5: present and `true` ONLY for guest sessions; absent for regular
  // users (never `false`). The web checks `user.isGuest === true`.
  isGuest: z.boolean().optional(),
});

export type AuthMeResponse = z.infer<typeof AuthMeResponseSchema>;

/**
 * GET /api/auth/guest — guest-access availability probe (Story 2.5). A disabled
 * deployment answers 404, so the ONLY 200 body is `{ enabled: true }` — the
 * `z.literal(true)` makes `{ enabled: false }` an invalid body, guaranteeing the
 * server never signals "guest exists but is off". The SPA treats any non-200 as
 * "hidden".
 *
 * Story 2.6: `inviteUrl` is OPTIONAL — present only when the operator configured
 * `access_control.guest_access.invite_url`. It carries the demo Discord invite the
 * login screen renders under the guest button; absent means "render no invite row".
 * Review 2026-07-15: the scheme is pinned to http(s) (shared `isHttpUrl`, the same
 * URL.canParse convention as `link` fields — never the deprecated `z.string().url()`)
 * so a `javascript:`/`data:` value can never reach the login-screen `href` even if the
 * server is coerced to emit one (defense-in-depth; the client parses this body first).
 */
export const GuestAvailabilityResponseSchema = z.object({
  enabled: z.literal(true),
  inviteUrl: z.string().refine(isHttpUrl, 'inviteUrl must be a valid HTTP(S) URL').optional(),
});

export type GuestAvailabilityResponse = z.infer<typeof GuestAvailabilityResponseSchema>;

/**
 * GET /api/auth/roles — the authenticated user's Discord roles and the channel
 * IDs they may access (RBAC expansion result). `allowedChannels` is computed
 * per-request from `channel_permissions`, never cached in the session.
 */
export const AuthRolesResponseSchema = z.object({
  roles: z.array(z.string()),
  allowedChannels: z.array(z.string()),
});

export type AuthRolesResponse = z.infer<typeof AuthRolesResponseSchema>;

/** Stable error `code`s emitted by the auth endpoints (paired with ErrorSchema). */
export const AUTH_ERROR = {
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  GUILD_MEMBER_REQUIRED: 'GUILD_MEMBER_REQUIRED',
  INVALID_OAUTH_STATE: 'INVALID_OAUTH_STATE',
  OAUTH_CALLBACK_FAILED: 'OAUTH_CALLBACK_FAILED',
  LOGOUT_FAILED: 'LOGOUT_FAILED',
  RBAC_EXPANSION_FAILED: 'RBAC_EXPANSION_FAILED',
  GUEST_ACCESS_DISABLED: 'GUEST_ACCESS_DISABLED',
  INTERNAL: 'INTERNAL',
} as const;

export type AuthErrorCode = (typeof AUTH_ERROR)[keyof typeof AUTH_ERROR];
