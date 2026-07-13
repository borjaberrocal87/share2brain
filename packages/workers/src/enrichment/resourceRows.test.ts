import type { Share2BrainConfig } from '@share2brain/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from '@share2brain/shared/logger';
import { enrich } from './enrich.js';
import { buildResourceRows, MAX_URLS_PER_MESSAGE } from './resourceRows.js';
import type { GuardedDispatcher } from './ssrfGuard.js';
import { fetchUrl } from './urlFetcher.js';

vi.mock('./urlFetcher.js', () => ({ fetchUrl: vi.fn() }));
vi.mock('./enrich.js', async () => {
  const actual = await vi.importActual<typeof import('./enrich.js')>('./enrich.js');
  return { ...actual, enrich: vi.fn() };
});

const config = {
  enrichment: {
    language: 'en',
    llm: { timeout_ms: 60_000 },
    fetch: {
      timeout_ms: 5000,
      max_bytes: 2_000_000,
      max_redirects: 3,
      user_agent: 'Share2BrainTest/1.0',
      allowed_schemes: ['https'],
      block_private_ips: true,
    },
  },
} as unknown as Share2BrainConfig;

const enrichModel = {} as unknown as import('./enrich.js').EnrichmentChatModel;
const guard = {} as unknown as GuardedDispatcher;

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function neverAbortedSignal(): AbortSignal {
  return new AbortController().signal;
}

beforeEach(() => {
  vi.mocked(fetchUrl).mockReset();
  vi.mocked(enrich).mockReset();
  vi.mocked(fetchUrl).mockImplementation(async (url: string) =>
    Promise.resolve({ ok: true, body: '<html></html>', contentType: 'text/html', finalUrl: url }),
  );
  vi.mocked(enrich).mockImplementation(async (_model, input: { messageText: string }) =>
    Promise.resolve({ title: `Title for ${input.messageText}`, description: 'A description' }),
  );
});

