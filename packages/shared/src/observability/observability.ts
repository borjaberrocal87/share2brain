// Vendor-neutral Observability PORT (Story ops-5). Mirrors the `Notifier` port
// in `../notifier/index.ts`: an interface the three services depend on, with
// concrete adapters (Sentry today) hidden behind the `createObservability`
// factory in `./index.ts`. No vendor name appears in this type or its members —
// that is the whole point of the refactor (DIP / Open–Closed): a second provider
// is a new adapter file + one factory branch + one config value, with ZERO edits
// to `backend`/`bot`/`workers`/`web`.
import { NOOP_STRUCTURED_SINK, type StructuredLogSink } from '../logger.js';

/** The providers `createObservability` can select (AC10). Grows by one literal
 *  per new adapter; kept in sync with the `observability.provider` Zod enum in
 *  `../config/index.ts`. */
export type ObservabilityProvider = 'sentry';

/**
 * The observability seam consumed by every service. An adapter captures errors,
 * attaches the authenticated user, wires the HTTP error handler, drains its
 * transport on shutdown, and exposes a `logSink` the shared logger forwards each
 * line to. `setupExpressErrorHandler` takes `unknown` so no `express` (or vendor)
 * type leaks into the port — the adapter narrows it internally.
 *
 * CONTRACT (mirrors `Notifier`): observability is best-effort — NO method throws
 * and `flush` never rejects. `captureException` in particular is called first in
 * the services' fatal handlers, so an adapter that let the vendor SDK throw could
 * wedge the exit; every adapter must swallow its own faults (the Noop trivially
 * does; the Sentry adapter guards each call). Callers never need a try/catch.
 */
export interface Observability {
  captureException(error: unknown): void;
  setUser(user: { id: string; roles: string[] }): void;
  setupExpressErrorHandler(app: unknown): void;
  flush(timeoutMs?: number): Promise<void>;
  logSink: StructuredLogSink;
}

/**
 * Shared no-op adapter — the S-5 empty-DSN behavior (mirrors `NOOP_NOTIFIER`).
 * Every method is a safe no-op, `flush()` resolves immediately, and `logSink`
 * drops every line, so a service booted without a DSN behaves exactly as it did
 * before any observability existed.
 */
export const NoopObservability: Observability = {
  captureException: () => undefined,
  setUser: () => undefined,
  setupExpressErrorHandler: () => undefined,
  flush: async () => undefined,
  logSink: NOOP_STRUCTURED_SINK,
};
