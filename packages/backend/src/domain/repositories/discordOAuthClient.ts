// Domain port: the outbound contract for talking to Discord's OAuth2 REST API.
// Pure — no fetch, no HTTP details. The fetch-based adapter lives in
// infrastructure/. Keeping this an interface lets the application service (and
// its tests) depend on behavior, not on the network.

/** The user's public profile as returned by Discord's `GET /users/@me`. */
export interface DiscordUser {
  id: string;
  username: string;
  avatar: string | null;
}

/** The subset of the guild-member payload we need (the user's role ids). */
export interface DiscordGuildMember {
  roles: string[];
}

export interface DiscordOAuthClient {
  /** Exchange an authorization `code` for an access token. */
  exchangeCode(code: string): Promise<{ accessToken: string }>;

  /** Fetch the authenticated user's profile. */
  getCurrentUser(accessToken: string): Promise<DiscordUser>;

  /**
   * Fetch the user's membership in `guildId`. Returns `null` when the user is
   * NOT a member of the guild (Discord answers 404), which the caller maps to a
   * membership rejection.
   */
  getGuildMember(accessToken: string, guildId: string): Promise<DiscordGuildMember | null>;
}

/**
 * Raised when an authenticated Discord user is not a member of the target guild.
 * The controller maps this to HTTP 403 `GUILD_MEMBER_REQUIRED`.
 */
export class GuildMembershipError extends Error {
  constructor(message = 'User is not a member of the guild') {
    super(message);
    this.name = 'GuildMembershipError';
  }
}
