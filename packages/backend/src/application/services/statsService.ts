// Application service: stats orchestration. Turns the caller's RBAC scope into a
// validated StatsResponse — computes the UTC 14-day window + week start,
// assembles the 4 KPIs (D3), zero-fills the activity series (D5), and computes
// readPct (AC5). Depends ONLY on the domain port (StatsRepository) — no
// Drizzle, no Express — so it is unit-testable with plain fakes. Mirrors
// documentService.ts.
import { StatsResponseSchema, type StatsResponse } from '@hivly/shared/schemas';

import type { StatsRepository } from '../../domain/repositories/statsRepository.js';

const ACTIVITY_WINDOW_DAYS = 14;
const WEEKLY_DELTA_DAYS = 7;
const QUERIES_WINDOW_DAYS = 30;

function utcDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** UTC midnight of `now`'s calendar day. */
function utcToday(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** The `ACTIVITY_WINDOW_DAYS` UTC dates ending today (inclusive), oldest first (AC4). */
function buildWindowDays(now: Date): string[] {
  const today = utcToday(now);
  return Array.from({ length: ACTIVITY_WINDOW_DAYS }, (_, i) => {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - (ACTIVITY_WINDOW_DAYS - 1 - i));
    return utcDateString(d);
  });
}

export interface StatsService {
  /**
   * Aggregate knowledge KPIs, 14-day activity, per-channel volume, and personal
   * read coverage for `userId`, restricted to `allowedChannelIds` (AD-12). An
   * empty scope short-circuits every channel-scoped read (D6) — KPIs 1-3 read
   * 0, activity is 14 zero days, channels is `[]`, topUsers is `[]`, coverage
   * is `0/0/0` — while the per-user `queries` KPI still runs. `now` defaults to the wall clock;
   * tests pass a fixed value for a deterministic window.
   */
  getStats(userId: string, allowedChannelIds: string[], now?: Date): Promise<StatsResponse>;
}

export function createStatsService(deps: { statsRepo: StatsRepository }): StatsService {
  const { statsRepo } = deps;

  return {
    async getStats(userId, allowedChannelIds, now = new Date()): Promise<StatsResponse> {
      const windowDays = buildWindowDays(now);
      const fromDate = `${windowDays[0]}T00:00:00.000Z`;
      const weekStart = new Date(now.getTime() - WEEKLY_DELTA_DAYS * 24 * 60 * 60 * 1000).toISOString();
      // 30-day `queries` window, computed here so the whole response is anchored to
      // the same `now` as the other windows (not Postgres `now()`) — deterministic.
      const queriesFrom = new Date(
        now.getTime() - QUERIES_WINDOW_DAYS * 24 * 60 * 60 * 1000,
      ).toISOString();

      // `true` when the caller has NO accessible channels (deny-all) — short-circuits
      // every channel-scoped read (D6). Named for what it is, not the inverse.
      const emptyScope = allowedChannelIds.length === 0;

      const [kpiCounts, activityRows, channels, readCount, queries, topUsers] = await Promise.all([
        emptyScope
          ? Promise.resolve({ resources: 0, resourcesThisWeek: 0, channels: 0, authors: 0 })
          : statsRepo.getScopedKpiCounts(allowedChannelIds, weekStart),
        emptyScope ? Promise.resolve([]) : statsRepo.getActivity(allowedChannelIds, fromDate),
        emptyScope ? Promise.resolve([]) : statsRepo.getChannelCounts(allowedChannelIds),
        emptyScope ? Promise.resolve(0) : statsRepo.getCoverageReadCount(userId, allowedChannelIds),
        statsRepo.countUserAgentQueries(userId, queriesFrom), // D6: always runs, no channel scope
        emptyScope ? Promise.resolve([]) : statsRepo.getTopUsers(allowedChannelIds), // D5: channel-scoped
      ]);

      const countByDay = new Map(activityRows.map((row) => [row.day, row.count]));
      const activity = windowDays.map((date) => ({ date, count: countByDay.get(date) ?? 0 }));

      const totalCount = kpiCounts.resources;
      // readCount and totalCount come from two separate non-transactional reads, so a
      // soft-delete landing between them can momentarily make readCount > totalCount.
      // You cannot have read more resources than exist: bound readCount by totalCount so
      // the shipped pair is self-consistent (no "5 of 4 read") AND readPct stays in
      // [0,100] without a separate clamp (StatsCoverageSchema.max(100) would else 500).
      const safeReadCount = Math.min(readCount, totalCount);
      const readPct = totalCount === 0 ? 0 : Math.round((safeReadCount / totalCount) * 100);

      const kpis = [
        {
          key: 'resources' as const,
          label: 'Recursos indexados',
          value: kpiCounts.resources,
          sub: `+${kpiCounts.resourcesThisWeek} esta semana`,
        },
        {
          key: 'channels' as const,
          label: 'Canales',
          value: kpiCounts.channels,
          sub: `de ${allowedChannelIds.length} accesibles`,
        },
        {
          key: 'authors' as const,
          label: 'Autores',
          value: kpiCounts.authors,
          sub: 'en tus canales',
        },
        {
          key: 'queries' as const,
          label: 'Tus consultas al agente',
          value: queries,
          sub: 'últimos 30 días',
        },
      ];

      // Validate against the shared contract before it leaves the service (AD-6).
      return StatsResponseSchema.parse({
        kpis,
        activity,
        channels,
        coverage: { readCount: safeReadCount, totalCount, readPct },
        topUsers,
      });
    },
  };
}
