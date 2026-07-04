import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFetchDiscordOAuthClient } from './discordOAuthClient.fetch.js';

/** Build a minimal fetch Response double. */
function fakeResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const CFG = {
  clientId: 'client-1',
  clientSecret: 'secret-1',
  redirectUri: 'http://localhost:3000/api/auth/callback',
};

describe('fetch DiscordOAuthClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should exchange the code as form-urlencoded and return the access token', async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse({ access_token: 'tok-1' }));
    const client = createFetchDiscordOAuthClient(CFG);

    const result = await client.exchangeCode('the-code');

    expect(result).toEqual({ accessToken: 'tok-1' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://discord.com/api/oauth2/token');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    const body = init.body as URLSearchParams;
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('the-code');
    expect(body.get('redirect_uri')).toBe(CFG.redirectUri);
    expect(body.get('client_id')).toBe(CFG.clientId);
  });

  it('should fetch the current user with a Bearer token', async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse({ id: 'd-1', username: 'ada', avatar: 'av' }));
    const client = createFetchDiscordOAuthClient(CFG);

    const user = await client.getCurrentUser('tok-1');

    expect(user).toEqual({ id: 'd-1', username: 'ada', avatar: 'av' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://discord.com/api/users/@me');
    expect(init.headers.Authorization).toBe('Bearer tok-1');
  });

  it('should return the roles when the user is a guild member', async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse({ roles: ['admin', 'mod'] }));
    const client = createFetchDiscordOAuthClient(CFG);

    const member = await client.getGuildMember('tok-1', 'guild-1');

    expect(member).toEqual({ roles: ['admin', 'mod'] });
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://discord.com/api/users/@me/guilds/guild-1/member',
    );
  });

  it('should return null when the member endpoint answers 404 (not a member)', async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse({}, 404));
    const client = createFetchDiscordOAuthClient(CFG);

    const member = await client.getGuildMember('tok-1', 'guild-1');

    expect(member).toBeNull();
  });

  it('should throw when the member endpoint fails with a non-404 error', async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse({}, 500));
    const client = createFetchDiscordOAuthClient(CFG);

    await expect(client.getGuildMember('tok-1', 'guild-1')).rejects.toThrow();
  });
});
