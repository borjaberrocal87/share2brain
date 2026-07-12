// Canonical structured logger, shared by all three services (AD-2). Promoted
// from the byte-identical packages/bot/src/logger.ts and
// packages/workers/src/logger.ts (Story 6.4, DECISION 3) — those two stay on
// their local copies (mature 6.1/6.2 code, don't churn); the backend uses this
// one for its new shutdown/notifier paths. It honors the operator's
// `observability.log_level` and emits `[${service}] <level> <msg> <ctx-json>`.
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
 * Create a logger gated at `level`, prefixed with `service`. Levels below the
 * threshold are dropped. `sink` defaults to the global console; tests inject a
 * fake to assert output.
 */
export function createLogger(level: LogLevel, service: string, sink: LogSink = console): Logger {
  const threshold = LEVEL_ORDER[level];

  const emit = (msgLevel: LogLevel, message: string, context?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[msgLevel] < threshold) return;
    const prefix = `[${service}] ${msgLevel} ${redactSecrets(message)}`;
    if (context && Object.keys(context).length > 0) {
      sink[msgLevel](prefix, redactSecrets(JSON.stringify(context)));
    } else {
      sink[msgLevel](prefix);
    }
  };

  return {
    debug: (message, context) => emit('debug', message, context),
    info: (message, context) => emit('info', message, context),
    warn: (message, context) => emit('warn', message, context),
    error: (message, context) => emit('error', message, context),
  };
}
