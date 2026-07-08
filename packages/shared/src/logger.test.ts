import { describe, expect, it, vi } from 'vitest';

import { createLogger } from './logger.js';

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
});
