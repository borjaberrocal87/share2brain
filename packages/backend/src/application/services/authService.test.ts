import { describe, expect, it, vi } from 'vitest';

import {
  GuildMembershipError,
  type DiscordGuildMember,
  type DiscordOAuthClient,
  type DiscordUser,
} from '../../domain/repositories/discordOAuthClient.js';
import type { UserProfile, UserRepository } from '../../domain/repositories/userRepository.js';
import { createAuthService } from './authService.js';

// --- Fakes: plain objects implementing the domain ports. No db, no fetch. -------

function fakeOAuth(overrides: Partial<DiscordOAuthClient> = {}): DiscordOAuthClient {
  const user: DiscordUser = { id: 'discord-1', username: 'ada', avatar: 'av1' };
  const member: DiscordGuildMember = { roles: ['admin', 'mod'] };
  return {
    exchangeCode: vi.fn(async () => ({ accessToken: 'token-1' })),
    getCurrentUser: vi.fn(async () => user),
    getGuildMember: vi.fn(async () => member),
    ...overrides,
  };
}

function fakeUsers(overrides: Partial<UserRepository> = {}): UserRepository {
  return {
    upsertByDiscordId: vi.fn(async () => ({ id: 'user-uuid-1' })),
    findById: vi.fn(async () => null),
    ...overrides,
  };
}

const GUILD_ID = 'guild-1';

describe('authService.handleCallback', () => {
  it('should upsert the user and return the session when the user is a guild member', async () => {
    const oauth = fakeOAuth();
    const users = fakeUsers();
    const service = createAuthService({ users, oauth, guildId: GUILD_ID });

    const session = await service.handleCallback('auth-code');

    expect(session).toEqual({ userId: 'user-uuid-1', discordRoles: ['admin', 'mod'] });
    expect(oauth.getGuildMember).toHaveBeenCalledWith('token-1', GUILD_ID);
    expect(users.upsertByDiscordId).toHaveBeenCalledWith({
      discordId: 'discord-1',
      username: 'ada',
      avatar: 'av1',
    });
  });

  it('should throw GuildMembershipError when the user is not a guild member', async () => {
    const oauth = fakeOAuth({ getGuildMember: vi.fn(async () => null) });
    const users = fakeUsers();
    const service = createAuthService({ users, oauth, guildId: GUILD_ID });

    await expect(service.handleCallback('auth-code')).rejects.toBeInstanceOf(GuildMembershipError);
    expect(users.upsertByDiscordId).not.toHaveBeenCalled();
  });
});

describe('authService.getMe', () => {
  it('should return the parsed profile when the user exists', async () => {
    const profile: UserProfile = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      discordId: 'discord-1',
      username: 'ada',
      avatar: null,
    };
    const users = fakeUsers({ findById: vi.fn(async () => profile) });
    const service = createAuthService({ users, oauth: fakeOAuth(), guildId: GUILD_ID });

    const me = await service.getMe(profile.id);

    expect(me).toEqual(profile);
  });

  it('should return null when the session user no longer exists', async () => {
    const users = fakeUsers({ findById: vi.fn(async () => null) });
    const service = createAuthService({ users, oauth: fakeOAuth(), guildId: GUILD_ID });

    const me = await service.getMe('missing-id');

    expect(me).toBeNull();
  });
});
