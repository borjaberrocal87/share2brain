// Unit tests for the Story 2.5 guest-access controller surface + config resolver.
// No DB/Redis: minimal req/res doubles (per requireAuth.test.ts) and a fake session
// whose regenerate/save invoke their callbacks synchronously. The gate semantics
// (404-when-disabled on both verbs) and the session shape/TTL are the security
// boundary this story pins, so they are tested here (tests-first where it pays).
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import type { AuthService } from '../../application/services/authService.js';
import type { RbacService } from '../../application/services/rbacService.js';
import { resolveGuestAccessConfig } from '../../infrastructure/guestAccess.js';
import { createAuthController } from './authController.js';

/** res double capturing the status/json emitted. */
function fakeRes(): Response & { statusCode?: number; body?: unknown } {
  const res = {} as Response & { statusCode?: number; body?: unknown };
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  }) as unknown as Response['status'];
  res.json = vi.fn((payload: unknown) => {
    res.body = payload;
    return res;
  }) as unknown as Response['json'];
  return res;
}

/** Session double: regenerate/save invoke cb(null) synchronously; cookie is mutable. */
function fakeReqWithSession(): Request {
  const session = {
    cookie: { maxAge: 0 },
    regenerate(cb: (err: unknown) => void) {
      cb(null);
      return this;
    },
    save(cb: (err: unknown) => void) {
      cb(null);
      return this;
    },
  };
  return { session } as unknown as Request;
}

const GUEST_ID = '00000000-0000-4000-a000-000000000001';

const GUEST_PROFILE = {
  id: GUEST_ID,
  discordId: 'guest',
  username: 'Invitado',
  avatar: null,
  guildId: '111222333444555666',
};

function buildController(opts: {
  guestAccess?: { role: string; sessionTtlMinutes: number; userId: string };
  getMe?: AuthService['getMe'];
}) {
  const authService = {
    handleCallback: vi.fn(),
    getMe: opts.getMe ?? (vi.fn().mockResolvedValue(GUEST_PROFILE) as unknown as AuthService['getMe']),
  } as unknown as AuthService;
  const rbacService = { getRolesResponse: vi.fn() } as unknown as RbacService;
  return createAuthController({
    authService,
    rbacService,
    discord: { clientId: 'cid', redirectUri: 'https://app/cb' },
    frontendUrl: 'https://app',
    cookieSecure: false,
    ...(opts.guestAccess ? { guestAccess: opts.guestAccess } : {}),
  });
}

/** Await until res.json has been called (guestLogin resolves via getMe's promise). */
async function flush(res: Response & { body?: unknown }): Promise<void> {
  for (let i = 0; i < 10 && res.body === undefined; i++) await Promise.resolve();
}

describe('authController guest access — disabled (no guestAccess dep)', () => {
  it('should respond 404 GUEST_ACCESS_DISABLED for the availability probe', () => {
    const controller = buildController({});
    const res = fakeRes();

    controller.guestAvailability({} as Request, res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Not found', code: 'GUEST_ACCESS_DISABLED' });
  });

  it('should respond 404 GUEST_ACCESS_DISABLED for guest login', async () => {
    const controller = buildController({});
    const res = fakeRes();

    await controller.guestLogin(fakeReqWithSession(), res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Not found', code: 'GUEST_ACCESS_DISABLED' });
  });
});

describe('authController guest access — enabled', () => {
  const guestAccess = { role: 'guest', sessionTtlMinutes: 120, userId: GUEST_ID };

  it('should respond 200 { enabled: true } for the availability probe', () => {
    const controller = buildController({ guestAccess });
    const res = fakeRes();

    controller.guestAvailability({} as Request, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ enabled: true });
  });

  it('should set the guest session fields + per-session TTL and return isGuest: true', async () => {
    const controller = buildController({ guestAccess });
    const req = fakeReqWithSession();
    const res = fakeRes();

    await controller.guestLogin(req, res);
    await flush(res);

    expect(req.session.userId).toBe(GUEST_ID);
    expect(req.session.discordRoles).toEqual(['guest']);
    expect(req.session.isGuest).toBe(true);
    expect(req.session.cookie.maxAge).toBe(120 * 60_000);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ...GUEST_PROFILE, isGuest: true });
  });

  it('should respond 500 INTERNAL when the seeded guest user is missing (getMe null)', async () => {
    const getMe = vi.fn().mockResolvedValue(null) as unknown as AuthService['getMe'];
    const controller = buildController({ guestAccess, getMe });
    const res = fakeRes();

    await controller.guestLogin(fakeReqWithSession(), res);
    await flush(res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Internal error', code: 'INTERNAL' });
  });
});

describe('resolveGuestAccessConfig', () => {
  const base = {
    enabled: true,
    default_policy: 'deny' as const,
    role_cache_ttl: 300,
    channel_permissions: [],
  };

  it('should default to disabled when the guest_access block is absent', () => {
    expect(resolveGuestAccessConfig(base)).toEqual({
      enabled: false,
      role: 'guest',
      username: 'Invitado',
      sessionTtlMinutes: 120,
    });
  });

  it('should fill per-field defaults for a partial block (only enabled)', () => {
    expect(resolveGuestAccessConfig({ ...base, guest_access: { enabled: true } })).toEqual({
      enabled: true,
      role: 'guest',
      username: 'Invitado',
      sessionTtlMinutes: 120,
    });
  });

  it('should honor a fully specified block', () => {
    const resolved = resolveGuestAccessConfig({
      ...base,
      guest_access: { enabled: true, role: 'demo', username: 'Guest', session_ttl_minutes: 30 },
    });
    expect(resolved).toEqual({ enabled: true, role: 'demo', username: 'Guest', sessionTtlMinutes: 30 });
  });
});
