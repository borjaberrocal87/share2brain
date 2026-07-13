// Per-message resource pipeline (Story 7.3 D5 — relocated from
// indexer/indexBatch.ts so the Sync worker can reuse it without importing
// across the Indexer/Sync boundary; intra-package move, not a cross-service
// import — AD-2 is unaffected). Extract URLs → discard if none → per URL:
// reuse lookup hit (kept link, no I/O) OR SSRF-guarded fetch → AI enrich
// (message-text-only fallback on fetch failure).
//
// Throws on an enrichment hard failure for ANY of the message's URLs — the
// whole message is a processing failure (D1); the caller leaves it entirely
// un-ACKed. `fetchUrl`/`enrich` never throw on their own account (typed
// outcomes / {@link EnrichmentError}), so a throw here always means
// enrichment failed.
import type { Share2BrainConfig } from '@share2brain/shared';

import type { Logger } from '../logger.js';
import { enrich, type EnrichmentChatModel } from './enrich.js';
import { extractUrls } from './extractUrls.js';
import { extractPageHints } from './htmlText.js';
import type { GuardedDispatcher } from './ssrfGuard.js';
import { fetchUrl } from './urlFetcher.js';

/** Per-message cap on the URLs actually fetched+enriched. Bounds the paid
 *  fetch/LLM/embed fan-out one crafted message can trigger (the old
 *  `MAX_GROUPING_WINDOW=50` bound was demolished with the grouping stage). URLs
 *  beyond the cap are dropped (first-N in extraction order) and logged. Applies
 *  to edits too (Story 7.3, D6) — a module constant, not config. */
export const MAX_URLS_PER_MESSAGE = 20;

export interface ResourceRow {
  urlIndex: number;
  title: string;
  description: string;
  link: string;
  /** Set only for a REUSED (kept) link (Story 7.3 F1/F2) — the caller persists
   *  this vector directly and must never re-embed the row. Absent for a
   *  freshly enriched row, which the caller embeds via `buildEmbeddingText`. */
  embedding?: number[];
}

export type MessageOutcome = { kind: 'discard' } | { kind: 'rows'; rows: ResourceRow[] };

/** A link whose title/description/embedding are already known — a hit skips
 *  fetch+enrich+embed entirely for that URL (Story 7.3 F1/F2, link-diff reuse
 *  of kept links). */
export type ReuseLookup = (
  link: string,
) => { title: string; description: string; embedding: number[] } | undefined;

export interface BuildResourceRowsDeps {
  config: Share2BrainConfig;
  enrichModel: EnrichmentChatModel;
  guard: GuardedDispatcher;
  signal: AbortSignal;
  logger: Logger;
  /** Kept-link fast path (Story 7.3) — absent for the Indexer's first-index
   *  path, where every link is necessarily new. */
  reuse?: ReuseLookup;
}

/**
 * Process one message's content into either a discard (no URLs / all blocked)
 * or the set of resource rows to persist.
 */
export async function buildResourceRows(
  content: string,
  deps: BuildResourceRowsDeps,
): Promise<MessageOutcome> {
  const { config, enrichModel, guard, signal, logger, reuse } = deps;
  const extracted = extractUrls(content, config.enrichment.fetch.allowed_schemes);
  if (extracted.length === 0) return { kind: 'discard' };

  const urls = extracted.slice(0, MAX_URLS_PER_MESSAGE);
  if (extracted.length > urls.length) {
    logger.warn('message exceeds the per-message URL cap — indexing the first N, dropping the rest', {
      extracted: extracted.length,
      cap: MAX_URLS_PER_MESSAGE,
      dropped: extracted.length - urls.length,
    });
  }

  const rows: ResourceRow[] = [];
  for (let urlIndex = 0; urlIndex < urls.length; urlIndex++) {
    if (signal.aborted) {
      throw new Error('aborted while processing message URLs — leaving entry un-ACKed for replay');
    }

    const url = urls[urlIndex];

    const kept = reuse?.(url);
    if (kept) {
      rows.push({
        urlIndex,
        title: kept.title,
        description: kept.description,
        link: url,
        embedding: kept.embedding,
      });
      continue;
    }

    const outcome = await fetchUrl(url, config.enrichment.fetch, guard, signal);

    if (
      !outcome.ok &&
      (outcome.reason === 'ssrf_blocked' ||
        outcome.reason === 'scheme_disallowed' ||
        outcome.reason === 'port_disallowed')
    ) {
      continue; // D2: skip this URL entirely — no row, not a failure.
    }

    const pageHints = outcome.ok ? extractPageHints(outcome.body, outcome.contentType) : null;
    // AUDIT M4: bound each enrichment LLM call with a wall-clock timeout combined
    // with the shutdown signal. A provider that stalls without erroring would
    // otherwise block this sequential loop forever; the timeout makes it a normal
    // enrichment throw (message left un-ACKed → PEL replay → eventual dead-letter).
    const enrichSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(config.enrichment.llm.timeout_ms),
    ]);
    const result = await enrich(
      enrichModel,
      { messageText: content, pageHints, language: config.enrichment.language },
      enrichSignal,
    );

    rows.push({ urlIndex, title: result.title, description: result.description, link: url });
  }

  if (rows.length === 0) return { kind: 'discard' }; // D2's all-blocked case converges here.
  return { kind: 'rows', rows };
}
