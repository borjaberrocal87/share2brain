import { beforeEach, describe, expect, it, vi } from 'vitest';

// Story ops-5: the logger forwards to an injected vendor-neutral StructuredLogSink
// (no vendor SDK import here anymore — that is the proof of decoupling, AC4).
// Tests inject a fake sink and assert the forward.
import { createLogger, redactSecrets, type LogLevel, type StructuredLogSink } from './logger.js';

beforeEach(() => {
  vi.clearAllMocks();
});

type SinkMethod = (...args: unknown[]) => void;

function fakeSink(): Record<'debug' | 'info' | 'warn' | 'error', ReturnType<typeof vi.fn<SinkMethod>>> {
  return {
    debug: vi.fn<SinkMethod>(),
    info: vi.fn<SinkMethod>(),
    warn: vi.fn<SinkMethod>(),
    error: vi.fn<SinkMethod>(),
  };
}

type StructuredLogFn = (level: LogLevel, message: string, attributes?: Record<string, unknown>) => void;

/** A fake structured sink recording every forwarded line. */
function fakeStructuredSink(): StructuredLogSink & { log: ReturnType<typeof vi.fn<StructuredLogFn>> } {
  return { log: vi.fn<StructuredLogFn>() };
}

describe('createLogger', () => {
  it('prefixes every emitted line with the service name', () => {
    const sink = fakeSink();
    const logger = createLogger('debug', 'backend', sink);

    logger.info('booted');

    expect(sink.info).toHaveBeenCalledWith('[backend] info booted');
  });

  it('gates messages below the configured level', () => {
    const sink = fakeSink();
    const logger = createLogger('info', 'backend', sink);

    logger.debug('should be suppressed');
    logger.info('should be emitted');

    expect(sink.debug).not.toHaveBeenCalled();
    expect(sink.info).toHaveBeenCalledWith('[backend] info should be emitted');
  });

  it('emits error at every configured level (highest severity)', () => {
    const sink = fakeSink();
    const logger = createLogger('error', 'backend', sink);

    logger.debug('suppressed');
    logger.info('suppressed');
    logger.warn('suppressed');
    logger.error('shown');

    expect(sink.debug).not.toHaveBeenCalled();
    expect(sink.info).not.toHaveBeenCalled();
    expect(sink.warn).not.toHaveBeenCalled();
    expect(sink.error).toHaveBeenCalledWith('[backend] error shown');
  });

  it('serializes a non-empty context object as trailing JSON', () => {
    const sink = fakeSink();
    const logger = createLogger('debug', 'backend', sink);

    logger.warn('retrying', { attempt: 2, reason: 'timeout' });

    expect(sink.warn).toHaveBeenCalledWith(
      '[backend] warn retrying',
      JSON.stringify({ attempt: 2, reason: 'timeout' }),
    );
  });

  it('omits the JSON argument entirely when context is absent or empty', () => {
    const sink = fakeSink();
    const logger = createLogger('debug', 'backend', sink);

    logger.info('no context');
    logger.info('empty context', {});

    expect(sink.info).toHaveBeenNthCalledWith(1, '[backend] info no context');
    expect(sink.info).toHaveBeenNthCalledWith(2, '[backend] info empty context');
  });

  it('parameterizes the prefix per service so each caller gets its own tag', () => {
    const sink = fakeSink();
    const workersLogger = createLogger('debug', 'workers', sink);

    workersLogger.error('crashed');

    expect(sink.error).toHaveBeenCalledWith('[workers] error crashed');
  });

  // AUDIT M2: a driver error can interpolate the whole DATABASE_URL/REDIS_URL
  // (password included) into error.message/.stack; the logger must redact the
  // userinfo of any connection URL it emits, in both the message and the context.
  it('redacts connection-URL credentials in the message and the context JSON', () => {
    const sink = fakeSink();
    const logger = createLogger('error', 'workers', sink);

    logger.error('connect failed to postgres://s2b:hunter2@db:5432/app', {
      reason: 'ECONNREFUSED redis://:sekret@redis:6379',
    });

    expect(sink.error).toHaveBeenCalledWith(
      '[workers] error connect failed to postgres://***@db:5432/app',
      JSON.stringify({ reason: 'ECONNREFUSED redis://***@redis:6379' }),
    );
  });
});

describe('structured-log sink dual forward (Story ops-4/ops-5, AC4/AC5)', () => {
  it('forwards an emitted line to sink.log(level, message, attrs) with the SAME redaction as stdout', () => {
    const sink = fakeSink();
    const structured = fakeStructuredSink();
    const logger = createLogger('debug', 'backend', sink, structured);

    logger.info('connecting to redis://user:pass@cache:6379', {
      url: 'redis://user:pass@cache:6379',
      count: 2,
    });

    // Message is the raw (redacted) line — the `[service]` prefix is a stdout
    // formatting concern; off-box the service rides as an attribute.
    expect(structured.log).toHaveBeenCalledWith('info', 'connecting to redis://***@cache:6379', {
      url: 'redis://***@cache:6379',
      count: 2,
    });
  });

  it('maps each level 1:1 and passes undefined attributes when context is absent', () => {
    const sink = fakeSink();
    const structured = fakeStructuredSink();
    const logger = createLogger('debug', 'workers', sink, structured);

    logger.error('boom');

    expect(structured.log).toHaveBeenCalledWith('error', 'boom', undefined);
  });

  it('forwards a line below the threshold to NEITHER sink (off-box volume respects log_level)', () => {
    const sink = fakeSink();
    const structured = fakeStructuredSink();
    const logger = createLogger('warn', 'backend', sink, structured);

    logger.info('below threshold — dropped');

    expect(sink.info).not.toHaveBeenCalled();
    expect(structured.log).not.toHaveBeenCalled();
  });

  it('defaults to a no-op structured sink — a logger built without one never throws (AC4)', () => {
    const sink = fakeSink();
    const logger = createLogger('debug', 'backend', sink);

    expect(() => logger.info('no structured sink injected')).not.toThrow();
    expect(sink.info).toHaveBeenCalledWith('[backend] info no structured sink injected');
  });
});

describe('redactSecrets', () => {
  it('redacts user:pass and password-only userinfo, and leaves clean text untouched', () => {
    expect(redactSecrets('postgres://user:pass@host/db')).toBe('postgres://***@host/db');
    expect(redactSecrets('redis://:onlypass@host:6379')).toBe('redis://***@host:6379');
    expect(redactSecrets('no credentials here')).toBe('no credentials here');
    // A bare host with no userinfo must not be altered.
    expect(redactSecrets('https://api.example.com/v1')).toBe('https://api.example.com/v1');
  });
});
