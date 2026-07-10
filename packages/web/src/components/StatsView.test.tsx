// Component tests for StatsView (Story 9.2, AC2-AC8). Mocks api/stats
// (mirror DocsView.test.tsx) — no network, no jest-dom matchers
// (toBeTruthy()/toBeNull(), per project testing rules). jsdom can't compute
// conic-gradient/layout, so bar/donut assertions read the inline style string
// (8.1-documented workaround) — computed-style truth is Story 9.3's Playwright
// harness.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { StatsResponse } from '@hivly/shared/schemas';

import * as statsApi from '../api/stats';
import { StatsView } from './StatsView';

vi.mock('../api/stats', () => ({ fetchStats: vi.fn() }));

const fetchStats = vi.mocked(statsApi.fetchStats);

const FULL_STATS: StatsResponse = {
  kpis: [
    { key: 'resources', label: 'Recursos indexados', value: 12847, sub: '+312 esta semana' },
    { key: 'channels', label: 'Canales', value: 6, sub: 'de 8 accesibles' },
    { key: 'authors', label: 'Autores', value: 24, sub: 'en tus canales' },
    { key: 'queries', label: 'Tus consultas al agente', value: 7, sub: 'últimos 30 días' },
  ],
  activity: Array.from({ length: 14 }, (_, i) => ({
    date: `2026-07-${String(i + 1).padStart(2, '0')}`,
    count: i === 13 ? 40 : i + 1,
  })),
  channels: [
    { channelId: 'chan-general', channelName: 'general', count: 50 },
    { channelId: 'chan-random', channelName: 'random', count: 10 },
  ],
  coverage: { readCount: 3, totalCount: 12, readPct: 25 },
  topUsers: [
    { authorId: 'user-1', authorName: 'ada_lovelace', count: 42 },
    { authorId: 'user-2', authorName: '123456789012345678', count: 10 },
  ],
};

