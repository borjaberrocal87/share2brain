// Unit tests for the stats application service — window/KPI/zero-fill/coverage
// orchestration + the empty-scope fast path (D6). Uses plain fakes (no Drizzle, no
// Express): the service depends only on the domain port. Mirrors documentService.test.ts.
import { describe, expect, it, vi } from 'vitest';

import type {
  ActivityDay,
  ChannelCount,
  ScopedKpiCounts,
  StatsRepository,
  TopUserRow,
} from '../../domain/repositories/statsRepository.js';
import { createStatsService } from './statsService.js';

const ZERO_KPIS: ScopedKpiCounts = { resources: 0, resourcesThisWeek: 0, channels: 0, authors: 0 };

function fakeRepo(overrides: Partial<StatsRepository> = {}): StatsRepository {
  return {
    getScopedKpiCounts: vi.fn(async () => ZERO_KPIS),
    getActivity: vi.fn(async (): Promise<ActivityDay[]> => []),
    getChannelCounts: vi.fn(async (): Promise<ChannelCount[]> => []),
    getCoverageReadCount: vi.fn(async () => 0),
    countUserAgentQueries: vi.fn(async () => 0),
    getTopUsers: vi.fn(async (): Promise<TopUserRow[]> => []),
    ...overrides,
  };
}

// Fixed "now" so the 14-day window is deterministic across the suite.
const NOW = new Date('2026-07-10T12:00:00.000Z');
const WINDOW_DAYS = [
  '2026-06-27',
  '2026-06-28',
  '2026-06-29',
  '2026-06-30',
  '2026-07-01',
  '2026-07-02',
  '2026-07-03',
  '2026-07-04',
  '2026-07-05',
  '2026-07-06',
  '2026-07-07',
  '2026-07-08',
  '2026-07-09',
  '2026-07-10',
];

