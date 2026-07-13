// Canonical structured logger, shared by all three services (AD-2). Promoted
// from the byte-identical packages/bot/src/logger.ts and
// packages/workers/src/logger.ts (Story 6.4, DECISION 3); Story ops-4 finished
// the consolidation — bot/workers now call THIS logger too, their local copies
// deleted. It honors the operator's `observability.log_level` and emits
// `[${service}] <level> <msg> <ctx-json>` to stdout.
//
// Story ops-4 — DUAL SINK: every line at or above the threshold is ALSO forwarded
// to Sentry Structured Logs (`Sentry.logger[level]`) so the operator never has to
// open `docker logs`. The Sentry methods are safe no-ops until `initSentry` runs
// (and stay no-ops when the DSN is empty, S-5), so this adds nothing to a service
// booted without a DSN. The SAME `redactSecrets` output that guards stdout is what
// is forwarded — a secret never reaches either sink.
//
// SECURITY: callers must never pass secrets (tokens, DATABASE_URL, REDIS_URL,
// API keys) or full message `content` in the context object — log
// `content.length`, counts, or ids instead (see project-context §anti-patterns).
import * as Sentry from '@sentry/node';

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
 * Create a logger gated at `level`, prefixed with `service`. Levels below the
 * threshold are dropped. `sink` defaults to the global console; tests inject a
 * fake to assert output.
 */
export function createLogger(level: LogLevel, service: string, sink: LogSink = console): Logger {
  const threshold = LEVEL_ORDER[level];

  const emit = (msgLevel: LogLevel, message: string, context?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[msgLevel] < threshold) return;
    // Redact ONCE and feed the same scrubbed output to both sinks (AC5): stdout
    // (unchanged) and Sentry Logs. Below-threshold lines return above, so they
    // reach neither sink — Sentry log volume respects `log_level`.
    const redactedMessage = redactSecrets(message);
    const prefix = `[${service}] ${msgLevel} ${redactedMessage}`;
    const hasContext = context !== undefined && Object.keys(context).length > 0;
    // The console path serializes+redacts the context to a trailing JSON string;
    // round-trip that exact redacted JSON back to an object for Sentry's log
    // attributes, so both sinks carry byte-identical redaction (no raw context
    // object ever leaves this function).
    const redactedContextJson = hasContext ? redactSecrets(JSON.stringify(context)) : undefined;

    if (redactedContextJson !== undefined) {
      sink[msgLevel](prefix, redactedContextJson);
    } else {
      sink[msgLevel](prefix);
    }

    // Sentry Structured Logs sink (Story ops-4). No-op until initSentry runs.
    // `debug/info/warn/error` map 1:1 to Sentry.logger's same-named methods.
    const attributes =
      redactedContextJson !== undefined
        ? (JSON.parse(redactedContextJson) as Record<string, unknown>)
        : undefined;
    Sentry.logger[msgLevel](redactedMessage, attributes);
  };

  return {
    debug: (message, context) => emit('debug', message, context),
    info: (message, context) => emit('info', message, context),
    warn: (message, context) => emit('warn', message, context),
    error: (message, context) => emit('error', message, context),
  };
}
