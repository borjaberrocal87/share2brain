// Unit tests for the documents API client: asserts the query string omits
// unreadOnly when false and channelId when unset (never sends the noise value).
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchDocuments } from './documents';

function fakeFetch(body: unknown): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchDocuments', () => {
  it('should omit channelId and unreadOnly from the query string when unset', async () => {
    const fetchMock = fakeFetch({ results: [], page: 1, limit: 20, total: 0 });
    vi.stubGlobal('fetch', fetchMock);

    await fetchDocuments({ page: 1, limit: 20 });

    const [url] = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe('/api/documents?page=1&limit=20');
  });

  it('should include channelId and unreadOnly=true when set', async () => {
    const fetchMock = fakeFetch({ results: [], page: 1, limit: 20, total: 0 });
    vi.stubGlobal('fetch', fetchMock);

    await fetchDocuments({ page: 1, limit: 20, channelId: 'chan-1', unreadOnly: true });

    const [url] = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe('/api/documents?page=1&limit=20&channelId=chan-1&unreadOnly=true');
  });

  it('should throw on a non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 500 })),
    );

    await expect(fetchDocuments({ page: 1, limit: 20 })).rejects.toThrow();
  });
});