describe('statsService.getStats', () => {
  it('should not call channel-scoped port methods when the scope is empty, but still calls countUserAgentQueries (D6)', async () => {
    const statsRepo = fakeRepo({ countUserAgentQueries: vi.fn(async () => 5) });
    const service = createStatsService({ statsRepo });

    const result = await service.getStats('user-1', [], NOW);

    expect(statsRepo.getScopedKpiCounts).not.toHaveBeenCalled();
    expect(statsRepo.getActivity).not.toHaveBeenCalled();
    expect(statsRepo.getChannelCounts).not.toHaveBeenCalled();
    expect(statsRepo.getCoverageReadCount).not.toHaveBeenCalled();
    expect(statsRepo.getTopUsers).not.toHaveBeenCalled();
    // Windowed to 30 days before the injected `now` (UTC), computed service-side so the
    // whole response is single-clock (RP4 — proves the 30-day cutoff, not Postgres now()).
    expect(statsRepo.countUserAgentQueries).toHaveBeenCalledWith(
      'user-1',
      '2026-06-10T12:00:00.000Z',
    );

    expect(result.kpis).toEqual([
      { key: 'resources', label: 'Recursos indexados', value: 0, sub: '+0 esta semana' },
      { key: 'channels', label: 'Canales', value: 0, sub: 'de 0 accesibles' },
      { key: 'authors', label: 'Autores', value: 0, sub: 'en tus canales' },
      { key: 'queries', label: 'Tus consultas al agente', value: 5, sub: 'últimos 30 días' },
    ]);
    expect(result.activity).toEqual(WINDOW_DAYS.map((date) => ({ date, count: 0 })));
    expect(result.channels).toEqual([]);
    expect(result.coverage).toEqual({ readCount: 0, totalCount: 0, readPct: 0 });
    expect(result.topUsers).toEqual([]);
  });

  it('should zero-fill exactly 14 dates ending at UTC today, oldest first, with missing days at 0', async () => {
    const statsRepo = fakeRepo({
      getActivity: vi.fn(async (): Promise<ActivityDay[]> => [
        { day: '2026-07-10', count: 3 },
        { day: '2026-06-27', count: 1 },
      ]),
    });
    const service = createStatsService({ statsRepo });

    const result = await service.getStats('user-1', ['chan-1'], NOW);

    expect(result.activity).toHaveLength(14);
    expect(result.activity.map((p) => p.date)).toEqual(WINDOW_DAYS);
    expect(result.activity[0]).toEqual({ date: '2026-06-27', count: 1 });
    expect(result.activity[13]).toEqual({ date: '2026-07-10', count: 3 });
    expect(result.activity[1]).toEqual({ date: '2026-06-28', count: 0 });
  });

  it('should compute readPct as 0 when totalCount is 0', async () => {
    const statsRepo = fakeRepo({
      getScopedKpiCounts: vi.fn(async () => ({ ...ZERO_KPIS, resources: 0 })),
      getCoverageReadCount: vi.fn(async () => 0),
    });
    const service = createStatsService({ statsRepo });

    const result = await service.getStats('user-1', ['chan-1'], NOW);

    expect(result.coverage).toEqual({ readCount: 0, totalCount: 0, readPct: 0 });
  });

  it('should round readPct (1/3 -> 33)', async () => {
    const statsRepo = fakeRepo({
      getScopedKpiCounts: vi.fn(async () => ({ ...ZERO_KPIS, resources: 3 })),
      getCoverageReadCount: vi.fn(async () => 1),
    });
    const service = createStatsService({ statsRepo });

    const result = await service.getStats('user-1', ['chan-1'], NOW);

    expect(result.coverage).toEqual({ readCount: 1, totalCount: 3, readPct: 33 });
  });

  it('should bound readCount by totalCount when readCount exceeds it (non-transactional race)', async () => {
    // resources (totalCount) and readCount come from two separate reads; a soft-delete
    // landing between them can momentarily make readCount > totalCount. The shipped pair
    // must stay self-consistent (no "5 of 4 read") and readPct within [0,100].
    const statsRepo = fakeRepo({
      getScopedKpiCounts: vi.fn(async () => ({ ...ZERO_KPIS, resources: 4 })),
      getCoverageReadCount: vi.fn(async () => 5),
    });
    const service = createStatsService({ statsRepo });

    const result = await service.getStats('user-1', ['chan-1'], NOW);

    expect(result.coverage).toEqual({ readCount: 4, totalCount: 4, readPct: 100 });
  });

  it('should assemble the KPI array in the fixed order with the ratified labels/subs (D3)', async () => {
    const statsRepo = fakeRepo({
      getScopedKpiCounts: vi.fn(async () => ({
        resources: 10,
        resourcesThisWeek: 4,
        channels: 2,
        authors: 6,
      })),
      countUserAgentQueries: vi.fn(async () => 7),
    });
    const service = createStatsService({ statsRepo });

    const result = await service.getStats('user-1', ['chan-1', 'chan-2'], NOW);

    expect(result.kpis).toEqual([
      { key: 'resources', label: 'Recursos indexados', value: 10, sub: '+4 esta semana' },
      { key: 'channels', label: 'Canales', value: 2, sub: 'de 2 accesibles' },
      { key: 'authors', label: 'Autores', value: 6, sub: 'en tus canales' },
      { key: 'queries', label: 'Tus consultas al agente', value: 7, sub: 'últimos 30 días' },
    ]);
  });

  it('should pass channel ordering through unchanged (D7 — SQL already orders)', async () => {
    const rows: ChannelCount[] = [
      { channelId: 'chan-1', channelName: 'general', count: 9 },
      { channelId: 'chan-2', channelName: 'random', count: 9 },
      { channelId: 'chan-3', channelName: 'archive', count: 1 },
    ];
    const statsRepo = fakeRepo({ getChannelCounts: vi.fn(async () => rows) });
    const service = createStatsService({ statsRepo });

    const result = await service.getStats('user-1', ['chan-1', 'chan-2', 'chan-3'], NOW);

    expect(result.channels).toEqual(rows);
  });

  it('should throw when the outgoing payload fails the shared contract (AD-6)', async () => {
    const statsRepo = fakeRepo({
      getChannelCounts: vi.fn(async (): Promise<ChannelCount[]> => [
        { channelId: '', channelName: 'bad', count: 1 },
      ]),
    });
    const service = createStatsService({ statsRepo });

    await expect(service.getStats('user-1', ['chan-1'], NOW)).rejects.toThrow();
  });

  it('should pass topUsers through unchanged (D4 — SQL already orders/limits)', async () => {
    const rows: TopUserRow[] = [
      { authorId: 'a1', authorName: 'Ada', count: 5 },
      { authorId: 'a2', authorName: 'Bea', count: 3 },
    ];
    const statsRepo = fakeRepo({ getTopUsers: vi.fn(async () => rows) });
    const service = createStatsService({ statsRepo });

    const result = await service.getStats('user-1', ['chan-1'], NOW);

    expect(result.topUsers).toEqual(rows);
  });

  it('should throw when getTopUsers returns misordered rows (AD-6 superRefine guard)', async () => {
    const statsRepo = fakeRepo({
      getTopUsers: vi.fn(async (): Promise<TopUserRow[]> => [
        { authorId: 'a1', authorName: 'Ada', count: 1 },
        { authorId: 'a2', authorName: 'Bea', count: 2 },
      ]),
    });
    const service = createStatsService({ statsRepo });

    await expect(service.getStats('user-1', ['chan-1'], NOW)).rejects.toThrow();
  });
});
