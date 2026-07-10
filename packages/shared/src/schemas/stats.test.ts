import { describe, expect, it } from 'vitest';

import {
  STATS_ERROR,
  StatsActivityPointSchema,
  StatsChannelSchema,
  StatsCoverageSchema,
  StatsKpiSchema,
  StatsResponseSchema,
  StatsTopUserSchema,
} from './stats.js';

describe('StatsKpiSchema', () => {
  const valid = { key: 'resources', label: 'Recursos indexados', value: 42, sub: '+3 esta semana' };

  it('should parse a fully-populated kpi', () => {
    expect(StatsKpiSchema.safeParse(valid).success).toBe(true);
  });

  it('should reject an unknown key', () => {
    expect(StatsKpiSchema.safeParse({ ...valid, key: 'bogus' }).success).toBe(false);
  });

  it.each(['resources', 'channels', 'authors', 'queries'])('should accept key %s', (key) => {
    expect(StatsKpiSchema.safeParse({ ...valid, key }).success).toBe(true);
  });

  it('should reject an empty label', () => {
    expect(StatsKpiSchema.safeParse({ ...valid, label: '' }).success).toBe(false);
  });

  it('should reject a negative value', () => {
    expect(StatsKpiSchema.safeParse({ ...valid, value: -1 }).success).toBe(false);
  });

  it('should reject a non-integer value', () => {
    expect(StatsKpiSchema.safeParse({ ...valid, value: 1.5 }).success).toBe(false);
  });

  it('should accept a zero value', () => {
    expect(StatsKpiSchema.safeParse({ ...valid, value: 0 }).success).toBe(true);
  });

  it('should accept an empty sub string', () => {
    expect(StatsKpiSchema.safeParse({ ...valid, sub: '' }).success).toBe(true);
  });

  it('should reject a fragment missing a required field', () => {
    const missing: Record<string, unknown> = { ...valid };
    delete missing.value;
    expect(StatsKpiSchema.safeParse(missing).success).toBe(false);
  });
});

describe('StatsActivityPointSchema', () => {
  const valid = { date: '2026-07-10', count: 5 };

  it('should parse a fully-populated activity point', () => {
    expect(StatsActivityPointSchema.safeParse(valid).success).toBe(true);
  });

  it('should accept a zero count', () => {
    expect(StatsActivityPointSchema.safeParse({ ...valid, count: 0 }).success).toBe(true);
  });

  it('should reject a negative count', () => {
    expect(StatsActivityPointSchema.safeParse({ ...valid, count: -1 }).success).toBe(false);
  });

  it('should reject a non-integer count', () => {
    expect(StatsActivityPointSchema.safeParse({ ...valid, count: 1.5 }).success).toBe(false);
  });

  it('should reject a malformed date', () => {
    expect(StatsActivityPointSchema.safeParse({ ...valid, date: '2026/07/10' }).success).toBe(
      false,
    );
  });

  it('should reject a date missing zero-padding', () => {
    expect(StatsActivityPointSchema.safeParse({ ...valid, date: '2026-7-10' }).success).toBe(
      false,
    );
  });
});

describe('StatsChannelSchema', () => {
  const valid = { channelId: '1234567890', channelName: 'general', count: 7 };

  it('should parse a fully-populated channel row', () => {
    expect(StatsChannelSchema.safeParse(valid).success).toBe(true);
  });

  it('should reject an empty channelId', () => {
    expect(StatsChannelSchema.safeParse({ ...valid, channelId: '' }).success).toBe(false);
  });

  it('should accept an empty channelName', () => {
    expect(StatsChannelSchema.safeParse({ ...valid, channelName: '' }).success).toBe(true);
  });

  it('should reject a negative count', () => {
    expect(StatsChannelSchema.safeParse({ ...valid, count: -1 }).success).toBe(false);
  });
});

describe('StatsCoverageSchema', () => {
  const valid = { readCount: 3, totalCount: 10, readPct: 30 };

  it('should parse a fully-populated coverage block', () => {
    expect(StatsCoverageSchema.safeParse(valid).success).toBe(true);
  });

  it('should reject a negative readCount', () => {
    expect(StatsCoverageSchema.safeParse({ ...valid, readCount: -1 }).success).toBe(false);
  });

  it('should reject a negative totalCount', () => {
    expect(StatsCoverageSchema.safeParse({ ...valid, totalCount: -1 }).success).toBe(false);
  });

  it('should accept readPct boundary 0', () => {
    expect(StatsCoverageSchema.safeParse({ ...valid, readPct: 0 }).success).toBe(true);
  });

  it('should accept readPct boundary 100', () => {
    expect(StatsCoverageSchema.safeParse({ ...valid, readPct: 100 }).success).toBe(true);
  });

  it('should reject readPct above 100', () => {
    expect(StatsCoverageSchema.safeParse({ ...valid, readPct: 101 }).success).toBe(false);
  });

  it('should reject a negative readPct', () => {
    expect(StatsCoverageSchema.safeParse({ ...valid, readPct: -1 }).success).toBe(false);
  });

  it('should reject a non-integer readPct', () => {
    expect(StatsCoverageSchema.safeParse({ ...valid, readPct: 33.3 }).success).toBe(false);
  });
});

