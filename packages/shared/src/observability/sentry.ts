// Sentry ADAPTER for the Observability port (Story ops-4 shipped Sentry; ops-5
// folded it behind the `Observability` interface). `@sentry/node` lives ONLY in
// this file (AD-2, tightened): the three services depend on the vendor-neutral
// port from `./observability.js`, never on `@sentry/node` and never on each
// other. Obtained via `createSentryObservability` — itself only reached through
// `createObservability` in `./index.js`.
//
// SECURITY: an error event or a log line must NEVER carry a secret (a DB/Redis
// connection URL's `user:pass@` userinfo, a token) or Discord message `content`.
// `beforeSend`/`beforeSendLog` run every outbound payload through the shared
// `redactSecrets` and DROP any `content` key. We never enable `sendDefaultPii`;
// the only identity attached is an internal user id + role ids (backend
// middleware) — never a real Discord identity, message, or header.
import * as Sentry from '@sentry/node';
import type { ErrorEvent } from '@sentry/node';

import { redactSecrets, type LogLevel } from '../logger.js';
import type { Observability } from './observability.js';

// `@sentry/node` re-exports the error `ErrorEvent` type but NOT the structured-log
// `Log` type (it lives in @sentry/core, a transitive dep we must not import from
// directly — AD-2 keeps the Sentry surface to `@sentry/node` only). Derive it from
// the `beforeSendLog` hook signature on the init options so we track the SDK's own
// definition without naming a second package.
type SentryInitOptions = NonNullable<Parameters<typeof Sentry.init>[0]>;
type Log = Parameters<NonNullable<SentryInitOptions['beforeSendLog']>>[0];

/** Only plain objects (and arrays, handled separately) are safe to rebuild via `Object.entries`. */
function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * Deep-scrub a value tree for Sentry egress: run every string through
 * `redactSecrets` and DROP any `content` key at ANY depth (never forward Discord
 * message content). Recurses into nested plain objects and arrays — a shallow,
 * top-level-only scrub would let a secret one level deep
 * (`{ detail: { url: 'redis://u:p@h' }}`) or a nested `content` ride out unredacted.
 *
 * Non-plain objects (Date, Map, Set, Buffer, Error, class instances) are passed
 * through unchanged: `Object.entries` would mangle them into `{}` and lose the
 * diagnostic value the story exists to deliver. The `seen` guard is scoped to the
 * CURRENT recursion path (added before recursing, removed after) so it drops a
 * genuine cycle without also dropping a shared, non-circular reference that appears
 * on two sibling branches (a DAG) — and so it can never throw inside a Sentry hook.
 */
function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (value === null || typeof value !== 'object') return value;
  if (!Array.isArray(value) && !isPlainObject(value)) return value;
  if (seen.has(value)) return undefined; // true cycle on the current path — drop
  seen.add(value);
  let out: unknown;
  if (Array.isArray(value)) {
    out = value.map((item) => redactValue(item, seen));
  } else {
    const obj: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'content') continue; // never forward Discord message content
      obj[key] = redactValue(nested, seen);
    }
    out = obj;
  }
  seen.delete(value); // leave the path so a DAG sibling reference is not mistaken for a cycle
  return out;
}

/** Deep-redact a Sentry attribute/extra bag: drops `content`, scrubs secrets at any depth. */
function redactAttributes(attrs: Record<string, unknown>): Record<string, unknown> {
  return redactValue(attrs, new WeakSet()) as Record<string, unknown>;
}

/**
 * Sentry `beforeSend` hook (AC6). Runs the error message and each exception
 * value / stack-frame local through the shared `redactSecrets` — a pg/redis
 * driver error can interpolate a whole DATABASE_URL/REDIS_URL (password
 * included) into `error.message`/`.stack` (AUDIT M2) — and strips any `content`
 * key from `extra` so Discord message content can never ride out on an event.
 * Also scrubs auto-captured data the shared logger never touched — default
 * console/http breadcrumbs and the request URL/query/headers/body can each carry
 * a credentialed URL that bypasses the logger's redaction path.
 *
 * Module-private (ops-5): reached only through the adapter's `Sentry.init`
 * options; the adapter test drives it via the captured init opts, not a free
 * import (AC6).
 */
