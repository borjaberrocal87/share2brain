import { describe, expect, it, vi } from 'vitest';

import { createLogger, redactSecrets } from './logger.js';

type SinkMethod = (...args: unknown[]) => void;

function fakeSink(): Record<'debug' | 'info' | 'warn' | 'error', ReturnType<typeof vi.fn<SinkMethod>>> {
  return {
    debug: vi.fn<SinkMethod>(),
    info: vi.fn<SinkMethod>(),
    warn: vi.fn<SinkMethod>(),
    error: vi.fn<SinkMethod>(),
  };
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

describe('redactSecrets', () => {
  it('redacts user:pass and password-only userinfo, and leaves clean text untouched', () => {
    expect(redactSecrets('postgres://user:pass@host/db')).toBe('postgres://***@host/db');
    expect(redactSecrets('redis://:onlypass@host:6379')).toBe('redis://***@host:6379');
    expect(redactSecrets('no credentials here')).toBe('no credentials here');
    // A bare host with no userinfo must not be altered.
    expect(redactSecrets('https://api.example.com/v1')).toBe('https://api.example.com/v1');
  });
});
