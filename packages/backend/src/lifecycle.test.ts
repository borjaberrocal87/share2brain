import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGracefulShutdown, type ShutdownDatabase, type ShutdownRedis, type ShutdownServer } from './lifecycle.js';

type LoggerMethod = (message: string, context?: Record<string, unknown>) => void;

function fakeLogger(): { info: ReturnType<typeof vi.fn<LoggerMethod>>; error: ReturnType<typeof vi.fn<LoggerMethod>> } {
  return { info: vi.fn<LoggerMethod>(), error: vi.fn<LoggerMethod>() };
}

describe('createGracefulShutdown', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('closes the server, quits redis, ends the db pool, then exits(0) on the clean path', async () => {
    const calls: string[] = [];
    const server: ShutdownServer = {
      close: (cb) => {
        calls.push('server.close');
        cb?.();
      },
    };
    const redis: ShutdownRedis = { quit: async () => (calls.push('redis.quit'), 'OK') };
    const db: ShutdownDatabase = { $client: { end: async () => void calls.push('db.end') } };
    const logger = fakeLogger();
    const exit = vi.fn();
    const shutdown = createGracefulShutdown({ server, redis, db, logger, exit });

    shutdown('SIGTERM');

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));

    expect(calls).toEqual(['server.close', 'redis.quit', 'db.end']);
    expect(logger.info).toHaveBeenCalledWith('received SIGTERM, shutting down');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('flushes Sentry after the drain and before exit(0), so shutdown tail logs ship (ops-4)', async () => {
    const calls: string[] = [];
    const server: ShutdownServer = { close: (cb) => (calls.push('server.close'), cb?.()) };
    const redis: ShutdownRedis = { quit: async () => (calls.push('redis.quit'), 'OK') };
    const db: ShutdownDatabase = { $client: { end: async () => void calls.push('db.end') } };
    const logger = fakeLogger();
    const flushSentry = vi.fn(async () => void calls.push('flushSentry'));
    const exit = vi.fn(() => void calls.push('exit'));
    const shutdown = createGracefulShutdown({ server, redis, db, logger, exit, flushSentry });

    shutdown('SIGTERM');

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));

    expect(flushSentry).toHaveBeenCalledTimes(1);
    // Flush drains AFTER the connection drain and immediately BEFORE exit.
    expect(calls).toEqual(['server.close', 'redis.quit', 'db.end', 'flushSentry', 'exit']);
  });

  it('force-closes remaining connections when the server does not close within timeoutMs', async () => {
    vi.useFakeTimers();
    const closeAllConnections = vi.fn();
    const closeIdleConnections = vi.fn();
    const server: ShutdownServer = {
      close: () => {
        /* never calls back — simulates an open in-flight (e.g. SSE) connection */
      },
      closeIdleConnections,
      closeAllConnections,
    };
    const redis: ShutdownRedis = { quit: async () => 'OK' };
    const db: ShutdownDatabase = { $client: { end: async () => undefined } };
    const logger = fakeLogger();
    const exit = vi.fn();
    const shutdown = createGracefulShutdown({ server, redis, db, logger, exit, timeoutMs: 1_000 });

    shutdown('SIGTERM');
    expect(closeIdleConnections).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0), { timeout: 5_000 });

    expect(closeAllConnections).toHaveBeenCalledTimes(1);
  });

  it('bounds a hanging redis.quit() and still reaches db.end() and exit', async () => {
    vi.useFakeTimers();
    const server: ShutdownServer = { close: (cb) => cb?.() };
    const dbEnd = vi.fn().mockResolvedValue(undefined);
    const redis: ShutdownRedis = { quit: () => new Promise(() => {}) };
    const db: ShutdownDatabase = { $client: { end: dbEnd } };
    const logger = fakeLogger();
    const exit = vi.fn();
    const shutdown = createGracefulShutdown({ server, redis, db, logger, exit });

    shutdown('SIGTERM');

    await vi.advanceTimersByTimeAsync(5_000); // REDIS_QUIT_TIMEOUT_MS
    await vi.waitFor(() => expect(dbEnd).toHaveBeenCalled(), { timeout: 5_000 });

    await vi.advanceTimersByTimeAsync(10_000); // DB_END_TIMEOUT_MS ceiling (already resolved)
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0), { timeout: 5_000 });
  });

  it('bounds a hanging db.$client.end() and still exits', async () => {
    vi.useFakeTimers();
    const server: ShutdownServer = { close: (cb) => cb?.() };
    const redis: ShutdownRedis = { quit: async () => 'OK' };
    const db: ShutdownDatabase = { $client: { end: () => new Promise(() => {}) } };
    const logger = fakeLogger();
    const exit = vi.fn();
    const shutdown = createGracefulShutdown({ server, redis, db, logger, exit });

    shutdown('SIGTERM');

    await vi.advanceTimersByTimeAsync(10_000); // DB_END_TIMEOUT_MS
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0), { timeout: 5_000 });
  });

  it('is reentrancy-guarded — a second signal while a drain is in flight is a no-op', async () => {
    const closeSpy = vi.fn((cb?: (err?: Error) => void) => cb?.());
    const server: ShutdownServer = { close: closeSpy };
    const redis: ShutdownRedis = { quit: async () => 'OK' };
    const db: ShutdownDatabase = { $client: { end: async () => undefined } };
    const logger = fakeLogger();
    const exit = vi.fn();
    const shutdown = createGracefulShutdown({ server, redis, db, logger, exit });

    shutdown('SIGTERM');
    shutdown('SIGINT');

    await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1));

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it('catches and logs a thrown server.close error instead of rethrowing, and still exits', async () => {
    const server: ShutdownServer = {
      close: (cb) => cb?.(new Error('close failed')),
    };
    const redis: ShutdownRedis = { quit: async () => 'OK' };
    const db: ShutdownDatabase = { $client: { end: async () => undefined } };
    const logger = fakeLogger();
    const exit = vi.fn();
    const shutdown = createGracefulShutdown({ server, redis, db, logger, exit });

    expect(() => shutdown('SIGTERM')).not.toThrow();

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));

    expect(logger.error).toHaveBeenCalledWith('error during shutdown', { reason: 'close failed' });
  });

  it('best-effort notifies on a caught shutdown error without blocking the exit', async () => {
    const server: ShutdownServer = { close: (cb) => cb?.(new Error('close failed')) };
    const redis: ShutdownRedis = { quit: async () => 'OK' };
    const db: ShutdownDatabase = { $client: { end: async () => undefined } };
    const logger = fakeLogger();
    const exit = vi.fn();
    const notify = vi.fn().mockResolvedValue(undefined);
    const shutdown = createGracefulShutdown({ server, redis, db, logger, exit, notifier: { notify } });

    shutdown('SIGTERM');

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ service: 'backend', message: 'close failed' }),
    );
  });

  it('exposes isShuttingDown() — false before a signal, true once a drain has begun', async () => {
    const server: ShutdownServer = { close: (cb) => cb?.() };
    const redis: ShutdownRedis = { quit: async () => 'OK' };
    const db: ShutdownDatabase = { $client: { end: async () => undefined } };
    const logger = fakeLogger();
    const exit = vi.fn();
    const shutdown = createGracefulShutdown({ server, redis, db, logger, exit });

    expect(shutdown.isShuttingDown()).toBe(false);

    shutdown('SIGTERM');

    expect(shutdown.isShuttingDown()).toBe(true);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(shutdown.isShuttingDown()).toBe(true);
  });

  it('does not call a notifier on the clean (no-error) path', async () => {
    const server: ShutdownServer = { close: (cb) => cb?.() };
    const redis: ShutdownRedis = { quit: async () => 'OK' };
    const db: ShutdownDatabase = { $client: { end: async () => undefined } };
    const logger = fakeLogger();
    const exit = vi.fn();
    const notify = vi.fn().mockResolvedValue(undefined);
    const shutdown = createGracefulShutdown({ server, redis, db, logger, exit, notifier: { notify } });

    shutdown('SIGTERM');

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));

    expect(notify).not.toHaveBeenCalled();
  });
});
