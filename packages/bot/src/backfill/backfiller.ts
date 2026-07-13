// Historical backfill orchestrator (AC-1…AC-6). Drives the SAME ingestion path
// as the live listener — persistMessage, now idempotent — so backfill is a
// driver of the existing pipeline, not a second one.
//
// Rate-limit posture (AC-4): channels are processed sequentially, pages are
// throttled with an abortable ≥1 s sleep, and 429s are absorbed by discord.js's
// default REST queue (Retry-After honored because rejectOnRateLimit is never
// overridden — do NOT hand-roll 429 handling here).
//
// Failure posture (AC-5): each channel runs in its own try/catch — an unknown
// id, a missing permission, or a mid-fetch error logs one `error` line and the
// loop continues. The completed event is ALWAYS emitted after attempting all
// channels — except on shutdown abort, where not all channels were attempted
// and Redis is already being torn down.
import type { Share2BrainConfig } from '@share2brain/shared';
import type { Database } from '@share2brain/shared/db';
import type { RedisClient } from '@share2brain/shared/redis';
import { STREAM_KEYS, type BackfillCompletedEvent } from '@share2brain/shared/types/events';
import type { Client } from 'discord.js';

import { waitOrAbort } from '../discord/reconnect.js';
import type { Logger } from '@share2brain/shared/logger';
import {
  persistMessage,
  type IngestDeps,
  type IngestibleMessage,
} from '../persistence/persistMessage.js';
import { gapPages, latestPages, type FetchPage } from './pages.js';

/**
 * AC-4: minimum pause between two history page fetches. Reused (via `throttle`
 * below) as the inter-CHANNEL pause too — one constant, one REST budget, since
 * a channel's first-page fetch shares the same rate-limit bucket as the
 * inter-page fetches within it. Tune both together; they are NOT independent.
 */
const INTER_PAGE_DELAY_MS = 1_000;

// Bounded retry for a single message's persist — absorbs a transient DB/Redis
// blip without letting the derived cursor skip past an unpersisted message: the
// cursor is just "the newest row in the table", so a lone failure surrounded by
// later successes would otherwise be lost forever (Review, second pass).
const MAX_MESSAGE_ATTEMPTS = 3;
const MESSAGE_RETRY_DELAY_MS = 500;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Persist one message with up to MAX_MESSAGE_ATTEMPTS attempts, waiting
 * MESSAGE_RETRY_DELAY_MS (abortable) between attempts. Returns null when every
 * attempt failed or the signal aborted mid-retry — the caller logs that as an
 * isolated failure (AC-5) and moves on to the next message.
 */