const EMPTY_STATS: StatsResponse = {
  kpis: [
    { key: 'resources', label: 'Recursos indexados', value: 0, sub: '+0 esta semana' },
    { key: 'channels', label: 'Canales', value: 0, sub: 'de 0 accesibles' },
    { key: 'authors', label: 'Autores', value: 0, sub: 'en tus canales' },
    { key: 'queries', label: 'Tus consultas al agente', value: 0, sub: 'últimos 30 días' },
  ],
  activity: Array.from({ length: 14 }, (_, i) => ({ date: `2026-07-${String(i + 1).padStart(2, '0')}`, count: 0 })),
  channels: [],
  coverage: { readCount: 0, totalCount: 0, readPct: 0 },
  topUsers: [],
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('StatsView', () => {
  it('should render the header and a loading state before the fetch resolves (AC2, AC7)', () => {
    fetchStats.mockReturnValue(new Promise(() => {})); // never resolves

    render(<StatsView />);

    expect(screen.getByText('Estadísticas')).toBeTruthy();
    expect(screen.getByTestId('stats-loading').textContent).toBe('Cargando estadísticas…');
  });

  it('should render all 4 KPI cards with the API-provided label/value/sub verbatim (AC2, D1)', async () => {
    fetchStats.mockResolvedValue(FULL_STATS);

    render(<StatsView />);

    const cards = await screen.findAllByTestId('stats-kpi-card');
    expect(cards.length).toBe(4);
    expect(cards.map((c) => c.getAttribute('data-kpi'))).toEqual(['resources', 'channels', 'authors', 'queries']);
    expect(screen.getByText('Recursos indexados')).toBeTruthy();
    expect(screen.getByText('12.847')).toBeTruthy();
    expect(screen.getByText('+312 esta semana')).toBeTruthy();
    expect(screen.getByText('de 8 accesibles')).toBeTruthy();
    expect(screen.getByText('últimos 30 días')).toBeTruthy();
  });

  it('should render the 14-bar activity chart with the today bar highlighted (AC2)', async () => {
    fetchStats.mockResolvedValue(FULL_STATS);

    render(<StatsView />);

    const bars = await screen.findAllByTestId('stats-activity-bar');
    expect(bars.length).toBe(14);
    // Sum of counts: 1+2+...+13 (index 0..12) + 40 (today) = 91 + 40 = 131.
    expect(screen.getByTestId('stats-activity-total').textContent).toBe('131 recursos · últimos 14 días');

    // jsdom normalizes hex colors to rgb() when serializing inline styles.
    const todayFill = bars[13].firstElementChild as HTMLElement;
    expect(todayFill.getAttribute('style')).toContain('linear-gradient(180deg, rgb(255, 203, 107), rgb(245, 166, 35))');
    const otherFill = bars[0].firstElementChild as HTMLElement;
    expect(otherFill.getAttribute('style')).toContain('var(--track)');
  });

  it('should render channel rows in API order without re-sorting (AC2)', async () => {
    fetchStats.mockResolvedValue(FULL_STATS);

    render(<StatsView />);

    const rows = await screen.findAllByTestId('stats-channel-row');
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('#general');
    expect(rows[1].textContent).toContain('#random');
  });

  it('should render the coverage donut + legend from the API coverage block (AC2)', async () => {
    fetchStats.mockResolvedValue(FULL_STATS);

    render(<StatsView />);

    const donut = await screen.findByTestId('stats-coverage-donut');
    expect(donut.getAttribute('style')).toContain('conic-gradient(#F5A623 25%, var(--track) 0)');
    expect(screen.getByText('25%')).toBeTruthy();
    const legend = screen.getByTestId('stats-coverage-legend');
    expect(legend.textContent).toContain('Leídos');
    expect(legend.textContent).toContain('3');
    expect(legend.textContent).toContain('Sin leer');
    expect(legend.textContent).toContain('9');
    expect(screen.getByText('12 documentos en total')).toBeTruthy();
  });

  it('should render topUsers rows in API order (count DESC) with a blurple bar (AC3)', async () => {
    fetchStats.mockResolvedValue(FULL_STATS);

    render(<StatsView />);

    const rows = await screen.findAllByTestId('stats-top-user-row');
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('ada_lovelace');
    expect(rows[0].textContent).toContain('42');
    expect(rows[1].textContent).toContain('123456789012345678');
    const bar = rows[0].querySelector('div[style*="linear-gradient"]') as HTMLElement;
    expect(bar.getAttribute('style')).toContain('linear-gradient(90deg, rgb(88, 101, 242), rgb(136, 145, 245))');
  });

  it('should render a raw-snowflake authorName gracefully with its 2 leading digits as initials (AC3, D4)', async () => {
    fetchStats.mockResolvedValue(FULL_STATS);

    render(<StatsView />);

    const rows = await screen.findAllByTestId('stats-top-user-row');
    expect(rows[1].textContent).toContain('12'); // first 2 chars of the snowflake, uppercased is a no-op
  });

  it('should show inline empty lines for channels/topUsers and zero-safe bars/donut on an empty scope (AC7, D6)', async () => {
    fetchStats.mockResolvedValue(EMPTY_STATS);

    render(<StatsView />);

    expect(await screen.findByTestId('stats-channels-empty')).toBeTruthy();
    expect(screen.getByText('Sin datos en tus canales todavía.')).toBeTruthy();
    expect(screen.getByTestId('stats-top-users-empty')).toBeTruthy();
    expect(screen.getByText('Sin autores todavía.')).toBeTruthy();

    const bars = screen.getAllByTestId('stats-activity-bar');
    for (const bar of bars) {
      const fill = bar.firstElementChild as HTMLElement;
      expect(fill.getAttribute('style')).not.toContain('NaN');
      expect(fill.getAttribute('style')).toContain('height: 0%');
    }

    const donut = screen.getByTestId('stats-coverage-donut');
    expect(donut.getAttribute('style')).toContain('conic-gradient(#F5A623 0%, var(--track) 0)');
    expect(screen.getByText('0%')).toBeTruthy();
    expect(screen.getByText('0 documentos en total')).toBeTruthy();
  });

  it('should render the error state when the fetch fails (AC7)', async () => {
    fetchStats.mockRejectedValue(new Error('boom'));

    render(<StatsView />);

    expect(await screen.findByTestId('stats-error')).toBeTruthy();
    expect(screen.getByText('No se pudieron cargar las estadísticas. Reintentá.')).toBeTruthy();
  });

  it('should not show an error state on an aborted fetch (unmount mid-flight)', async () => {
    let rejectFetch: ((err: unknown) => void) | undefined;
    fetchStats.mockReturnValue(
      new Promise((_, reject) => {
        rejectFetch = reject;
      }),
    );

    const { unmount } = render(<StatsView />);
    unmount();
    rejectFetch?.(new DOMException('Aborted', 'AbortError'));

    await Promise.resolve();
    expect(screen.queryByTestId('stats-error')).toBeNull();
  });
});
