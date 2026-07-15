// Unit tests for the guest-availability probe client (Story 2.5 + 2.6): asserts
// the widened return that carries the optional demo inviteUrl, and that any
// non-200 collapses to { enabled: false }. Mocks fetch (mirror documents.test.ts).
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchGuestAvailability } from './auth';

function fakeFetch(body: unknown, status: number): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchGuestAvailability', () => {
  it('should return { enabled: true, inviteUrl } when the 200 body carries the field', async () => {
    vi.stubGlobal('fetch', fakeFetch({ enabled: true, inviteUrl: 'https://discord.gg/x' }, 200));

    expect(await fetchGuestAvailability()).toEqual({ enabled: true, inviteUrl: 'https://discord.gg/x' });
  });

  it('should return { enabled: true, inviteUrl: undefined } when the 200 body omits it', async () => {
    vi.stubGlobal('fetch', fakeFetch({ enabled: true }, 200));

    expect(await fetchGuestAvailability()).toEqual({ enabled: true, inviteUrl: undefined });
  });

  it('should return { enabled: false } on a non-200 (guest access disabled)', async () => {
    vi.stubGlobal('fetch', fakeFetch({ error: 'Not found', code: 'GUEST_ACCESS_DISABLED' }, 404));

    expect(await fetchGuestAvailability()).toEqual({ enabled: false });
  });
});
