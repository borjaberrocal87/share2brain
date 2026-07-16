// Canonical structured logger, shared by all three services (AD-2). Promoted
// from the byte-identical packages/bot/src/logger.ts and
// packages/workers/src/logger.ts (Story 6.4, DECISION 3); Story ops-4 finished
// the consolidation — bot/workers now call THIS logger too, their local copies
// deleted. It honors the operator's `observability.log_level` and emits
// `[${service}] <level> <msg> <ctx-json>` to stdout.
//
// DUAL SINK: every line at or above the threshold is ALSO forwarded to an
// injected `StructuredLogSink` (Story ops-4 shipped this; Story ops-5 made it
// vendor-neutral). The sink is the Observability port's `logSink` — a Sentry
// adapter forwards to Sentry Structured Logs; the empty-DSN Noop drops the line.
// The default sink is a no-op, so a logger built without one adds nothing. The
// SAME `redactSecrets` output that guards stdout is what is forwarded — a secret
// never reaches either sink. This module MUST NOT import any vendor SDK (AC4) nor
// anything from `observability/` — the dependency direction is observability →
// logger (the adapter imports `redactSecrets`/`StructuredLogSink` from here).
//
// SECURITY: callers must never pass secrets (tokens, DATABASE_URL, REDIS_URL,
// API keys) or full message `content` in the context object — log
// `content.length`, counts, or ids instead (see project-context §anti-patterns).

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Severity ordering: a message is emitted only if its level >= the configured level. */
const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

/**
 * Redact the `user:pass@` userinfo of any `scheme://…@host` authority in a log
 * line. AUDIT M2: some pg/redis driver errors interpolate the whole connection
 * URL — DATABASE_URL / REDIS_URL, password included — into `error.message` /
 * `.stack`; logging that error raw would leak the credential to stdout. The
 * outbound crash-notifier already sanitizes exactly this (and now reuses this
 * function), but the always-run local logging paths did not — every logger's
 * `emit` now runs its output through this. Defined here so the notifier and all
 * three service loggers share ONE implementation.
 */
export function redactSecrets(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]*@/gi, '$1***@');
}

/** The console-like sink the logger writes to (injectable so unit tests can capture output). */
export interface LogSink {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/**
 * Vendor-neutral structured-log sink (Story ops-5). The logger forwards every
 * line at/above the threshold to `log(level, message, attributes)` — the SAME
 * redacted output already written to stdout. Defined HERE (not in
 * `observability/`) so the dependency direction stays observability → logger:
 * the Sentry adapter implements this and maps it onto `Sentry.logger[level]`.
 */
export interface StructuredLogSink {
  log(level: LogLevel, message: string, attributes?: Record<string, unknown>): void;
}

/** Drops every line — the default sink and the empty-DSN (S-5) behavior. */
export const NOOP_STRUCTURED_SINK: StructuredLogSink = { log: () => undefined };

/**
 * Create a logger gated at `level`, prefixed with `service`. Levels below the
 * threshold are dropped. `sink` defaults to the global console; tests inject a
 * fake to assert output. `structuredSink` defaults to a no-op; `main.ts` passes
 * the Observability port's `logSink` so lines are also forwarded off-box.
 */
export function createLogger(
  level: LogLevel,
  service: string,
  sink: LogSink = console,
  structuredSink: StructuredLogSink = NOOP_STRUCTURED_SINK,
): Logger {
  const threshold = LEVEL_ORDER[level];

  const emit = (msgLevel: LogLevel, message: string, context?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[msgLevel] < threshold) return;
    // Redact ONCE and feed the same scrubbed output to both sinks (AC5): stdout
    // (unchanged) and the structured sink. Below-threshold lines return above, so
    // they reach neither sink — the off-box log volume respects `log_level`.
    const redactedMessage = redactSecrets(message);
    const prefix = `[${service}] ${msgLevel} ${redactedMessage}`;
    const hasContext = context !== undefined && Object.keys(context).length > 0;
    // The console path serializes+redacts the context to a trailing JSON string;
    // round-trip that exact redacted JSON back to an object for the structured
    // sink's attributes, so both sinks carry byte-identical redaction (no raw
    // context object ever leaves this function).
    const redactedContextJson = hasContext ? redactSecrets(JSON.stringify(context)) : undefined;

    if (redactedContextJson !== undefined) {
      sink[msgLevel](prefix, redactedContextJson);
    } else {
      sink[msgLevel](prefix);
    }

    // Structured-log sink (Story ops-4, vendor-neutral since ops-5). A no-op by
    // default; the Sentry adapter maps `log(level, msg, attrs)` 1:1 onto
    // `Sentry.logger[level]`. The message is the redacted line WITHOUT the
    // `[service]` prefix — that prefix is a stdout concern; off-box the service
    // rides as an attribute stamped by the adapter.
    const attributes =
      redactedContextJson !== undefined
        ? (JSON.parse(redactedContextJson) as Record<string, unknown>)
        : undefined;
    structuredSink.log(msgLevel, redactedMessage, attributes);
  };

  return {
    debug: (message, context) => emit('debug', message, context),
    info: (message, context) => emit('info', message, context),
    warn: (message, context) => emit('warn', message, context),
    error: (message, context) => emit('error', message, context),
  };
}
