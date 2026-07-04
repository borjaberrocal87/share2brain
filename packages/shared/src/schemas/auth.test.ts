import { describe, expect, it } from 'vitest';

import { AUTH_ERROR, AuthMeResponseSchema } from './auth.js';

describe('AuthMeResponseSchema', () => {
  it('should parse a valid profile when avatar is present', () => {
    const result = AuthMeResponseSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      discordId: '123456789012345678',
      username: 'ada',
      avatar: 'a1b2c3',
    });
    expect(result.success).toBe(true);
  });

  it('should parse a valid profile when avatar is null', () => {
    const result = AuthMeResponseSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      discordId: '123456789012345678',
      username: 'ada',
      avatar: null,
    });
    expect(result.success).toBe(true);
  });

  it('should reject a profile when id is not a uuid', () => {
    const result = AuthMeResponseSchema.safeParse({
      id: 'not-a-uuid',
      discordId: '123456789012345678',
      username: 'ada',
      avatar: null,
    });
    expect(result.success).toBe(false);
  });

  it('should reject a profile when a required field is missing', () => {
    const result = AuthMeResponseSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      username: 'ada',
      avatar: null,
    });
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
    expect(AUTH_ERROR.INTERNAL).toBe('INTERNAL');
  });
});
