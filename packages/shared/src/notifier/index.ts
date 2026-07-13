// Shared crash-alert adapter (FR21, Story 6.4). Mirrors
// packages/shared/src/infrastructure/redis.ts: a factory that performs NO I/O
// at construction, degrades rather than crashes on failure, and is imported by
// all three services (AD-2) — none of them imports another service.
//
// DELIBERATELY NOT the reserved `share2brain:knowledge:events` stream / `share2brain:notifier`
// consumer group (types/events.ts) — a process-fatal error usually means the
// process is dying (uncaughtException → exit(1)) or Redis itself is the outage,
// and an XADD can't be relied on to flush in either case. This sends the alert
// directly over HTTP instead.
//
// SECURITY: `notify()` must never receive or emit a secret (bot token, webhook
// URL) or Discord message content — only { service, message, timestamp }.
import { redactSecrets } from '../logger.js';
import type { NotificationsConfig } from '../config/index.js';

export interface NotificationPayload {
  service: 'bot' | 'backend' | 'workers';
  message: string;
  timestamp: string;
}

export interface Notifier {
  /** Send one alert. Never throws or rejects — a transport failure is swallowed. */
  notify(payload: NotificationPayload): Promise<void>;
}

/** The subset of Logger this module needs — accepts bot/workers' local loggers too. */
export interface NotifierLogger {
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

const SEND_TIMEOUT_MS = 5_000;
/** Telegram rejects a message over 4096 chars with HTTP 400 (→ the alert would
 * be silently dropped); stay well under it. */
const MAX_MESSAGE_CHARS = 3_900;

/**
 * Sanitize an error message before it leaves the process (AC-1: the alert body
 * must NEVER carry a DB/Redis URL, API key, or webhook secret). Some driver
 * errors interpolate the whole connection URL — including its `user:pass@`
 * userinfo — into `error.message`. Redact that userinfo (shared `redactSecrets`,
 * also applied by every service logger — AUDIT M2), then cap the length so an
 * oversized message can't make Telegram drop the alert (note #3, the 4096-char limit).
 */
function sanitizeMessage(message: string): string {
  const redacted = redactSecrets(message);
  return redacted.length > MAX_MESSAGE_CHARS ? `${redacted.slice(0, MAX_MESSAGE_CHARS)}…` : redacted;
}

function formatText(payload: NotificationPayload): string {
  return `🔴 [${payload.service}] ${sanitizeMessage(payload.message)} — ${payload.timestamp}`;
}

async function sendTelegram(
  telegram: { bot_token: string; chat_id: string },
  payload: NotificationPayload,
  logger: NotifierLogger,
): Promise<void> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${telegram.bot_token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: telegram.chat_id, text: formatText(payload) }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn('notification send failed', { provider: 'telegram', reason: `HTTP ${res.status}` });
    }
  } catch (err: unknown) {
    logger.warn('notification send failed', {
      provider: 'telegram',
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

async function sendSlack(
  slack: { webhook_url: string },
  payload: NotificationPayload,
  logger: NotifierLogger,
): Promise<void> {
  try {
    const res = await fetch(slack.webhook_url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: formatText(payload) }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn('notification send failed', { provider: 'slack', reason: `HTTP ${res.status}` });
    }
  } catch (err: unknown) {
    logger.warn('notification send failed', {
      provider: 'slack',
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

const NOOP_NOTIFIER: Notifier = { notify: async () => undefined };

/**
 * Build a Notifier from validated config. Returns a no-op when `config` is
 * undefined or `enabled === false` — no `fetch`, no throw, callers behave
 * exactly as before notifications existed.
 */
export function createNotifier(
  config: NotificationsConfig | undefined,
  logger: NotifierLogger,
): Notifier {
  if (!config?.enabled) return NOOP_NOTIFIER;

  const { provider, telegram, slack } = config;

  return {
    notify: async (payload: NotificationPayload): Promise<void> => {
      if (provider === 'telegram' && telegram) {
        await sendTelegram(telegram, payload, logger);
        return;
      }
      if (provider === 'slack' && slack) {
        await sendSlack(slack, payload, logger);
        return;
      }
      // Unreachable when config passed loadConfig's superRefine, but never throw.
      logger.warn('notification send failed', { provider, reason: 'missing provider credentials' });
    },
  };
}
