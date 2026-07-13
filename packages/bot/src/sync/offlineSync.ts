// Startup offline reconciliation orchestrator (AC-1, AC-2, AC-5, AC-7, AC-8).
// Publish-only — no DB write here. After the historical backfill settles, this
// walks each enabled channel sequentially, diffs its current Discord state
// against persisted rows (reconcile.ts), and republishes into the same streams
// the live path (Story 6.1 handlers) uses — the Sync worker (Story 6.2) does
// the actual mutation.
//
// Per-channel isolation (AC-5): a throw anywhere in a channel's fetch/compare
// aborts publishing for THAT channel only — mirrors runBackfill's try/catch.
// Since edits and deletes are both computed from one diffChannel call after a
// fully successful re-fetch, a mid-walk failure means neither branch runs for
// that channel this run (note #5: "no deletes for that channel this run").
import type { Share2BrainConfig } from '@share2brain/shared';
import type { Database } from '@share2brain/shared/db';
import { sql } from '@share2brain/shared/db';
import type { RedisClient } from '@share2brain/shared/redis';
import type { Client } from 'discord.js';

import { getChannelCursor } from '../backfill/cursor.js';
import { handleMessageDelete } from '../discord/handlers/messageDelete.js';
import { handleMessageUpdate } from '../discord/handlers/messageUpdate.js';
import { waitOrAbort } from '../discord/reconnect.js';
import type { Logger } from '@share2brain/shared/logger';
import { diffChannel, toIdKey, type FetchedMessage, type PersistedRow } from './reconcile.js';

// Same cadence as backfill/backfiller.ts — one shared REST budget, not a second one.
const INTER_PAGE_DELAY_MS = 1_000;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface OfflineSyncDeps {
  client: Client;
  config: Share2BrainConfig;
  db: Database;
  redis: RedisClient;
  logger: Logger;
  /** The process shutdown signal: stops the loop cleanly at channel/page boundaries. */
  signal: AbortSignal;
  /** Injectable delay, defaults to setTimeout — tests pass a fake to control timing. */
  sleep?: (ms: number) => Promise<void>;
}

interface FetchableChannel {
  messages: {
    fetch: (opts: { limit: number; cache: boolean; before?: string }) => Promise<Map<string, FetchedMessage>>;
  };
}

interface WalkResult {
  fetched: FetchedMessage[];
  windowCapped: boolean;
}

/**
 * Walk backward from `lastSeen`, collecting up to `limit` current messages
 * (note #1, #6: the anchor excludes the freshly-backfilled tail above it).
 * `windowCapped` is true when `limit` was hit before a short (<100) page —
 * i.e. there is more history below the reconciled window (AC-7).
 */
async function fetchRecentWindow(
  channel: FetchableChannel,
  lastSeen: string,
  limit: number,
  { signal, throttle }: { signal: AbortSignal; throttle: () => Promise<void> },
): Promise<WalkResult> {
  const collected: FetchedMessage[] = [];
  let before: string | undefined = lastSeen;
  let windowCapped = false;
  let firstPage = true;

  for (;;) {
    if (!firstPage) await throttle();
    firstPage = false;
    // Re-check AFTER the throttle: waitOrAbort RESOLVES (never rejects) on abort,
    // so an abort landing mid-throttle must be caught here or it would fall
    // straight into an extra fetch (AC-5: check before EACH page fetch).
    if (signal.aborted) break;

    const page = await channel.messages.fetch({ limit: 100, cache: false, before });
    const items = [...page.values()];
    if (items.length === 0) break;
    collected.push(...items);

    const oldest = items.reduce((min, m) => {
      const minKey = toIdKey(min.id);
      const key = toIdKey(m.id);
      if (minKey === null || key === null) return min;
      return key < minKey ? m : min;
    });
    before = oldest.id;

    if (items.length < 100) {
      // Head-of-history reached. Still capped if this final page overshot the
      // limit — slice(0, limit) then discards real older messages, so the
      // reconciled window is NOT the full history (AC-7 must not claim it is).
      windowCapped = collected.length > limit;
      break;
    }
    if (collected.length >= limit) {
      windowCapped = true;
      break;
    }
  }

  return { fetched: collected.slice(0, limit), windowCapped };
}

/**
 * Reconcile every enabled channel sequentially, then republish diffed
 * edits/deletes via the Story 6.1 handlers. Never throws for a single bad
 * channel; the caller (main.ts) catches a whole-run structural failure.
 */
export async function runOfflineSync({
  client,
  config,
  db,
  redis,
  logger,
  signal,
  sleep = defaultSleep,
}: OfflineSyncDeps): Promise<void> {
  const throttle = (): Promise<void> => waitOrAbort(sleep(INTER_PAGE_DELAY_MS), signal);

  for (const channelConfig of config.discord.channels) {
    if (!channelConfig.enabled) continue;
    if (signal.aborted) break;

    try {
      const lastSeen = await getChannelCursor(db, channelConfig.id);
      if (lastSeen === null) {
        logger.debug('offline sync skip: no persisted messages — nothing to reconcile', {
          channelId: channelConfig.id,
        });
        continue;
      }

      const channel = await client.channels.fetch(channelConfig.id);
      if (channel === null) {
        throw new Error('channel not found (unknown id or bot lacks access)');
      }
      if (!channel.isTextBased()) {
        throw new Error('channel is not text-based');
      }

      const { fetched, windowCapped } = await fetchRecentWindow(
        channel,
        lastSeen,
        config.discord.backfill.limit,
        { signal, throttle },
      );
      if (signal.aborted) break; // no completion side effects on shutdown

      const persistedResult = await db.execute(
        sql`select id, content from discord_messages where channel_id = ${channelConfig.id} and deleted_at is null order by created_at desc limit ${config.discord.backfill.limit}`,
      );
      const persisted: PersistedRow[] = persistedResult.rows.map((row) => {
        const r = row as Record<string, unknown>;
        return { id: String(r.id), content: String(r.content) };
      });

      const { edits, deletes, reconciled } = diffChannel({ persisted, fetched, lastSeen });

      let editsPublished = 0;
      for (const edit of edits) {
        await handleMessageUpdate(edit, { config, redis, logger });
        editsPublished += 1;
      }

      let deletesPublished = 0;
      for (const deletedRow of deletes) {
        await handleMessageDelete(
          { id: deletedRow.id, channelId: channelConfig.id, guildId: config.discord.guild_id },
          { config, redis, logger },
        );
        deletesPublished += 1;
      }

      logger.info('offline sync channel done', {
        channelId: channelConfig.id,
        editsPublished,
        deletesPublished,
        reconciled,
        windowCapped,
      });
    } catch (error) {
      // AC-5: one bad channel never aborts the run or crashes the bot.
      logger.error('offline sync channel failed', {
        channelId: channelConfig.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
