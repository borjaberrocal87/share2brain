import { describe, expect, it } from 'vitest';

import {
  AUTH_ERROR,
  AuthMeResponseSchema,
  AuthRolesResponseSchema,
  GuestAvailabilityResponseSchema,
} from './auth.js';

describe('AuthMeResponseSchema', () => {
  it('should parse a valid profile when avatar is present', () => {
    const result = AuthMeResponseSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      discordId: '123456789012345678',
      username: 'ada',
      avatar: 'a1b2c3',
      guildId: '111222333444555666',
    });
    expect(result.success).toBe(true);
  });

  it('should parse a valid profile when avatar is null', () => {
    const result = AuthMeResponseSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      discordId: '123456789012345678',
      username: 'ada',
      avatar: null,
      guildId: '111222333444555666',
    });
    expect(result.success).toBe(true);
  });

  it('should reject a profile when id is not a uuid', () => {
    const result = AuthMeResponseSchema.safeParse({
      id: 'not-a-uuid',
      discordId: '123456789012345678',
      username: 'ada',
      avatar: null,
      guildId: '111222333444555666',
    });
    expect(result.success).toBe(false);
  });

  it('should reject a profile when a required field is missing', () => {
    const result = AuthMeResponseSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      username: 'ada',
      avatar: null,
      guildId: '111222333444555666',
    });
    expect(result.success).toBe(false);
  });

  it('should reject a profile when guildId is missing', () => {
    const result = AuthMeResponseSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      discordId: '123456789012345678',
      username: 'ada',
      avatar: null,
    });
    expect(result.success).toBe(false);
  });

  // Story 2.5: isGuest is optional-when-true — a regular profile (absent) and a
  // guest profile (present true) must both round-trip.
  it('should parse a profile without isGuest (regular user)', () => {
    const result = AuthMeResponseSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      discordId: '123456789012345678',
      username: 'ada',
      avatar: null,
      guildId: '111222333444555666',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.isGuest).toBeUndefined();
  });

  it('should parse a guest profile with isGuest: true', () => {
    const result = AuthMeResponseSchema.safeParse({
      id: '00000000-0000-4000-a000-000000000001',
      discordId: 'guest',
      username: 'Invitado',
      avatar: null,
      guildId: '111222333444555666',
      isGuest: true,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.isGuest).toBe(true);
  });
});

describe('GuestAvailabilityResponseSchema', () => {
  it('should accept { enabled: true }', () => {
    expect(GuestAvailabilityResponseSchema.safeParse({ enabled: true }).success).toBe(true);
  });

  it('should reject { enabled: false } (disabled is expressed by the 404, never this body)', () => {
    expect(GuestAvailabilityResponseSchema.safeParse({ enabled: false }).success).toBe(false);
  });
});

describe('AuthRolesResponseSchema', () => {
  it('should parse a populated roles + allowedChannels response', () => {
    const result = AuthRolesResponseSchema.safeParse({
      roles: ['admin', 'mod'],
      allowedChannels: ['1234567890', '9876543210'],
    });
    expect(result.success).toBe(true);
  });

  it('should parse empty arrays (deny-by-default: no matching rule)', () => {
    const result = AuthRolesResponseSchema.safeParse({ roles: [], allowedChannels: [] });
    expect(result.success).toBe(true);
  });

  it('should round-trip through parse without altering the arrays', () => {
    const input = { roles: ['member'], allowedChannels: ['42'] };
    expect(AuthRolesResponseSchema.parse(input)).toEqual(input);
  });

  it('should reject when a channel id is not a string', () => {
    const result = AuthRolesResponseSchema.safeParse({ roles: ['admin'], allowedChannels: [42] });
    expect(result.success).toBe(false);
  });
});

describe('AUTH_ERROR', () => {
  it('should expose the stable auth error codes', () => {
    expect(AUTH_ERROR.AUTH_REQUIRED).toBe('AUTH_REQUIRED');
    expect(AUTH_ERROR.GUILD_MEMBER_REQUIRED).toBe('GUILD_MEMBER_REQUIRED');
    expect(AUTH_ERROR.INVALID_OAUTH_STATE).toBe('INVALID_OAUTH_STATE');
    expect(AUTH_ERROR.OAUTH_CALLBACK_FAILED).toBe('OAUTH_CALLBACK_FAILED');
    expect(AUTH_ERROR.LOGOUT_FAILED).toBe('LOGOUT_FAILED');
    expect(AUTH_ERROR.RBAC_EXPANSION_FAILED).toBe('RBAC_EXPANSION_FAILED');
    expect(AUTH_ERROR.GUEST_ACCESS_DISABLED).toBe('GUEST_ACCESS_DISABLED');
    expect(AUTH_ERROR.INTERNAL).toBe('INTERNAL');
  });
});