function beforeSend(event: ErrorEvent): ErrorEvent {
  if (event.message) event.message = redactSecrets(event.message);
  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = redactSecrets(exception.value);
    for (const frame of exception.stacktrace?.frames ?? []) {
      if (frame.vars) frame.vars = redactAttributes(frame.vars);
    }
  }
  if (event.extra) event.extra = redactAttributes(event.extra);
  // Auto-captured breadcrumbs (console/http integrations) — message + data.
  for (const crumb of event.breadcrumbs ?? []) {
    if (crumb.message) crumb.message = redactSecrets(crumb.message);
    if (crumb.data) crumb.data = redactAttributes(crumb.data);
  }
  // Request context — a credentialed URL can appear in the URL, query string,
  // headers, or body. Headers/query-string may be structured; scrub each shape.
  const request = event.request;
  if (request) {
    if (request.url) request.url = redactSecrets(request.url);
    if (typeof request.query_string === 'string') {
      request.query_string = redactSecrets(request.query_string);
    }
    if (request.headers) {
      for (const key of Object.keys(request.headers)) {
        request.headers[key] = redactSecrets(request.headers[key]);
      }
    }
    if (typeof request.data === 'string') {
      request.data = redactSecrets(request.data);
    } else if (request.data && typeof request.data === 'object') {
      request.data = redactAttributes(request.data as Record<string, unknown>);
    }
  }
  return event;
}

/**
 * Build the Sentry `beforeSendLog` hook (AC5, AC6) for one service. Redacts the
 * log message and every string attribute value, DROPS any `content` attribute
 * (never forward Discord message content), and stamps the `service` so each log
 * is attributable to its process in Sentry. The service is closure state (ops-5)
 * — the former module-level `taggedService` mutable global is gone (AC5). Error
 * events inherit the service via `Sentry.setTag`; structured logs don't inherit
 * scope tags, so this stamps it as an attribute instead.
 */
function makeBeforeSendLog(service: string): (log: Log) => Log {
  return (log: Log): Log => {
    log.message = redactSecrets(log.message);
    log.attributes = {
      ...redactAttributes(log.attributes ?? {}),
      service,
    };
    return log;
  };
}

/**
 * Run an observability side-effect that must NEVER throw into the caller — the
 * port's contract (mirrors `Notifier`'s "never throws or rejects"). Matters most
 * for `captureException`, the FIRST statement in every service's fatal
 * `uncaughtException`/`unhandledRejection` handler: an SDK throw there (e.g. a
 * line logged after a prior `flush()`→`Sentry.close()` disarmed the client, or
 * an internal SDK fault) would escape before `notify`/`flush`/`process.exit(1)`
 * run and could wedge the exit — exactly as `flush()` already swallows a
 * rejecting `close()`. A fault in a port METHOD must never mask the error we are
 * reporting or recurse (the logger's own sink forwards back into this very
 * method, so the catch must not log through it). This covers the port's runtime
 * surface only — `Sentry.init`/`setTag` in the constructor are deliberately left
 * unguarded: `loadConfig` already Zod-validated the DSN as a URL, so an init
 * fault is a genuine boot-time misconfiguration that SHOULD fail loud (AD-8),
 * not silently produce a half-armed adapter.
 *
 * Hot-path / crash-path calls (`captureException`, `setUser`, `logSink.log`)
 * swallow silently — surfacing them would spam or recurse. A once-per-boot wiring
 * call (`setupExpressErrorHandler`) passes `onErrorLabel`: it still degrades
 * rather than crash (observability must never block boot), but emits a one-line
 * `console.error` — like `redis.ts`/`db/index.ts` do — so the operator knows the
 * 5xx capture handler was not wired instead of the failure vanishing.
 */
