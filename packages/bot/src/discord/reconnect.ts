// Gateway reconnection with exponential backoff (AC-4).
//
// discord.js auto-reconnects transient WebSocket drops on its own. This module is
// the recovery path for a FAILED login() — an invalid session or a sustained
// outage at boot — where we retry indefinitely with backoff rather than exiting.
//
// Timing math (computeDelay) is a pure function so it unit-tests without timers;
// the scheduler (connectWithRetry) takes an injectable `sleep` so tests can drive
// it with fake timers and assert the delay sequence and the reset-on-success.
import { Client, Events } from 'discord.js';

import type { Logger } from '../logger.js';

const INITIAL_DELAY_MS = 1_000;
const MAX_DELAY_MS = 300_000; // 5 min cap
const ESCALATE_AFTER = 5; // consecutive failures before the log level rises to error

/**
 * Exponential backoff with ±10% jitter, capped at MAX_DELAY_MS. `attempt` starts
 * at 1 → ~1s, 2 → ~2s, 3 → ~4s … capped at ~300s. Jitter spreads reconnect storms.
 */
export function computeDelay(attempt: number): number {
  const base = Math.min(INITIAL_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
  const jitter = base * (Math.random() * 0.2 - 0.1); // ±10%
  return Math.round(base + jitter);
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Await `wait`, but resolve immediately if `signal` aborts first — so a mid-backoff
 * SIGTERM isn't stuck for up to MAX_DELAY_MS. Without a signal it just awaits `wait`.
 */
function waitOrAbort(wait: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return wait;
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onAbort = (): void => resolve();
    signal.addEventListener('abort', onAbort, { once: true });
    const done = (): void => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    // Resolve on either settle: a rejecting `sleep` must not stall the loop or leak an
    // unhandledRejection — the retry loop re-checks `signal.aborted` / re-runs login().
    void wait.then(done, done);
  });
}

export interface ConnectWithRetryDeps {
  /** Performs the actual login (e.g. () => client.login(token)). */
  login: () => Promise<unknown>;
  logger: Logger;
  /** Injectable delay, defaults to setTimeout — tests pass a fake to control timing. */
  sleep?: (ms: number) => Promise<void>;
  /** Aborts the retry loop on shutdown so a mid-backoff SIGTERM doesn't hang. */
  signal?: AbortSignal;
}

/**
 * Drive login() with exponential backoff until it resolves. Retries indefinitely;
 * after ESCALATE_AFTER consecutive failures the log level rises to error (the
 * Operator investigates — the container is NOT killed). Returns on success; a
 * fresh invocation starts the backoff over at ~1s, which IS the reset (AC-4.4).
 * If `signal` aborts (shutdown), the loop stops rather than retrying forever.
 */
export async function connectWithRetry({
  login,
  logger,
  sleep = defaultSleep,
  signal,
}: ConnectWithRetryDeps): Promise<void> {
  let attempt = 0;
  for (;;) {
    if (signal?.aborted) return;
    try {
      await login();
      return;
    } catch (error) {
      if (signal?.aborted) return;
      attempt += 1;
      const delay = computeDelay(attempt);
      const reason = error instanceof Error ? error.message : String(error);
      const line = `Gateway login failed (attempt ${attempt}), retrying in ${Math.round(delay / 1000)}s`;
      if (attempt >= ESCALATE_AFTER) {
        logger.error(`${line} — still retrying`, { attempt, reason });
      } else {
        logger.warn(line, { attempt, reason });
      }
      // Abortable so a shutdown mid-backoff exits promptly; the loop-top check returns.
      await waitOrAbort(sleep(delay), signal);
    }
  }
}

/**
 * Bind Gateway drop/error events to warn-level logs (AC-4.1/4.2). Registering the
 * `error` listener also guarantees the process does not crash on a shard error
 * (an unhandled 'error' event would otherwise throw). discord.js reconnects
 * transient drops itself, so these are observability, not a recovery trigger.
 */
export function bindGatewayEvents(client: Client, logger: Logger): void {
  client.on(Events.ShardDisconnect, (event, shardId) => {
    logger.warn('Gateway shard disconnected', { shardId, code: event.code });
  });
  client.on(Events.ShardError, (error, shardId) => {
    logger.warn('Gateway shard error', { shardId, reason: error.message });
  });
  client.on(Events.Error, (error) => {
    logger.warn('Discord client error', { reason: error.message });
  });
}