describe('StatsTopUserSchema', () => {
  const valid = { authorId: 'author-1', authorName: 'Ada Lovelace', count: 3 };

  it('should parse a fully-populated top user row', () => {
    expect(StatsTopUserSchema.safeParse(valid).success).toBe(true);
  });

  it('should reject an empty authorId', () => {
    expect(StatsTopUserSchema.safeParse({ ...valid, authorId: '' }).success).toBe(false);
  });

  it('should reject an empty authorName', () => {
    expect(StatsTopUserSchema.safeParse({ ...valid, authorName: '' }).success).toBe(false);
  });

  it('should reject a zero count', () => {
    expect(StatsTopUserSchema.safeParse({ ...valid, count: 0 }).success).toBe(false);
  });

  it('should reject a non-integer count', () => {
    expect(StatsTopUserSchema.safeParse({ ...valid, count: 1.5 }).success).toBe(false);
  });
});

describe('StatsResponseSchema', () => {
  const kpi = (key: string) => ({ key, label: key, value: 1, sub: '' });
  const topUser = (authorId: string, count: number) => ({
    authorId,
    authorName: `Author ${authorId}`,
    count,
  });
  const validResponse = {
    kpis: [kpi('resources'), kpi('channels'), kpi('authors'), kpi('queries')],
    activity: Array.from({ length: 14 }, (_, i) => ({
      date: `2026-07-${String(i + 1).padStart(2, '0')}`,
      count: i,
    })),
    channels: [{ channelId: 'c1', channelName: 'general', count: 5 }],
    coverage: { readCount: 1, totalCount: 2, readPct: 50 },
    topUsers: [
      topUser('a1', 5),
      topUser('a2', 4),
      topUser('a3', 3),
      topUser('a4', 2),
      topUser('a5', 1),
    ],
  };

  it('should parse a fully-populated response', () => {
    expect(StatsResponseSchema.safeParse(validResponse).success).toBe(true);
  });

  it('should reject when kpis has fewer than 4 entries', () => {
    expect(
      StatsResponseSchema.safeParse({ ...validResponse, kpis: validResponse.kpis.slice(0, 3) })
        .success,
    ).toBe(false);
  });

  it('should reject when kpis has more than 4 entries', () => {
    expect(
      StatsResponseSchema.safeParse({
        ...validResponse,
        kpis: [...validResponse.kpis, kpi('resources')],
      }).success,
    ).toBe(false);
  });

  it('should reject when the 4 kpis are in the wrong order', () => {
    expect(
      StatsResponseSchema.safeParse({
        ...validResponse,
        kpis: [kpi('channels'), kpi('resources'), kpi('authors'), kpi('queries')],
      }).success,
    ).toBe(false);
  });

  it('should reject when a kpi key is duplicated (breaking the fixed order)', () => {
    expect(
      StatsResponseSchema.safeParse({
        ...validResponse,
        kpis: [kpi('resources'), kpi('resources'), kpi('authors'), kpi('queries')],
      }).success,
    ).toBe(false);
  });

  it('should reject when activity has fewer than 14 entries', () => {
    expect(
      StatsResponseSchema.safeParse({ ...validResponse, activity: validResponse.activity.slice(0, 13) })
        .success,
    ).toBe(false);
  });

  it('should reject when activity has more than 14 entries', () => {
    expect(
      StatsResponseSchema.safeParse({
        ...validResponse,
        activity: [...validResponse.activity, { date: '2026-07-15', count: 0 }],
      }).success,
    ).toBe(false);
  });

  it('should accept an empty channels array', () => {
    expect(StatsResponseSchema.safeParse({ ...validResponse, channels: [] }).success).toBe(true);
  });

  it('should reject when topUsers is missing', () => {
    const missing: Record<string, unknown> = { ...validResponse };
    delete missing.topUsers;
    expect(StatsResponseSchema.safeParse(missing).success).toBe(false);
  });

  it('should accept an empty topUsers array', () => {
    expect(StatsResponseSchema.safeParse({ ...validResponse, topUsers: [] }).success).toBe(true);
  });

  it('should reject when topUsers has more than 5 entries', () => {
    expect(
      StatsResponseSchema.safeParse({
        ...validResponse,
        topUsers: [...validResponse.topUsers, topUser('a6', 1)],
      }).success,
    ).toBe(false);
  });

  it('should reject when topUsers is not ordered count DESC', () => {
    expect(
      StatsResponseSchema.safeParse({
        ...validResponse,
        topUsers: [topUser('a1', 1), topUser('a2', 5)],
      }).success,
    ).toBe(false);
  });

  it('should reject when equal-count rows are not ordered authorId ASC', () => {
    expect(
      StatsResponseSchema.safeParse({
        ...validResponse,
        topUsers: [topUser('b', 2), topUser('a', 2)],
      }).success,
    ).toBe(false);
  });

  it('should accept equal-count rows ordered authorId ASC', () => {
    expect(
      StatsResponseSchema.safeParse({
        ...validResponse,
        topUsers: [topUser('a', 2), topUser('b', 2)],
      }).success,
    ).toBe(true);
  });
});

describe('STATS_ERROR', () => {
  it('should expose the stable stats error codes', () => {
    expect(STATS_ERROR.INTERNAL).toBe('INTERNAL');
  });
});
