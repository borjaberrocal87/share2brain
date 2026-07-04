// Auth API contract (AD-6). The response shape for GET /api/auth/me plus the
// stable error codes the auth endpoints emit. Kept in shared so the web app can
// reference them via z.infer / the AUTH_ERROR map instead of hardcoding strings.
import { z } from 'zod';

/** GET /api/auth/me — the authenticated user's public profile. */
export const AuthMeResponseSchema = z.object({
  id: z.uuid(),
  discordId: z.string(),
  username: z.string(),
  avatar: z.string().nullable(),
});

export type AuthMeResponse = z.infer<typeof AuthMeResponseSchema>;

/** Stable error `code`s emitted by the auth endpoints (paired with ErrorSchema). */
export const AUTH_ERROR = {
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  GUILD_MEMBER_REQUIRED: 'GUILD_MEMBER_REQUIRED',
  INVALID_OAUTH_STATE: 'INVALID_OAUTH_STATE',
  OAUTH_CALLBACK_FAILED: 'OAUTH_CALLBACK_FAILED',
  LOGOUT_FAILED: 'LOGOUT_FAILED',
  INTERNAL: 'INTERNAL',
} as const;

export type AuthErrorCode = (typeof AUTH_ERROR)[keyof typeof AUTH_ERROR];
