// Application service: orchestrates the Discord OAuth2 login. Depends only on the
// domain ports (UserRepository, DiscordOAuthClient) — never on Drizzle, fetch or
// express — so it is unit-testable with plain fakes and the layering stays honest.
import { AuthMeResponseSchema, type AuthMeResponse } from '@share2brain/shared/schemas';

import {
  GuildMembershipError,
  type DiscordOAuthClient,
} from '../../domain/repositories/discordOAuthClient.js';
import type { UserRepository } from '../../domain/repositories/userRepository.js';

/** What we persist in the Redis session (AD-10) — nothing more. */
export interface AuthSession {
  userId: string;
  discordRoles: string[];
}

export interface AuthService {
  /**
   * Complete the OAuth2 callback: exchange the code, verify guild membership,
   * upsert the user. Returns the session payload. Throws {@link GuildMembershipError}
   * if the user is not a member of the guild.
   */
  handleCallback(code: string): Promise<AuthSession>;

  /** Resolve the public profile for a session's user, or `null` if it no longer exists. */
  getMe(userId: string): Promise<AuthMeResponse | null>;
}

export function createAuthService(deps: {
  users: UserRepository;
  oauth: DiscordOAuthClient;
  guildId: string;
}): AuthService {
  const { users, oauth, guildId } = deps;

  return {
    async handleCallback(code: string): Promise<AuthSession> {
      const { accessToken } = await oauth.exchangeCode(code);
      const discordUser = await oauth.getCurrentUser(accessToken);
      const member = await oauth.getGuildMember(accessToken, guildId);
      if (member === null) {
        throw new GuildMembershipError();
      }

      const { id } = await users.upsertByDiscordId({
        discordId: discordUser.id,
        username: discordUser.username,
        avatar: discordUser.avatar,
      });

      // Discord's guild-member endpoint omits the `@everyone` role, whose ID equals
      // the guild ID. Inject it so `@everyone` allow rules (AD-12) match every member.
      const discordRoles = member.roles.includes(guildId)
        ? member.roles
        : [...member.roles, guildId];
      return { userId: id, discordRoles };
    },

    async getMe(userId: string): Promise<AuthMeResponse | null> {
      const user = await users.findById(userId);
      if (user === null) {
        return null;
      }
      // Validate against the shared contract before it leaves the service (AD-6).
      return AuthMeResponseSchema.parse({
        id: user.id,
        discordId: user.discordId,
        username: user.username,
        avatar: user.avatar,
        guildId,
      });
    },
  };
}
