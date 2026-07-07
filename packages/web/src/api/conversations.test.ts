// Unit tests for the conversations API client (Story 5.3): asserts the query
// string omits page/limit when unset, sends credentials, parses the response,
// and throws on a non-ok status. Mirrors documents.test.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchConversations } from './conversations';

function fakeFetch(body: unknown): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchConversations', () => {
  it('should request /api/conversations with no query string when no params are set', async () => {
    const fetchMock = fakeFetch({ results: [], page: 1, limit: 20, total: 0 });
    vi.stubGlobal('fetch', fetchMock);

    await fetchConversations();

    const [url, init] = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/conversations');
    expect(init.credentials).toBe('include');
  });

  it('should include page and limit in the query string when set', async () => {
    const fetchMock = fakeFetch({ results: [], page: 2, limit: 10, total: 0 });
    vi.stubGlobal('fetch', fetchMock);

    await fetchConversations({ page: 2, limit: 10 });

    const [url] = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe('/api/conversations?page=2&limit=10');
  });

  it('should parse and return the conversations response', async () => {
    const body = {
      results: [
        {
          id: '550e8400-e29b-41d4-a716-446655440000',
          title: 'How do I configure Hivly?',
          createdAt: '2026-07-01T00:00:00.000Z',
          updatedAt: '2026-07-02T00:00:00.000Z',
        },
      ],
      page: 1,
      limit: 20,
      total: 1,
    };
    vi.stubGlobal('fetch', fakeFetch(body));

    const res = await fetchConversations();

    expect(res.results).toHaveLength(1);
    expect(res.results[0].title).toBe('How do I configure Hivly?');
    expect(res.total).toBe(1);
  });

  it('should throw on a non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 500 })),
    );

    await expect(fetchConversations()).rejects.toThrow();
  });
});
