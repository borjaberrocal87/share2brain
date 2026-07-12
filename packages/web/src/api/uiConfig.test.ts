// Unit tests for fetchUiLanguage (Story 10.2, D2): the full failure matrix must
// degrade to 'es' and NEVER reject — a broken backend still yields a working
// Spanish login screen (mirrors the stub-global-fetch pattern in documents.test.ts).
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchUiLanguage } from './uiConfig';

function fakeFetch(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchUiLanguage', () => {
  it('should resolve "en" on a 200 response with language "en"', async () => {
    vi.stubGlobal('fetch', fakeFetch({ language: 'en' }));

    await expect(fetchUiLanguage()).resolves.toBe('en');
  });

  it('should resolve "es" on a 200 response with language "es"', async () => {
    vi.stubGlobal('fetch', fakeFetch({ language: 'es' }));

    await expect(fetchUiLanguage()).resolves.toBe('es');
  });

  it('should degrade to "es" on a network rejection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );

    await expect(fetchUiLanguage()).resolves.toBe('es');
  });

  it('should degrade to "es" on a non-200 response', async () => {
    vi.stubGlobal('fetch', fakeFetch({}, 500));

    await expect(fetchUiLanguage()).resolves.toBe('es');
  });

  it('should degrade to "es" on a malformed body', async () => {
    vi.stubGlobal('fetch', fakeFetch({ language: 'fr' }));

    await expect(fetchUiLanguage()).resolves.toBe('es');
  });

  it('should never reject, even when the response body is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not json', { status: 200 })),
    );

    await expect(fetchUiLanguage()).resolves.toBe('es');
  });
});
