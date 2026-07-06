// Pure pagination generators for the historical backfill (AC-2, AC-4, AC-6).
// No discord.js imports: the fetch is injected as `FetchPage`, so these unit-test
// with plain fixtures and the orchestrator owns the adapter wiring.
//
// Discord returns every page NEWEST-first regardless of `before`/`after` (the
// anchor selects the window, not the ordering). Both generators therefore sort
// each page ASCENDING by BigInt(id) before yielding — inserts land in
// chronological order, so the derived cursor (newest persisted row) always means
// "everything before me is already persisted" and a crash mid-channel resumes at
// exactly the remaining gap. BigInt, never string compare: snowflakes are
// variable-length (18 vs 19 digits) and lexicographic order mis-sorts them.

/** The minimal shape pagination needs; the orchestrator carries the full message. */
export interface RawBackfillMessage {
  id: string; // Discord snowflake
}

/**
 * One Discord history fetch (≤100 messages, newest-first). Exactly one of
 * `after`/`before` is set (or neither: the head of history).
 */
export type FetchPage<T extends RawBackfillMessage = RawBackfillMessage> = (opts: {
  after?: string;
  before?: string;
}) => Promise<T[]>;

export interface PageOptions {
  /** Stops iteration promptly on shutdown; checked before every fetch. */
  signal?: AbortSignal;
  /** Awaited between page fetches (AC-4: the orchestrator injects a ≥1 s abortable sleep). */
  throttle?: () => Promise<void>;
}

/** Discord's hard page-size cap; a shorter page means the head of history was reached. */
const PAGE_SIZE = 100;

function sortAscendingById<T extends RawBackfillMessage>(page: T[]): T[] {
  // Parse each id's BigInt key ONCE, up front — never inside the comparator.
  // Deciding numeric-vs-string per PAIR would let different comparisons in the
  // same sort use different rules, which is not guaranteed transitive and can
  // silently corrupt the ascending order `Array.prototype.sort` relies on.
  // BigInt('') and BigInt('   ') return 0n instead of throwing, so a plain
  // try/catch alone would let an empty/blank id slip through as a (wrongly
  // minimal) numeric key. Require an all-digit string before parsing.
  const keyed = page.map((item) => ({
    item,
    key: /^\d+$/.test(item.id) ? BigInt(item.id) : null,
  }));
  const allNumeric = keyed.every((entry) => entry.key !== null);
  return keyed
    .sort((a, b) => {
      if (allNumeric) {
        const aKey = a.key as bigint;
        const bKey = b.key as bigint;
        return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
      }
      // Any non-numeric id in the page — last resort: string compare for the
      // WHOLE page, so every pairwise comparison uses the same rule.
      return a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0;
    })
    .map(({ item }) => item);
}

/**
 * Gap path (cursor non-null): walk FORWARD from the cursor to the present,
 * yielding each page ascending. `backfill.limit` does not bound this path — the
 * whole offline gap is covered (AC-6).
 */
export async function* gapPages<T extends RawBackfillMessage>(
  fetchPage: FetchPage<T>,
  cursor: string,
  { signal, throttle }: PageOptions = {},
): AsyncGenerator<T[]> {
  let after = cursor;
  for (;;) {
    if (signal?.aborted) return;
    const page = await fetchPage({ after });
    if (page.length === 0) return;
    const ascending = sortAscendingById(page);
    yield ascending;
    if (page.length < PAGE_SIZE) return;
    after = ascending[ascending.length - 1].id; // max id of the page
    await throttle?.();
  }
}

/**
 * Initial path (cursor null): collect the most recent `limit` messages by
 * paginating BACKWARD with `before`, then yield the window oldest→newest in
 * ascending chunks (same chronological-insert invariant as the gap path).
 *
 * On abort mid-collection nothing is yielded: inserting only the newest slice
 * would park the derived cursor at the head and permanently skip the rest of
 * the window on resume.
 */
export async function* latestPages<T extends RawBackfillMessage>(
  fetchPage: FetchPage<T>,
  limit: number,
  { signal, throttle }: PageOptions = {},
): AsyncGenerator<T[]> {
  if (limit <= 0) return;

  // Collected newest→oldest: pages arrive newest-first and each step goes older.
  const collected: T[] = [];
  let before: string | undefined;
  for (;;) {
    if (signal?.aborted) return;
    const page = await fetchPage(before === undefined ? {} : { before });
    if (page.length === 0) break;
    const ascending = sortAscendingById(page);
    collected.push(...[...ascending].reverse());
    before = ascending[0].id; // min id of the page — the next-older window anchor
    if (page.length < PAGE_SIZE || collected.length >= limit) break;
    await throttle?.();
  }
  if (signal?.aborted) return;

  // Trim to the NEWEST `limit`, flip to chronological order, yield in chunks.
  const window = collected.slice(0, limit).reverse();
  for (let i = 0; i < window.length; i += PAGE_SIZE) {
    if (signal?.aborted) return;
    yield window.slice(i, i + PAGE_SIZE);
  }
}
