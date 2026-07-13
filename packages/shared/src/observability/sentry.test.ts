import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the SDK: unit tests never open a real Sentry client / network. Only the
// surface `sentry.ts` touches needs stubbing.
vi.mock('@sentry/node', () => ({
  init: vi.fn(),
  setTag: vi.fn(),
  captureException: vi.fn(),
  setUser: vi.fn(),
  setupExpressErrorHandler: vi.fn(),
  close: vi.fn().mockResolvedValue(true),
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import * as Sentry from '@sentry/node';

import {
  beforeSend,
  beforeSendLog,
  captureException,
  flushSentry,
  initSentry,
  setSentryUser,
} from './sentry.js';

const initMock = vi.mocked(Sentry.init);
const setTagMock = vi.mocked(Sentry.setTag);

// Type helpers so the pure hooks can be exercised without hand-building the whole
// (large) Sentry event/log shapes.
type ErrorEventArg = Parameters<typeof beforeSend>[0];
type LogArg = Parameters<typeof beforeSendLog>[0];

const REAL_DSN = 'https://public@o0.ingest.sentry.io/1';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('initSentry', () => {
  it('is a no-op when the DSN is empty (S-5, AC3)', () => {
    initSentry('', 'backend');

    expect(initMock).not.toHaveBeenCalled();
    expect(setTagMock).not.toHaveBeenCalled();
  });

  it('initializes with top-level enableLogs + both scrub hooks, never _experiments or PII (AC4)', () => {
    initSentry(REAL_DSN, 'backend');

    expect(initMock).toHaveBeenCalledTimes(1);
    const opts = initMock.mock.calls[0][0]!;
    expect(opts.dsn).toBe(REAL_DSN);
    expect(opts.enableLogs).toBe(true);
    expect(typeof opts.beforeSend).toBe('function');
    expect(typeof opts.beforeSendLog).toBe('function');
    expect(opts.environment).toBeTypeOf('string');
    // Structured Logs are GA — the flag must be top-level, not the old _experiments.
    expect((opts as Record<string, unknown>)._experiments).toBeUndefined();
    // NFR13: PII must stay off.
    expect(opts.sendDefaultPii).toBeUndefined();
  });

  it('tags every event with the emitting service name (AC4)', () => {
    initSentry(REAL_DSN, 'workers');

    expect(setTagMock).toHaveBeenCalledWith('service', 'workers');
  });
});

describe('beforeSend (AC8 — error events never leak secrets/content)', () => {
  it('redacts connection-string credentials in the message and exception value', () => {
    const event = beforeSend({
      message: 'connect failed for redis://user:pass@cache:6379',
      exception: {
        values: [{ value: 'ECONNREFUSED postgres://admin:s3cr3t@db:5432/app' }],
      },
    } as unknown as ErrorEventArg);

    expect(event.message).toBe('connect failed for redis://***@cache:6379');
    expect(event.exception!.values![0]!.value).toBe('ECONNREFUSED postgres://***@db:5432/app');
  });

  it('strips a content key from extra so message content never rides an event', () => {
    const event = beforeSend({
      extra: { content: 'super secret user message', channelId: '123' },
    } as unknown as ErrorEventArg);

    expect(event.extra).not.toHaveProperty('content');
    expect(event.extra!.channelId).toBe('123');
  });

  it('deep-redacts nested secrets and drops a nested content key (not just top-level)', () => {
    const event = beforeSend({
      extra: {
        detail: { url: 'redis://user:pass@cache:6379', payload: { content: 'private body' } },
        urls: ['postgres://admin:s3cr3t@db:5432/app'],
      },
    } as unknown as ErrorEventArg);

    const detail = (event.extra!.detail as Record<string, unknown>);
    expect(detail.url).toBe('redis://***@cache:6379');
    expect(detail.payload).not.toHaveProperty('content');
    expect((event.extra!.urls as string[])[0]).toBe('postgres://***@db:5432/app');
  });

  it('keeps a shared (non-circular) reference on sibling branches instead of dropping it as a cycle', () => {
    const shared = { url: 'redis://user:pass@cache:6379' };
    const event = beforeSend({
      extra: { a: shared, b: shared, list: [shared, shared] },
    } as unknown as ErrorEventArg);

    const extra = event.extra as Record<string, Record<string, unknown>>;
    // Both sibling references survive and are redacted (path-scoped cycle guard).
    expect(extra.a.url).toBe('redis://***@cache:6379');
    expect(extra.b.url).toBe('redis://***@cache:6379');
    expect((extra.list as unknown as Array<Record<string, unknown>>)[1]!.url).toBe(
      'redis://***@cache:6379',
    );
  });

  it('drops a true circular reference without throwing', () => {
    const cyclic: Record<string, unknown> = { name: 'node' };
    cyclic.self = cyclic;

    expect(() =>
      beforeSend({ extra: { cyclic } } as unknown as ErrorEventArg),
    ).not.toThrow();
  });

  it('passes non-plain objects through unchanged instead of mangling them to {}', () => {
    const when = new Date('2026-07-13T00:00:00.000Z');
    const event = beforeSend({ extra: { when } } as unknown as ErrorEventArg);

    // A Date must not be flattened into {} by Object.entries.
    expect(event.extra!.when).toBe(when);
  });

  it('scrubs auto-captured breadcrumbs and request context', () => {
    const event = beforeSend({
      breadcrumbs: [
        { message: 'GET https://user:pass@api.example.com/x' },
        { message: 'ok', data: { url: 'redis://user:pass@cache:6379' } },
      ],
      request: {
        url: 'https://user:pass@api.example.com/path',
        query_string: 'redis://user:pass@cache:6379',
        headers: { authorization: 'redis://user:pass@cache:6379' },
      },
    } as unknown as ErrorEventArg);

    expect(event.breadcrumbs![0]!.message).toBe('GET https://***@api.example.com/x');
    expect((event.breadcrumbs![1]!.data as Record<string, unknown>).url).toBe(
      'redis://***@cache:6379',
    );
    expect(event.request!.url).toBe('https://***@api.example.com/path');
    expect(event.request!.query_string).toBe('redis://***@cache:6379');
    expect((event.request!.headers as Record<string, string>).authorization).toBe(
      'redis://***@cache:6379',
    );
  });
});

describe('beforeSendLog (AC8 — logs never leak secrets/content)', () => {
  it('redacts the message + string attributes and DROPS a content attribute', () => {
    const log = beforeSendLog({
      level: 'info',
      message: 'using redis://user:pass@cache:6379',
      attributes: {
        url: 'postgres://admin:s3cr3t@db:5432/app',
        content: 'private discord message body',
        count: 3,
      },
    } as LogArg);

    expect(log.message).toBe('using redis://***@cache:6379');
    expect(log.attributes!.url).toBe('postgres://***@db:5432/app');
    expect(log.attributes).not.toHaveProperty('content');
    // Non-string, non-secret attributes pass through untouched.
    expect(log.attributes!.count).toBe(3);
  });
});

describe('thin SDK wrappers (single integration point, AC2/AC6/AC7)', () => {
  it('captureException forwards the error object to Sentry', () => {
    const err = new Error('boom');
    captureException(err);

    expect(vi.mocked(Sentry.captureException)).toHaveBeenCalledWith(err);
  });

  it('setSentryUser forwards only id + roles (never PII)', () => {
    setSentryUser({ id: 'internal-uuid', roles: ['role-a', 'guild-id'] });

    expect(vi.mocked(Sentry.setUser)).toHaveBeenCalledWith({
      id: 'internal-uuid',
      roles: ['role-a', 'guild-id'],
    });
  });

  it('flushSentry drains the transport queue before a fatal exit (bounded timeout)', async () => {
    await flushSentry(2000);

    expect(vi.mocked(Sentry.close)).toHaveBeenCalledWith(2000);
  });

  it('flushSentry never throws even if the SDK close rejects', async () => {
    vi.mocked(Sentry.close).mockRejectedValueOnce(new Error('transport down'));

    await expect(flushSentry(500)).resolves.toBeUndefined();
  });
});