function guard(fn: () => void, onErrorLabel?: string): void {
  try {
    fn();
  } catch (err: unknown) {
    if (onErrorLabel !== undefined) {
      // Redact: an SDK error string can interpolate the DSN or a connection URL.
      console.error(
        `[observability] ${onErrorLabel} failed (degraded):`,
        redactSecrets(err instanceof Error ? err.message : String(err)),
      );
    }
    // Otherwise best-effort: never let observability throw into the app.
  }
}

/**
 * Build the Sentry adapter for the Observability port. Called (indirectly, via
 * `createObservability`) once per process in `main.ts`, immediately after
 * `loadConfig()` and before any network I/O (AD-8). `Sentry.init` runs here in
 * the constructor — the caller guarantees a non-empty, valid DSN (S-5 empty-DSN
 * routing to the Noop happens in `createObservability`; `loadConfig`'s Zod refine
 * already rejects a non-empty non-URL DSN), so this never defends against a
 * malformed one. Behavior is identical to ops-4's `initSentry`, just packaged as
 * an object implementing the vendor-neutral port.
 */
export function createSentryObservability(opts: { dsn: string; service: string }): Observability {
  const { dsn, service } = opts;
  Sentry.init({
    dsn,
    // Structured Logs are GA in @sentry/node ≥9.41 — the TOP-LEVEL flag, not the
    // old `_experiments.enableLogs`. Log volume is gated upstream by the shared
    // logger's `observability.log_level` threshold.
    enableLogs: true,
    environment: process.env.NODE_ENV ?? 'production',
    beforeSend,
    beforeSendLog: makeBeforeSendLog(service),
  });
  // AC5: tag every error event with the emitting service (backend | bot |
  // workers). Set on the global scope; logs are stamped in beforeSendLog above.
  Sentry.setTag('service', service);

  return {
    // Capture an error object with its stack (AC6, NFR13). Guarded so a broken
    // SDK can never throw out of a fatal handler that calls this first.
    captureException: (error: unknown): void => {
      guard(() => Sentry.captureException(error));
    },
    // Attach the authenticated user's context (AC8, NFR13): internal user id +
    // Discord role ids ONLY — never the snowflake, content, email, or IP
    // (`sendDefaultPii` stays off).
    setUser: (user: { id: string; roles: string[] }): void => {
      guard(() => Sentry.setUser({ id: user.id, roles: user.roles }));
    },
    // Register Sentry's Express error handler (AC8). It observes unhandled errors
    // / HTTP 5xx and calls `next(err)`, so the existing `{ error, code }` mapper
    // still owns the client-facing response. The port widens `app` to `unknown`;
    // narrow it back to Sentry's own signature here so `shared` needs no express
    // dependency.
    setupExpressErrorHandler: (app: unknown): void => {
      guard(
        () =>
          Sentry.setupExpressErrorHandler(
            app as Parameters<typeof Sentry.setupExpressErrorHandler>[0],
          ),
        'setupExpressErrorHandler',
      );
    },
    // Flush the transport queue, then resolve (AC6 / AC11 delivery). Sentry sends
    // events + Structured Logs on a background queue; a fatal handler that calls
    // captureException then process.exit(1) would abandon it before it drains.
    // `Sentry.close(timeout)` flushes then disables the client; bounded so a
    // Sentry outage can't wedge shutdown, and swallowing errors so observability
    // teardown never masks the fatal error we are exiting on.
    flush: async (timeoutMs = 2000): Promise<void> => {
      try {
        await Sentry.close(timeoutMs);
      } catch {
        // Never let observability teardown mask the fatal error we are exiting on.
      }
    },
    // The structured-log sink the shared logger forwards each line to. Maps
    // 1:1 onto `Sentry.logger[level]` with the redacted message + attributes.
    // Guarded: this runs on the hot logging path (every line ≥ threshold) and
    // must never turn a `logger.info(...)` call into a throw.
    logSink: {
      log: (level: LogLevel, message: string, attributes?: Record<string, unknown>): void => {
        guard(() => Sentry.logger[level](message, attributes));
      },
    },
  };
}
