// Infrastructure adapter: DiscordOAuthClient port implemented against the Discord
// REST API with the global fetch (Node 24+). discord.js is intentionally NOT used
// here — that library is for the bot's Gateway connection; the backend only needs
// these three REST calls of the OAuth2 flow.
import type {
  DiscordGuildMember,
  DiscordOAuthClient,
  DiscordUser,
} from '../domain/repositories/discordOAuthClient.js';

const DISCORD_API = 'https://discord.com/api';
const FETCH_TIMEOUT_MS = 10_000;

export function createFetchDiscordOAuthClient(cfg: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): DiscordOAuthClient {
  return {
    async exchangeCode(code: string): Promise<{ accessToken: string }> {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: cfg.redirectUri,
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
      });
      const res = await fetch(`${DISCORD_API}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new Error(`Discord token exchange failed (${res.status})`);
      }
      const json = (await res.json()) as Record<string, unknown>;
      // P4: validate the response shape instead of blindly casting.
      if (typeof json.access_token !== 'string') {
        throw new Error('Discord token response missing access_token');
      }
      return { accessToken: json.access_token };
    },

    async getCurrentUser(accessToken: string): Promise<DiscordUser> {
      const res = await fetch(`${DISCORD_API}/users/@me`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new Error(`Discord user fetch failed (${res.status})`);
      }
      const json = (await res.json()) as { id: string; username: string; avatar: string | null };
      return { id: json.id, username: json.username, avatar: json.avatar ?? null };
    },

    async getGuildMember(
      accessToken: string,
      guildId: string,
    ): Promise<DiscordGuildMember | null> {
      const res = await fetch(`${DISCORD_API}/users/@me/guilds/${guildId}/member`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      // 404 = the authenticated user is not a member of the guild.
      if (res.status === 404) {
        return null;
      }
      if (!res.ok) {
        throw new Error(`Discord guild member fetch failed (${res.status})`);
      }
      const json = (await res.json()) as Record<string, unknown>;
      // Validate roles shape at the boundary.
      if (!Array.isArray(json.roles)) {
        throw new Error('Discord guild member response has invalid roles');
      }
      return { roles: json.roles as string[] };
    },
  };
}