describe('buildResourceRows', () => {
  it('should discard a message with no URLs', async () => {
    const logger = makeLogger();

    const outcome = await buildResourceRows('just chatting, no links here', {
      config,
      enrichModel,
      guard,
      logger,
      signal: neverAbortedSignal(),
    });

    expect(outcome).toEqual({ kind: 'discard' });
    expect(fetchUrl).not.toHaveBeenCalled();
  });

  it('should produce one row per URL, in extraction order', async () => {
    const logger = makeLogger();

    const outcome = await buildResourceRows('see https://a.com and https://b.com', {
      config,
      enrichModel,
      guard,
      logger,
      signal: neverAbortedSignal(),
    });

    expect(outcome.kind).toBe('rows');
    if (outcome.kind !== 'rows') throw new Error('unreachable');
    expect(outcome.rows.map((r) => r.link).sort()).toEqual(['https://a.com/', 'https://b.com/']);
    expect(outcome.rows.every((r) => r.embedding === undefined)).toBe(true);
  });

  it('should cap URLs at MAX_URLS_PER_MESSAGE and warn about the dropped count', async () => {
    const logger = makeLogger();
    const urls = Array.from({ length: 25 }, (_, i) => `https://ex.com/${i}`);

    const outcome = await buildResourceRows(urls.join(' '), {
      config,
      enrichModel,
      guard,
      logger,
      signal: neverAbortedSignal(),
    });

    expect(outcome.kind).toBe('rows');
    if (outcome.kind !== 'rows') throw new Error('unreachable');
    expect(outcome.rows).toHaveLength(MAX_URLS_PER_MESSAGE);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('URL cap'),
      expect.objectContaining({ extracted: 25, cap: MAX_URLS_PER_MESSAGE, dropped: 5 }),
    );
  });

  it('should fall back to text-only enrichment when the fetch fails for a non-SSRF reason', async () => {
    vi.mocked(fetchUrl).mockResolvedValue({ ok: false, reason: 'timeout' });
    const logger = makeLogger();

    const outcome = await buildResourceRows('https://a.com', {
      config,
      enrichModel,
      guard,
      logger,
      signal: neverAbortedSignal(),
    });

    expect(outcome.kind).toBe('rows');
    expect(vi.mocked(enrich).mock.calls[0][1]).toMatchObject({ pageHints: null });
  });

  it('should skip an SSRF-blocked URL (no row, not a failure)', async () => {
    vi.mocked(fetchUrl).mockResolvedValue({ ok: false, reason: 'ssrf_blocked' });
    const logger = makeLogger();

    const outcome = await buildResourceRows('https://blocked.com', {
      config,
      enrichModel,
      guard,
      logger,
      signal: neverAbortedSignal(),
    });

    expect(outcome).toEqual({ kind: 'discard' });
    expect(enrich).not.toHaveBeenCalled();
  });

  it('should skip a scheme-disallowed URL like an SSRF block', async () => {
    vi.mocked(fetchUrl).mockResolvedValue({ ok: false, reason: 'scheme_disallowed' });
    const logger = makeLogger();

    const outcome = await buildResourceRows('https://a.com', {
      config,
      enrichModel,
      guard,
      logger,
      signal: neverAbortedSignal(),
    });

    expect(outcome).toEqual({ kind: 'discard' });
  });

  it('should throw when enrich fails for any URL (D1) — the caller leaves the message un-ACKed', async () => {
    vi.mocked(enrich).mockRejectedValue(new Error('LLM provider down'));
    const logger = makeLogger();

    await expect(
      buildResourceRows('https://a.com', { config, enrichModel, guard, logger, signal: neverAbortedSignal() }),
    ).rejects.toThrow('LLM provider down');
  });

  it('should throw when the signal is already aborted', async () => {
    const logger = makeLogger();
    const controller = new AbortController();
    controller.abort();

    await expect(
      buildResourceRows('https://a.com', { config, enrichModel, guard, logger, signal: controller.signal }),
    ).rejects.toThrow(/aborted/);
    expect(fetchUrl).not.toHaveBeenCalled();
  });

  it('should reuse a kept link without fetching or enriching it, carrying its embedding through', async () => {
    const logger = makeLogger();
    const reusedEmbedding = [0.9, 0.8, 0.7];
    const reuse = vi.fn((link: string) =>
      link === 'https://kept.com/'
        ? { title: 'Kept Title', description: 'Kept Description', embedding: reusedEmbedding }
        : undefined,
    );

    const outcome = await buildResourceRows('https://kept.com and https://new.com', {
      config,
      enrichModel,
      guard,
      logger,
      signal: neverAbortedSignal(),
      reuse,
    });

    expect(outcome.kind).toBe('rows');
    if (outcome.kind !== 'rows') throw new Error('unreachable');
    expect(outcome.rows).toHaveLength(2);

    const kept = outcome.rows.find((r) => r.link === 'https://kept.com/');
    expect(kept).toMatchObject({ title: 'Kept Title', description: 'Kept Description', embedding: reusedEmbedding });

    const fresh = outcome.rows.find((r) => r.link === 'https://new.com/');
    expect(fresh?.embedding).toBeUndefined();

    expect(fetchUrl).toHaveBeenCalledTimes(1);
    expect(fetchUrl).toHaveBeenCalledWith('https://new.com/', expect.anything(), guard, expect.anything());
    expect(enrich).toHaveBeenCalledTimes(1);
  });

  it('should discard when every link is reused as empty and none produce rows otherwise', async () => {
    const logger = makeLogger();
    vi.mocked(fetchUrl).mockResolvedValue({ ok: false, reason: 'ssrf_blocked' });
    const reuse = vi.fn(() => undefined);

    const outcome = await buildResourceRows('https://a.com', {
      config,
      enrichModel,
      guard,
      logger,
      signal: neverAbortedSignal(),
      reuse,
    });

    expect(outcome).toEqual({ kind: 'discard' });
    expect(reuse).toHaveBeenCalledWith('https://a.com/');
  });
});
