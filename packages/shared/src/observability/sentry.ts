// Shared Sentry integration (Story ops-4). `@sentry/node` lives ONLY in this
// package (AD-2); the three services inherit it transitively via
// `@share2brain/shared` and each calls `initSentry(dsn, service)` once in its
// `main.ts` right after `loadConfig()` (AD-8), before any network I/O.
//
// SECURITY: an error event or a log line must NEVER carry a secret (a DB/Redis
// connection URL's `user:pass@` userinfo, a token) or Discord message `content`.
// `beforeSend`/`beforeSendLog` run every outbound payload through the shared
// `redactSecrets` and DROP any `content` key. We never enable `sendDefaultPii`;
// the only identity attached is an internal user id + role ids (backend
// middleware) — never a real Discord identity, message, or header.
import * as Sentry from '@sentry/node';
import type { ErrorEvent } from '@sentry/node';

import { redactSecrets } from '../logger.js';

// `@sentry/node` re-exports the error `ErrorEvent` type but NOT the structured-log
// `Log` type (it lives in @sentry/core, a transitive dep we must not import from
// directly — AD-2 keeps the Sentry surface to `@sentry/node` only). Derive it from
// the `beforeSendLog` hook signature on the init options so we track the SDK's own
// definition without naming a second package.
type SentryInitOptions = NonNullable<Parameters<typeof Sentry.init>[0]>;
type Log = Parameters<NonNullable<SentryInitOptions['beforeSendLog']>>[0];

// The `service` value stamped on every log, set once by initSentry. A single
// process only ever hosts one service (bot | backend | workers), so a
// module-level value is safe. Error events are tagged via `Sentry.setTag`
// (global scope); structured logs don't inherit scope tags, so beforeSendLog
// stamps the service as a log attribute instead.
let taggedService: string | undefined;

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
 * Sentry `beforeSend` hook (AC8). Runs the error message and each exception
 * value / stack-frame local through the shared `redactSecrets` — a pg/redis
 * driver error can interpolate a whole DATABASE_URL/REDIS_URL (password
 * included) into `error.message`/`.stack` (AUDIT M2) — and strips any `content`
 * key from `extra` so Discord message content can never ride out on an event.
 * Also scrubs auto-captured data the shared logger never touched — default
 * console/http breadcrumbs and the request URL/query/headers/body can each carry
 * a credentialed URL that bypasses the logger's redaction path.
 */
export function beforeSend(event: ErrorEvent): ErrorEvent {
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
 * Sentry `beforeSendLog` hook (AC5, AC8). Redacts the log message and every
 * string attribute value, DROPS any `content` attribute (never forward Discord
 * message content), and stamps the `service` so each log is attributable to its
 * process in Sentry.
 */
export function beforeSendLog(log: Log): Log {
  log.message = redactSecrets(log.message);
  log.attributes = {
    ...redactAttributes(log.attributes ?? {}),
    ...(taggedService ? { service: taggedService } : {}),
  };
  return log;
}

/**
 * Arm Sentry for one service. Called once per process in `main.ts`, immediately
 * after `loadConfig()` and before any network I/O (AD-8).
 *
 * S-5: an empty `dsn` disables Sentry entirely — a genuine no-op (`Sentry.init`
 * is never called), so a service with `SENTRY_DSN` unset behaves exactly as it
 * did before this story. `loadConfig`'s Zod refine already guarantees a
 * non-empty DSN is a valid URL, so init never has to defend against a malformed
 * one.
 */
export function initSentry(dsn: string, service: string): void {
  if (dsn === '') return;
  taggedService = service;
  Sentry.init({
    dsn,
    // Structured Logs are GA in @sentry/node ≥9.41 — the TOP-LEVEL flag, not the
    // old `_experiments.enableLogs`. Log volume is gated upstream by the shared
    // logger's `observability.log_level` threshold.
    enableLogs: true,
    environment: process.env.NODE_ENV ?? 'production',
    beforeSend,
    beforeSendLog,
  });
  // AC4: tag every error event with the emitting service (backend | bot |
  // workers). Set on the global scope; logs are stamped in beforeSendLog above.
  Sentry.setTag('service', service);
}

/**
 * Capture an error object with its stack (AC6, NFR13). Thin wrapper so services
 * import ONLY `@share2brain/shared/observability` — the single Sentry integration
 * point (AC2), never `@sentry/node` directly. A no-op until initSentry has armed
 * the client (or when the DSN is empty), so it is safe to call unconditionally.
 */
export function captureException(error: unknown): void {
  Sentry.captureException(error);
}

/**
 * Flush the Sentry transport queue, then resolve (AC6 / AC11 delivery). Sentry
 * sends events and Structured Logs on a background queue; a fatal handler that
 * calls `captureException` and then `process.exit(1)` would abandon that queue
 * before it drains — the very errors the operator relies on Sentry for never
 * arrive (acute when crash notifications are disabled, the default, so the
 * `notify()` promise resolves instantly and exit fires with no delay). Call this
 * before a hard exit. `Sentry.close(timeout)` flushes then disables the client;
 * bounded by `timeoutMs` so a Sentry outage can't wedge shutdown. A safe no-op
 * that resolves ~immediately when Sentry was never armed / the DSN is empty.
 */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  try {
    await Sentry.close(timeoutMs);
  } catch {
    // Never let observability teardown mask the fatal error we are exiting on.
  }
}

/**
 * Attach the authenticated user's context to the current Sentry scope (AC7,
 * NFR13): the internal user id + Discord role ids ONLY — never the Discord
 * snowflake, message content, email, or IP (`sendDefaultPii` stays off). Called
 * by the backend's post-auth middleware.
 */
export function setSentryUser(user: { id: string; roles: string[] }): void {
  Sentry.setUser({ id: user.id, roles: user.roles });
}

/**
 * Register Sentry's Express error handler on the app (AC7). It observes unhandled
 * errors / HTTP 5xx and calls `next(err)`, so the existing `{ error, code }`
 * mapper still owns the client-facing response shape. The param type is derived
 * from Sentry's own signature so `shared` needs no express dependency. A no-op
 * middleware (capture only) until the client is armed.
 */
export function setupSentryErrorHandler(
  app: Parameters<typeof Sentry.setupExpressErrorHandler>[0],
): void {
  Sentry.setupExpressErrorHandler(app);
}
