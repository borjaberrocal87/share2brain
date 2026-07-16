import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the SDK: unit tests never open a real Sentry client / network. Only the
// surface the adapter touches needs stubbing.
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

import { createLogger, type LogSink } from '../logger.js';
import { createObservability } from './index.js';
import { NoopObservability, type ObservabilityProvider } from './observability.js';
import { createSentryObservability } from './sentry.js';

const initMock = vi.mocked(Sentry.init);
const setTagMock = vi.mocked(Sentry.setTag);

/** A LogSink that captures nothing to stdout, so logger-driven tests stay quiet. */
function silentSink(): LogSink {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const REAL_DSN = 'https://public@o0.ingest.sentry.io/1';

// AC6: beforeSend/beforeSendLog are module-private now — driven through the
// adapter, not free imports. Pull the hooks Sentry.init actually received.
type InitOptions = NonNullable<Parameters<typeof Sentry.init>[0]>;
type ErrorEventArg = Parameters<NonNullable<InitOptions['beforeSend']>>[0];
type LogArg = Parameters<NonNullable<InitOptions['beforeSendLog']>>[0];

function armAndCaptureHooks(service = 'backend'): {
  beforeSend: NonNullable<InitOptions['beforeSend']>;
  beforeSendLog: NonNullable<InitOptions['beforeSendLog']>;
} {
  createSentryObservability({ dsn: REAL_DSN, service });
  const opts = initMock.mock.calls[0]![0]!;
  return {
    beforeSend: opts.beforeSend!,
    beforeSendLog: opts.beforeSendLog!,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createObservability (S-5 factory / composition root)', () => {
  it('returns a Noop and NEVER calls Sentry.init when the DSN is empty (S-5, AC3)', () => {
    const obs = createObservability({ dsn: '', service: 'backend' });

    expect(initMock).not.toHaveBeenCalled();
    expect(setTagMock).not.toHaveBeenCalled();
    // Every method is a safe no-op and the log sink drops the line.
    expect(() => obs.captureException(new Error('x'))).not.toThrow();
    obs.logSink.log('info', 'dropped', { a: 1 });
    expect(vi.mocked(Sentry.logger.info)).not.toHaveBeenCalled();
  });

  it('flush() resolves immediately for the empty-DSN Noop (never touches Sentry.close)', async () => {
    const obs = createObservability({ dsn: '', service: 'bot' });

    await expect(obs.flush()).resolves.toBeUndefined();
    expect(vi.mocked(Sentry.close)).not.toHaveBeenCalled();
  });

  it('builds the Sentry adapter for a non-empty DSN (default provider)', () => {
    createObservability({ dsn: REAL_DSN, service: 'workers' });

    expect(initMock).toHaveBeenCalledTimes(1);
    expect(setTagMock).toHaveBeenCalledWith('service', 'workers');
  });

  it('fails safe to the Noop for an unrecognized provider (never crashes a boot, AC10)', () => {
    // The type + Zod enum admit only 'sentry' today; a future dev could add a
    // literal but forget the factory branch. Cast past the type to reach that
    // fallthrough and prove it degrades to the Noop instead of throwing / init'ing.
    const obs = createObservability({
      dsn: REAL_DSN,
      service: 'backend',
      provider: 'datadog' as ObservabilityProvider,
    });

    expect(obs).toBe(NoopObservability);
    expect(initMock).not.toHaveBeenCalled();
    expect(() => obs.captureException(new Error('x'))).not.toThrow();
  });
});

describe('createSentryObservability (adapter construction, AC5)', () => {
  it('initializes with top-level enableLogs + both scrub hooks, never _experiments or PII', () => {
    createSentryObservability({ dsn: REAL_DSN, service: 'backend' });

    expect(initMock).toHaveBeenCalledTimes(1);
    const opts = initMock.mock.calls[0]![0]!;
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

  it('tags every event with the emitting service name', () => {
    createSentryObservability({ dsn: REAL_DSN, service: 'workers' });

    expect(setTagMock).toHaveBeenCalledWith('service', 'workers');
  });
});

describe('beforeSend (AC6 — error events never leak secrets/content, driven through the adapter)', () => {
  it('redacts connection-string credentials in the message and exception value', () => {
    const { beforeSend } = armAndCaptureHooks();
    const event = beforeSend(
      {
        message: 'connect failed for redis://user:pass@cache:6379',
        exception: {
          values: [{ value: 'ECONNREFUSED postgres://admin:s3cr3t@db:5432/app' }],
        },
      } as unknown as ErrorEventArg,
      {},
    ) as ErrorEventArg;

    expect(event.message).toBe('connect failed for redis://***@cache:6379');
    expect(event.exception!.values![0]!.value).toBe('ECONNREFUSED postgres://***@db:5432/app');
  });

  it('strips a content key from extra so message content never rides an event', () => {
    const { beforeSend } = armAndCaptureHooks();
    const event = beforeSend(
      { extra: { content: 'super secret user message', channelId: '123' } } as unknown as ErrorEventArg,
      {},
    ) as ErrorEventArg;

    expect(event.extra).not.toHaveProperty('content');
    expect(event.extra!.channelId).toBe('123');
  });

  it('deep-redacts nested secrets and drops a nested content key (not just top-level)', () => {
    const { beforeSend } = armAndCaptureHooks();
    const event = beforeSend(
      {
        extra: {
          detail: { url: 'redis://user:pass@cache:6379', payload: { content: 'private body' } },
          urls: ['postgres://admin:s3cr3t@db:5432/app'],
        },
      } as unknown as ErrorEventArg,
      {},
    ) as ErrorEventArg;

    const detail = event.extra!.detail as Record<string, unknown>;
    expect(detail.url).toBe('redis://***@cache:6379');
    expect(detail.payload).not.toHaveProperty('content');
    expect((event.extra!.urls as string[])[0]).toBe('postgres://***@db:5432/app');
  });

  it('keeps a shared (non-circular) reference on sibling branches instead of dropping it as a cycle', () => {
    const { beforeSend } = armAndCaptureHooks();
    const shared = { url: 'redis://user:pass@cache:6379' };
    const event = beforeSend(
      { extra: { a: shared, b: shared, list: [shared, shared] } } as unknown as ErrorEventArg,
      {},
    ) as ErrorEventArg;

    const extra = event.extra as Record<string, Record<string, unknown>>;
    // Both sibling references survive and are redacted (path-scoped cycle guard).
    expect(extra.a.url).toBe('redis://***@cache:6379');
    expect(extra.b.url).toBe('redis://***@cache:6379');
    expect((extra.list as unknown as Array<Record<string, unknown>>)[1]!.url).toBe(
      'redis://***@cache:6379',
    );
  });

  it('drops a true circular reference without throwing', () => {
    const { beforeSend } = armAndCaptureHooks();
    const cyclic: Record<string, unknown> = { name: 'node' };
    cyclic.self = cyclic;

    expect(() => beforeSend({ extra: { cyclic } } as unknown as ErrorEventArg, {})).not.toThrow();
  });

  it('passes non-plain objects through unchanged instead of mangling them to {}', () => {
    const { beforeSend } = armAndCaptureHooks();
    const when = new Date('2026-07-13T00:00:00.000Z');
    const event = beforeSend({ extra: { when } } as unknown as ErrorEventArg, {}) as ErrorEventArg;

    // A Date must not be flattened into {} by Object.entries.
    expect(event.extra!.when).toBe(when);
  });

  it('scrubs auto-captured breadcrumbs and request context', () => {
    const { beforeSend } = armAndCaptureHooks();
    const event = beforeSend(
      {
        breadcrumbs: [
          { message: 'GET https://user:pass@api.example.com/x' },
          { message: 'ok', data: { url: 'redis://user:pass@cache:6379' } },
        ],
        request: {
          url: 'https://user:pass@api.example.com/path',
          query_string: 'redis://user:pass@cache:6379',
          headers: { authorization: 'redis://user:pass@cache:6379' },
        },
      } as unknown as ErrorEventArg,
      {},
    ) as ErrorEventArg;

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

describe('beforeSendLog (AC6 — logs never leak secrets/content; AC5 — stamps service)', () => {
  it('redacts the message + string attributes, DROPS content, and stamps the service', () => {
    const { beforeSendLog } = armAndCaptureHooks('bot');
    const log = beforeSendLog({
      level: 'info',
      message: 'using redis://user:pass@cache:6379',
      attributes: {
        url: 'postgres://admin:s3cr3t@db:5432/app',
        content: 'private discord message body',
        count: 3,
      },
    } as LogArg) as LogArg;

    expect(log.message).toBe('using redis://***@cache:6379');
    expect(log.attributes!.url).toBe('postgres://***@db:5432/app');
    expect(log.attributes).not.toHaveProperty('content');
    // Non-string, non-secret attributes pass through untouched.
    expect(log.attributes!.count).toBe(3);
    // AC5: the service is stamped as a log attribute (logs don't inherit scope tags).
    expect(log.attributes!.service).toBe('bot');
  });
});

describe('the port surface (single integration point, AC2/AC6/AC8)', () => {
  it('captureException forwards the error object to Sentry', () => {
    const obs = createSentryObservability({ dsn: REAL_DSN, service: 'backend' });
    const err = new Error('boom');
    obs.captureException(err);

    expect(vi.mocked(Sentry.captureException)).toHaveBeenCalledWith(err);
  });

  it('setUser forwards only id + roles (never PII)', () => {
    const obs = createSentryObservability({ dsn: REAL_DSN, service: 'backend' });
    obs.setUser({ id: 'internal-uuid', roles: ['role-a', 'guild-id'] });

    expect(vi.mocked(Sentry.setUser)).toHaveBeenCalledWith({
      id: 'internal-uuid',
      roles: ['role-a', 'guild-id'],
    });
  });

  it('setupExpressErrorHandler registers Sentry on the app', () => {
    const obs = createSentryObservability({ dsn: REAL_DSN, service: 'backend' });
    const app = { use: vi.fn() };
    obs.setupExpressErrorHandler(app);

    expect(vi.mocked(Sentry.setupExpressErrorHandler)).toHaveBeenCalledWith(app);
  });

  it('flush drains the transport queue before a fatal exit (bounded timeout)', async () => {
    const obs = createSentryObservability({ dsn: REAL_DSN, service: 'backend' });
    await obs.flush(2000);

    expect(vi.mocked(Sentry.close)).toHaveBeenCalledWith(2000);
  });

  it('flush never throws even if the SDK close rejects', async () => {
    const obs = createSentryObservability({ dsn: REAL_DSN, service: 'backend' });
    vi.mocked(Sentry.close).mockRejectedValueOnce(new Error('transport down'));

    await expect(obs.flush(500)).resolves.toBeUndefined();
  });

  it('logSink.log forwards to Sentry.logger[level] with the mapped message + attributes (AC1/AC4)', () => {
    const obs = createSentryObservability({ dsn: REAL_DSN, service: 'backend' });
    obs.logSink.log('warn', 'disk almost full', { pct: 92 });

    expect(vi.mocked(Sentry.logger.warn)).toHaveBeenCalledWith('disk almost full', { pct: 92 });
  });
});

// Port contract (mirrors Notifier's "never throws or rejects"): a broken vendor
// SDK must never throw into the app — captureException is the FIRST call in every
// service's fatal handler. Removing the adapter `guard(...)` must fail these.
describe('the port never throws even when the Sentry SDK does', () => {
  it('captureException swallows an SDK throw', () => {
    const obs = createSentryObservability({ dsn: REAL_DSN, service: 'backend' });
    vi.mocked(Sentry.captureException).mockImplementationOnce(() => {
      throw new Error('SDK disarmed');
    });

    expect(() => obs.captureException(new Error('boom'))).not.toThrow();
  });

  it('setUser swallows an SDK throw', () => {
    const obs = createSentryObservability({ dsn: REAL_DSN, service: 'backend' });
    vi.mocked(Sentry.setUser).mockImplementationOnce(() => {
      throw new Error('SDK disarmed');
    });

    expect(() => obs.setUser({ id: 'u', roles: [] })).not.toThrow();
  });

  it('setupExpressErrorHandler degrades (does not throw) but surfaces a boot-time signal', () => {
    const obs = createSentryObservability({ dsn: REAL_DSN, service: 'backend' });
    vi.mocked(Sentry.setupExpressErrorHandler).mockImplementationOnce(() => {
      throw new Error('SDK disarmed');
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      // Boot must not crash on an observability wiring fault (degrade)...
      expect(() => obs.setupExpressErrorHandler({ use: vi.fn() })).not.toThrow();
      // ...but unlike the silent hot-path guards, this once-per-boot call emits a
      // one-line signal so the operator knows 5xx capture was not wired.
      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(consoleError.mock.calls[0]![0]).toContain('setupExpressErrorHandler');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('logSink.log swallows an SDK throw on the hot logging path', () => {
    const obs = createSentryObservability({ dsn: REAL_DSN, service: 'backend' });
    vi.mocked(Sentry.logger.info).mockImplementationOnce(() => {
      throw new Error('SDK disarmed');
    });

    expect(() => obs.logSink.log('info', 'line', {})).not.toThrow();
  });
});

// A line emitted through the shared logger reaches Sentry via the port's logSink
// with redaction applied (real logger + real adapter sink — the first hop is
// genuine), and the captured `beforeSendLog` hook then stamps the `service` on
// that same payload (the SDK is mocked, so we invoke the hook directly rather
// than rely on Sentry.logger to run it). Previously covered only by two disjoint
// half-tests (logSink in isolation + logger against a fake sink).
describe('logger → port logSink → Sentry.logger, then beforeSendLog stamps service (AC4/AC5)', () => {
  it('forwards a redacted line to Sentry and stamps the service on it', () => {
    const obs = createSentryObservability({ dsn: REAL_DSN, service: 'workers' });
    const beforeSendLog = initMock.mock.calls[0]![0]!.beforeSendLog!;
    const logger = createLogger('info', 'workers', silentSink(), obs.logSink);

    logger.warn('using redis://user:pass@cache:6379', { pct: 92 });

    // The line reached Sentry.logger.warn with the redacted message + attributes
    // (no [service] prefix — that is a stdout-only concern).
    expect(vi.mocked(Sentry.logger.warn)).toHaveBeenCalledWith('using redis://***@cache:6379', {
      pct: 92,
    });

    // When the SDK runs beforeSendLog on that same payload, the service is stamped.
    const [message, attributes] = vi.mocked(Sentry.logger.warn).mock.calls[0]!;
    const finalized = beforeSendLog({
      level: 'warn',
      message: message as string,
      attributes: attributes as Record<string, unknown>,
    } as LogArg) as LogArg;

    expect(finalized.attributes!.service).toBe('workers');
    expect(finalized.attributes!.pct).toBe(92);
    expect(finalized.message).toBe('using redis://***@cache:6379');
  });

  it('drops a below-threshold line before it can reach Sentry', () => {
    const obs = createSentryObservability({ dsn: REAL_DSN, service: 'workers' });
    const logger = createLogger('warn', 'workers', silentSink(), obs.logSink);

    logger.info('quiet line', { a: 1 });

    expect(vi.mocked(Sentry.logger.info)).not.toHaveBeenCalled();
  });
});
