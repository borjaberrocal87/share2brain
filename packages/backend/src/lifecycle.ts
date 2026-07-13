// Backend graceful shutdown (Story 6.4, AC-3). Brings the backend to parity
// with the bot's (packages/bot/src/main.ts) and workers' (packages/workers/src/main.ts)
// mature bounded-drain template: stop accepting new connections, give active
// requests a bounded window to finish, then bounded redis.quit()/db.$client.end(),
// then exit. Extracted here (rather than inlined in main.ts) so it is unit
// testable with fake server/redis/db/logger/exit — mirrors those two files'
// shutdown() closures, just pulled out for DI.
import type { Logger } from '@share2brain/shared/logger';
import type { Notifier } from '@share2brain/shared/notifier';
import { flushSentry } from '@share2brain/shared/observability';

/** The subset of http.Server this module needs. */
export interface ShutdownServer {
  close(callback?: (err?: Error) => void): void;
  /** Node >=18.2 — proactively unstick idle keep-alive sockets at drain start. */
  closeIdleConnections?(): void;
  /** Node >=18.2 — force-close everything (incl. an open SSE stream) past the timeout. */
  closeAllConnections?(): void;
}

/** The subset of the Redis client this module needs. */
export interface ShutdownRedis {
  quit(): Promise<unknown>;
}

/** The subset of the Drizzle Database this module needs. */
export interface ShutdownDatabase {
  $client: { end(): Promise<void> };
}

export interface GracefulShutdownDeps {
  server: ShutdownServer;
  redis: ShutdownRedis;
  db: ShutdownDatabase;
  logger: Pick<Logger, 'info' | 'error'>;
  /**
   * Best-effort crash alert on a caught shutdown error (AC-1c, note #9). Optional
   * — omit in tests that don't care about it. `notify()` is internally bounded
   * (<=5s) and never throws, so awaiting it here can't hang the exit below.
   */
  notifier?: Pick<Notifier, 'notify'>;
  /** Active-connection drain timeout before force-closing (AC-3 default: 10s). */
  timeoutMs?: number;
  /** Injectable for tests; defaults to `process.exit`. */
  exit?: (code: number) => void;
  /**
   * Story ops-4: drain Sentry's queue before exit so the shutdown's tail logs
   * ship (background transport). Injectable for tests; defaults to the shared
   * `flushSentry`, a no-op that resolves immediately when Sentry is unarmed.
   */
  flushSentry?: () => Promise<void>;
}

const DEFAULT_SERVER_CLOSE_TIMEOUT_MS = 10_000;
const REDIS_QUIT_TIMEOUT_MS = 5_000;
const DB_END_TIMEOUT_MS = 10_000;

/**
 * A SIGTERM/SIGINT handler that also exposes whether a drain is in flight, so
 * the process-fatal handlers (uncaughtException/unhandledRejection) can skip
 * their `exit(1)` + crash-alert while a clean shutdown is already running.
 */
export interface GracefulShutdown {
  (signal: string): void;
  /** True once a SIGTERM/SIGINT drain has begun. */
  isShuttingDown(): boolean;
}

/**
 * Build a reentrancy-guarded SIGTERM/SIGINT handler. A second signal received
 * while a drain is already in flight is a no-op. Any error along the way is
 * caught and logged — never rethrown — so the process always reaches `exit(0)`.
 */
export function createGracefulShutdown(deps: GracefulShutdownDeps): GracefulShutdown {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_SERVER_CLOSE_TIMEOUT_MS;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const flush = deps.flushSentry ?? flushSentry;
  let shuttingDown = false;

  const handler = ((signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    deps.logger.info(`received ${signal}, shutting down`);

    void (async () => {
      try {
        // Unstick idle keep-alive sockets immediately; new connections are
        // already refused once close() is called. Force-close everything
        // (including a long-lived open SSE stream, note #12) if active
        // requests haven't finished within timeoutMs.
        deps.server.closeIdleConnections?.();
        await Promise.race([
          new Promise<void>((resolve, reject) => {
            deps.server.close((err) => (err ? reject(err) : resolve()));
          }),
          new Promise<void>((resolve) => {
            setTimeout(() => {
              deps.server.closeAllConnections?.();
              resolve();
            }, timeoutMs);
          }),
        ]);

        // Await quit() so any in-flight command flushes, bounded so a stuck
        // socket can't block shutdown. `.catch` neutralises a late rejection
        // that loses the race — otherwise it surfaces as an unhandledRejection.
        await Promise.race([
          deps.redis
            .quit()
            .then(() => undefined)
            .catch(() => undefined),
          new Promise<void>((resolve) => setTimeout(resolve, REDIS_QUIT_TIMEOUT_MS)),
        ]);

        // pg's Pool.end() takes no timeout arg; bound it so a stuck pool can't
        // block shutdown past its own window (the outer finally still exits).
        await Promise.race([
          deps.db.$client.end().catch(() => undefined),
          new Promise<void>((resolve) => setTimeout(resolve, DB_END_TIMEOUT_MS)),
        ]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.logger.error('error during shutdown', { reason: message });
        await deps.notifier?.notify({
          service: 'backend',
          message,
          timestamp: new Date().toISOString(),
        });
      } finally {
        // Story ops-4: drain Sentry's queue so the shutdown's tail logs ship
        // before exit (background transport; a no-op when Sentry is unarmed).
        await flush();
        exit(0);
      }
    })();
  }) as GracefulShutdown;

  handler.isShuttingDown = (): boolean => shuttingDown;
  return handler;
}
