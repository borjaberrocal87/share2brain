import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NotificationsConfig } from '../config/index.js';
import { createNotifier } from './index.js';

type LoggerMethod = (message: string, context?: Record<string, unknown>) => void;

function fakeLogger(): { warn: ReturnType<typeof vi.fn<LoggerMethod>>; error: ReturnType<typeof vi.fn<LoggerMethod>> } {
  return { warn: vi.fn<LoggerMethod>(), error: vi.fn<LoggerMethod>() };
}

describe('createNotifier', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('is a no-op (no fetch, no throw) when config is undefined', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const logger = fakeLogger();
    const notifier = createNotifier(undefined, logger);

    await expect(
      notifier.notify({ service: 'backend', message: 'boom', timestamp: '2026-07-08T00:00:00.000Z' }),
    ).resolves.toBeUndefined();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('is a no-op (no fetch, no throw) when enabled is false', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const logger = fakeLogger();
    const config: NotificationsConfig = {
      enabled: false,
      provider: 'telegram',
      telegram: { bot_token: 'secret-token', chat_id: '123' },
    };
    const notifier = createNotifier(config, logger);

    await notifier.notify({ service: 'bot', message: 'boom', timestamp: '2026-07-08T00:00:00.000Z' });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POSTs to the Telegram sendMessage endpoint with {chat_id, text}', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchSpy);
    const logger = fakeLogger();
    const config: NotificationsConfig = {
      enabled: true,
      provider: 'telegram',
      telegram: { bot_token: 'secret-token', chat_id: '999' },
    };
    const notifier = createNotifier(config, logger);

    await notifier.notify({ service: 'backend', message: 'db down', timestamp: '2026-07-08T00:00:00.000Z' });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.telegram.org/botsecret-token/sendMessage');
    const body = JSON.parse(init.body as string) as { chat_id: string; text: string };
    expect(body.chat_id).toBe('999');
    expect(body.text).toContain('backend');
    expect(body.text).toContain('db down');
    expect(body.text).toContain('2026-07-08T00:00:00.000Z');
  });

  it('POSTs to the Slack webhook URL with {text}', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchSpy);
    const logger = fakeLogger();
    const config: NotificationsConfig = {
      enabled: true,
      provider: 'slack',
      slack: { webhook_url: 'https://hooks.slack.com/services/secret-path' },
    };
    const notifier = createNotifier(config, logger);

    await notifier.notify({ service: 'workers', message: 'stream stalled', timestamp: '2026-07-08T00:00:01.000Z' });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://hooks.slack.com/services/secret-path');
    const body = JSON.parse(init.body as string) as { text: string };
    expect(body.text).toContain('workers');
    expect(body.text).toContain('stream stalled');
  });

  it('swallows a non-2xx response to a single logger.warn, never throws', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    vi.stubGlobal('fetch', fetchSpy);
    const logger = fakeLogger();
    const config: NotificationsConfig = {
      enabled: true,
      provider: 'telegram',
      telegram: { bot_token: 'secret-token', chat_id: '999' },
    };
    const notifier = createNotifier(config, logger);

    await expect(
      notifier.notify({ service: 'backend', message: 'boom', timestamp: '2026-07-08T00:00:00.000Z' }),
    ).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('swallows a timed-out fetch (AbortError) to a single logger.warn, never throws', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new DOMException('The operation was aborted', 'AbortError'));
    vi.stubGlobal('fetch', fetchSpy);
    const logger = fakeLogger();
    const config: NotificationsConfig = {
      enabled: true,
      provider: 'slack',
      slack: { webhook_url: 'https://hooks.slack.com/services/secret-path' },
    };
    const notifier = createNotifier(config, logger);

    await expect(
      notifier.notify({ service: 'workers', message: 'boom', timestamp: '2026-07-08T00:00:00.000Z' }),
    ).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('binds every send with an AbortSignal', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchSpy);
    const logger = fakeLogger();
    const config: NotificationsConfig = {
      enabled: true,
      provider: 'telegram',
      telegram: { bot_token: 'secret-token', chat_id: '999' },
    };
    const notifier = createNotifier(config, logger);

    await notifier.notify({ service: 'backend', message: 'boom', timestamp: '2026-07-08T00:00:00.000Z' });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('never leaks the bot token or webhook URL into a log line', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    vi.stubGlobal('fetch', fetchSpy);
    const logger = fakeLogger();
    const config: NotificationsConfig = {
      enabled: true,
      provider: 'telegram',
      telegram: { bot_token: 'super-secret-token', chat_id: '999' },
    };
    const notifier = createNotifier(config, logger);

    await notifier.notify({ service: 'backend', message: 'boom', timestamp: '2026-07-08T00:00:00.000Z' });

    const warnCallsAsText = logger.warn.mock.calls.map((call) => JSON.stringify(call));
    expect(warnCallsAsText.join('\n')).not.toContain('super-secret-token');
  });

  it('redacts credential userinfo from a connection URL embedded in the message (AC-1)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchSpy);
    const logger = fakeLogger();
    const config: NotificationsConfig = {
      enabled: true,
      provider: 'slack',
      slack: { webhook_url: 'https://hooks.slack.com/services/secret-path' },
    };
    const notifier = createNotifier(config, logger);

    await notifier.notify({
      service: 'backend',
      message: 'connect failed: postgres://admin:hunter2@db:5432/hivly and redis://:s3cr3t@cache:6379',
      timestamp: '2026-07-08T00:00:00.000Z',
    });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const { text } = JSON.parse(init.body as string) as { text: string };
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('s3cr3t');
    expect(text).toContain('postgres://***@db:5432/hivly');
    expect(text).toContain('redis://***@cache:6379');
  });

  it('truncates an oversized message so Telegram (4096-char limit) does not drop the alert', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchSpy);
    const logger = fakeLogger();
    const config: NotificationsConfig = {
      enabled: true,
      provider: 'telegram',
      telegram: { bot_token: 'secret-token', chat_id: '999' },
    };
    const notifier = createNotifier(config, logger);

    await notifier.notify({
      service: 'workers',
      message: 'x'.repeat(10_000),
      timestamp: '2026-07-08T00:00:00.000Z',
    });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const { text } = JSON.parse(init.body as string) as { text: string };
    // Well under Telegram's 4096 cap once the prefix/suffix are added.
    expect(text.length).toBeLessThan(4096);
    expect(text).toContain('…');
  });
});
