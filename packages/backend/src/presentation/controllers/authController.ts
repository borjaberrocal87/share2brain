// Presentation: HTTP handlers for the Discord OAuth2 endpoints. Owns HTTP concerns
// (redirects, status codes, session cookie) and maps domain errors to the unified
// ErrorSchema shape. Raw Discord/DB errors are never leaked to the client.
import { randomBytes } from 'node:crypto';

import { AUTH_ERROR, GuestAvailabilityResponseSchema } from '@share2brain/shared/schemas';
import type { Request, Response } from 'express';

import type { AuthService } from '../../application/services/authService.js';
import type { RbacService } from '../../application/services/rbacService.js';
import { GuildMembershipError } from '../../domain/repositories/discordOAuthClient.js';

const DISCORD_AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';
const OAUTH_SCOPES = 'identify guilds.members.read';

export interface AuthController {
  login(req: Request, res: Response): void;
  callback(req: Request, res: Response): Promise<void>;
  me(req: Request, res: Response): Promise<void>;
  roles(req: Request, res: Response): Promise<void>;
  logout(req: Request, res: Response): void;
  guestAvailability(req: Request, res: Response): void;
  guestLogin(req: Request, res: Response): Promise<void>;
}

export function createAuthController(deps: {
  authService: AuthService;
  rbacService: RbacService;
  discord: { clientId: string; redirectUri: string };
  frontendUrl: string;
  cookieSecure: boolean;
  /**
   * Guest access (Story 2.5). PRESENCE = enabled — when absent the two guest
   * endpoints 404, so an app built without it (buildTestAppOptions, the e2e
   * server's default, main.ts with the flag off) has guest access disabled.
   */
  guestAccess?: { role: string; sessionTtlMinutes: number; userId: string };
}): AuthController {
  const { authService, rbacService, discord, frontendUrl, cookieSecure, guestAccess } = deps;

  return {
    login(req, res) {
      // CSRF: store a random state in the session and echo it on the authorize URL.
      const state = randomBytes(16).toString('hex');
      req.session.oauthState = state;
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: discord.clientId,
        scope: OAUTH_SCOPES,
        redirect_uri: discord.redirectUri,
        state,
      });
      // P5: persist the session before redirecting so the oauthState is guaranteed
      // to be in Redis when Discord calls back (avoids race under Redis latency).
      req.session.save((err: unknown) => {
        if (err) {
          console.error('[auth] session save failed:', err instanceof Error ? err.message : String(err));
          res.status(500).json({ error: 'Internal error', code: AUTH_ERROR.INTERNAL });
          return;
        }
        res.redirect(302, `${DISCORD_AUTHORIZE_URL}?${params.toString()}`);
      });
    },

    async callback(req, res) {
      const code = typeof req.query.code === 'string' ? req.query.code : '';
      const state = typeof req.query.state === 'string' ? req.query.state : '';
      const expectedState = req.session.oauthState;

      // CSRF guard: reject a missing code or a state that doesn't match the session.
      if (!code || !state || !expectedState || state !== expectedState) {
        res.status(400).json({ error: 'Invalid OAuth state', code: AUTH_ERROR.INVALID_OAUTH_STATE });
        return;
      }
      delete req.session.oauthState;

      try {
        const { userId, discordRoles } = await authService.handleCallback(code);
        // P1: regenerate the session ID to prevent session fixation attacks.
        // The pre-auth session ID must not be reusable after authentication.
        req.session.regenerate((regenErr: unknown) => {
          if (regenErr) {
            console.error('[auth] session regenerate failed:', regenErr instanceof Error ? regenErr.message : String(regenErr));
            res.status(500).json({ error: 'Internal error', code: AUTH_ERROR.INTERNAL });
            return;
          }
          req.session.userId = userId;
          req.session.discordRoles = discordRoles;
          // Explicit save after regenerate to guarantee the authenticated session
          // is persisted before the redirect (consistent with the login flow).
          req.session.save((saveErr: unknown) => {
            if (saveErr) {
              console.error('[auth] session save failed:', saveErr instanceof Error ? saveErr.message : String(saveErr));
              res.status(500).json({ error: 'Internal error', code: AUTH_ERROR.INTERNAL });
              return;
            }
            res.redirect(`${frontendUrl}/`);
          });
        });
      } catch (err) {
        if (err instanceof GuildMembershipError) {
          res
            .status(403)
            .json({ error: 'No eres miembro del guild', code: AUTH_ERROR.GUILD_MEMBER_REQUIRED });
          return;
        }
        // Map anything else to a generic failure — never leak Discord/DB internals.
        console.error(
          '[auth] callback failed:',
          err instanceof Error ? err.message : String(err),
        );
        res.status(502).json({ error: 'Authentication failed', code: AUTH_ERROR.OAUTH_CALLBACK_FAILED });
      }
    },

    async me(req, res) {
      const userId = req.session.userId;
      if (!userId) {
        res.status(401).json({ error: 'Unauthorized', code: AUTH_ERROR.AUTH_REQUIRED });
        return;
      }
      try {
        const profile = await authService.getMe(userId);
        if (profile === null) {
          // Session references a user that no longer exists — treat as unauthenticated.
          res.status(401).json({ error: 'Unauthorized', code: AUTH_ERROR.AUTH_REQUIRED });
          return;
        }
        // Story 2.5: surface the guest flag only when the session is a guest one
        // (absent otherwise — the schema field is optional, never `false`, D6).
        res
          .status(200)
          .json(req.session.isGuest === true ? { ...profile, isGuest: true } : profile);
      } catch (err) {
        console.error('[auth] /me failed:', err instanceof Error ? err.message : String(err));
        res.status(500).json({ error: 'Internal error', code: AUTH_ERROR.INTERNAL });
      }
    },

    async roles(req, res) {
      // Defensive: the route also runs requireAuth, but never trust a single gate.
      const userId = req.session.userId;
      if (!userId) {
        res.status(401).json({ error: 'Unauthorized', code: AUTH_ERROR.AUTH_REQUIRED });
        return;
      }
      try {
        const payload = await rbacService.getRolesResponse(req.session.discordRoles ?? []);
        res.status(200).json(payload);
      } catch (err) {
        // Map the DB error to a structured 500 — never leak the raw error.
        console.error('[auth] /roles failed:', err instanceof Error ? err.message : String(err));
        res.status(500).json({ error: 'Internal error', code: AUTH_ERROR.RBAC_EXPANSION_FAILED });
      }
    },

    logout(req, res) {
      const cookieOpts = { path: '/', httpOnly: true as const, sameSite: 'lax' as const, secure: cookieSecure };
      req.session.destroy((err: unknown) => {
        if (err) {
          console.error(
            '[auth] session destroy failed:',
            err instanceof Error ? err.message : String(err),
          );
          // P6: always clear the cookie even when Redis is down, so the client
          // doesn't carry a stale session ID that will fail on every request.
          res.clearCookie('sid', cookieOpts);
          res.status(500).json({ error: 'Logout failed', code: AUTH_ERROR.LOGOUT_FAILED });
          return;
        }
        // P9: pass explicit cookie options matching the session middleware config
        // so clearCookie stays correct if the session config changes.
        res.clearCookie('sid', cookieOpts);
        res.status(200).json({ ok: true });
      });
    },

    guestAvailability(_req, res) {
      // D1: link-visibility probe. Disabled → the same existence-hiding 404 as the
      // POST (never `{ enabled: false }`); enabled → the literal-true body.
      if (!guestAccess) {
        res.status(404).json({ error: 'Not found', code: AUTH_ERROR.GUEST_ACCESS_DISABLED });
        return;
      }
      res.status(200).json(GuestAvailabilityResponseSchema.parse({ enabled: true }));
    },

    async guestLogin(req, res) {
      if (!guestAccess) {
        res.status(404).json({ error: 'Not found', code: AUTH_ERROR.GUEST_ACCESS_DISABLED });
        return;
      }
      try {
        // Resolve the guest profile BEFORE touching the session (review P-1). The
        // OAuth callback likewise resolves handleCallback before regenerate: no
        // session must be established until we know the guest row exists, or a
        // missing-seed 500 would leave a valid, RBAC-scoped session cookie behind.
        const me = await authService.getMe(guestAccess.userId);
        if (me === null) {
          // The seed invariant is broken (guest row missing) — no session, 500.
          console.error('[auth] guest login failed: seeded guest user not found');
          res.status(500).json({ error: 'Internal error', code: AUTH_ERROR.INTERNAL });
          return;
        }
        // Only now establish the session, mirroring the OAuth callback's
        // establishment (P1 anti-fixation): regenerate → set fields → explicit save
        // → respond.
        req.session.regenerate((regenErr: unknown) => {
          if (regenErr) {
            console.error('[auth] guest session regenerate failed:', regenErr instanceof Error ? regenErr.message : String(regenErr));
            res.status(500).json({ error: 'Internal error', code: AUTH_ERROR.INTERNAL });
            return;
          }
          req.session.userId = guestAccess.userId;
          req.session.discordRoles = [guestAccess.role];
          req.session.isGuest = true;
          // D7: per-session TTL. connect-redis@9 derives the Redis EX from
          // sess.cookie.expires (which express-session computes from maxAge) and it
          // WINS over the store-level ttl — so the cookie and the Redis key expire
          // together with the short demo TTL, no store/config change needed.
          req.session.cookie.maxAge = guestAccess.sessionTtlMinutes * 60_000;
          req.session.save((saveErr: unknown) => {
            if (saveErr) {
              console.error('[auth] guest session save failed:', saveErr instanceof Error ? saveErr.message : String(saveErr));
              res.status(500).json({ error: 'Internal error', code: AUTH_ERROR.INTERNAL });
              return;
            }
            res.status(200).json({ ...me, isGuest: true });
          });
        });
      } catch (err) {
        console.error('[auth] guest login failed:', err instanceof Error ? err.message : String(err));
        res.status(500).json({ error: 'Internal error', code: AUTH_ERROR.INTERNAL });
      }
    },
  };
}
