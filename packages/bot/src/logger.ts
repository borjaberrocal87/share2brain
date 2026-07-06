// Minimal structured logger for the bot process. There is no shared logger in the
// codebase yet (the other services use bare console.* with a [service] prefix), so
// this is a tiny local wrapper — no new dependency — that honors the operator's
// `observability.log_level` and emits `[bot] <level> <msg> <ctx-json>`.
//
// SECURITY: callers must never pass secrets (token, DATABASE_URL, REDIS_URL, api
// keys) or full message `content` in the context object — log `content.length` or
// a redacted marker instead (see project-context §anti-patterns).
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Severity ordering: a message is emitted only if its level >= the configured level. */
const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

/** The console-like sink the logger writes to (injectable so unit tests can capture output). */
export interface LogSink {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/**
 * Create a logger gated at `level`. Levels below the threshold are dropped.
 * `sink` defaults to the global console; tests inject a fake to assert output.
 */
export function createLogger(level: LogLevel, sink: LogSink = console): Logger {
  const threshold = LEVEL_ORDER[level];

  const emit = (msgLevel: LogLevel, message: string, context?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[msgLevel] < threshold) return;
    const prefix = `[bot] ${msgLevel} ${message}`;
    if (context && Object.keys(context).length > 0) {
      sink[msgLevel](prefix, JSON.stringify(context));
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