async function persistWithRetry(
  message: IngestibleMessage,
  deps: IngestDeps,
  signal: AbortSignal,
  sleep: (ms: number) => Promise<void>,
  logger: Logger,
): Promise<{ inserted: boolean } | null> {
  for (let attempt = 1; attempt <= MAX_MESSAGE_ATTEMPTS; attempt += 1) {
    try {
      return await persistMessage(message, deps);
    } catch (error) {
      if (attempt >= MAX_MESSAGE_ATTEMPTS) {
        logger.error('backfill message failed after retries', {
          messageId: message.id,
          channelId: message.channelId,
          attempts: attempt,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
      logger.warn('backfill message persist failed, retrying', {
        messageId: message.id,
        channelId: message.channelId,
        attempt,
        error: error instanceof Error ? error.message : String(error),
      });
      await waitOrAbort(sleep(MESSAGE_RETRY_DELAY_MS), signal);
      if (signal.aborted) return null;
    }
  }
  return null;
}

export interface BackfillDeps {
  client: Client;
  config: Share2BrainConfig;
  db: Database;
  redis: RedisClient;
  logger: Logger;
  /** Per-channel cursors resolved BEFORE client.login() (AC-1) — channelId → newest persisted id or null. */
  cursors: ReadonlyMap<string, string | null>;
  /** The process shutdown signal: aborts sleeps and stops the loop cleanly. */
  signal: AbortSignal;
  /** Injectable delay, defaults to setTimeout — tests pass a fake to control timing. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Backfill every enabled channel sequentially, then publish one
 * BackfillCompletedEvent to KNOWLEDGE_EVENTS. Never throws for a single bad
 * channel; the caller catches a whole-run failure (AC-5).
 */
export async function runBackfill({
  client,
  config,
  db,
  redis,
  logger,
  cursors,
  signal,
  sleep = defaultSleep,
}: BackfillDeps): Promise<void> {
  const throttle = (): Promise<void> => waitOrAbort(sleep(INTER_PAGE_DELAY_MS), signal);
  let channelsProcessed = 0;
  let channelsFailed = 0;
  let messagesPublished = 0;
  let messagesFailed = 0;
  let firstChannel = true;

  for (const channelConfig of config.discord.channels) {
    if (!channelConfig.enabled) continue;
    if (signal.aborted) break;

    // Inter-channel throttle: pace first-page fetches so they don't all hit
    // Discord back-to-back (each channel's first page fires through the same
    // REST bucket as the inter-page throttled fetches within it).
    if (firstChannel) {
      firstChannel = false;
    } else {
      await throttle();
      if (signal.aborted) break;
    }

    try {
      if (!cursors.has(channelConfig.id)) {
        // Cursor resolution failed for this channel before login (main.ts) —
        // NOT the same as a confirmed-null "first run" cursor. Skip this
        // channel's backfill this run rather than guessing a bounded fetch;
        // cursor resolution retries fresh next boot.
        throw new Error('cursor unresolved for this channel — skipping this run');
      }
      const channel = await client.channels.fetch(channelConfig.id);
      if (channel === null) {
        throw new Error('channel not found (unknown id or bot lacks access)');
      }
      if (!channel.isTextBased()) {
        throw new Error('channel is not text-based');
      }

      // Adapter boundary: wrap the real history fetch as the pure generators'
      // injected FetchPage, mapping each discord.js Message to the same
      // IngestibleMessage slice the live path uses. cache: false — do not retain
      // up to `limit` historical messages in the discord.js cache.
      const fetchPage: FetchPage<IngestibleMessage> = async (opts) => {
        const fetched = await channel.messages.fetch({ limit: 100, cache: false, ...opts });
        return [...fetched.values()].map((m) => ({
          id: m.id,
          channelId: m.channelId,
          guildId: m.guildId,
          content: m.content,
          createdAt: m.createdAt,
          editedAt: m.editedAt,
          author: { id: m.author.id, bot: m.author.bot, displayName: m.author.displayName },
        }));
      };

      const cursor = cursors.get(channelConfig.id) ?? null;
      const pages =
        cursor === null
          ? latestPages(fetchPage, config.discord.backfill.limit, { signal, throttle })
          : gapPages(fetchPage, cursor, { signal, throttle });

      let published = 0;
      for await (const page of pages) {
        for (const message of page) {
          if (signal.aborted) break;
          // Same guards as the live path (AC-3), but at debug — a history full of
          // attachment-only messages must not spam the live intent-warning.
          if (config.discord.backfill.ignore_bots && message.author.bot) {
            logger.debug('backfill skip: bot author', {
              channelId: message.channelId,
              authorId: message.author.id,
            });
            continue;
          }
          if (!message.content || message.content.trim().length === 0) {
            logger.debug('backfill skip: empty content', {
              messageId: message.id,
              channelId: message.channelId,
            });
            continue;
          }
          // Per-message error isolation: a transient Redis/DB failure on one
          // message must not abort the rest of the channel — retried a few times
          // first (persistWithRetry) so it doesn't cost a permanent loss either.
          const result = await persistWithRetry(message, { config, db, redis }, signal, sleep, logger);
          // inserted=false → the row already existed (cursor-boundary overlap or a
          // live message that beat us): skipped, no duplicate row, no duplicate event.
          // Credited immediately (not at channel end) so a later mid-channel throw
          // doesn't undercount messages this run already persisted.
          if (result === null) {
            // Every persistWithRetry attempt failed — the accepted residual risk of
            // the bounded-retry trade-off (Review, second pass). Surface it in the
            // completed event so it isn't just a single easy-to-miss `error` log line.
            messagesFailed += 1;
          } else if (result.inserted) {
            published += 1;
            messagesPublished += 1;
          }
        }
        if (signal.aborted) break;
      }

      // Skip the "done" bookkeeping when the run was cut short by shutdown — the
      // channel was not actually processed, and the completed event never fires
      // in that case anyway (see the `signal.aborted` check below).
      if (!signal.aborted) {
        channelsProcessed += 1;
        logger.info('backfill channel done', {
          channelId: channelConfig.id,
          published,
          mode: cursor === null ? 'initial' : 'gap',
        });
      }
    } catch (error) {
      // AC-5: one bad channel never aborts the backfill or crashes the bot.
      channelsFailed += 1;
      logger.error('backfill channel failed', {
        channelId: channelConfig.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (signal.aborted) {
    logger.info('backfill aborted by shutdown — completion event not published');
    return;
  }

  // AC-5: always emitted once all channels were attempted, failures included.
  // All-string fields (AD-13); counts are numbers locally, stringified for the stream.
  // Record<keyof T, string>, not T itself: xAdd wants Record<string, RedisArgument>,
  // and a plain interface (no index signature) isn't structurally assignable to that.
  const event: Record<keyof BackfillCompletedEvent, string> = {
    type: 'discord.backfill.completed',
    guildId: config.discord.guild_id,
    timestamp: new Date().toISOString(),
    channelsProcessed: String(channelsProcessed),
    channelsFailed: String(channelsFailed),
    messagesPublished: String(messagesPublished),
    messagesFailed: String(messagesFailed),
  };
  try {
    await redis.xAdd(STREAM_KEYS.KNOWLEDGE_EVENTS, '*', event);
  } catch (error) {
    // The completed event is fire-and-forget observability (Epic 6 Notifier
    // consumer is deferred). A Redis outage here does NOT mean the backfill
    // itself failed — channels were successfully processed — so log separately.
    logger.error('backfill completed event xadd failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  logger.info('backfill completed', {
    channelsProcessed,
    channelsFailed,
    messagesPublished,
    messagesFailed,
  });
}
