// Estadísticas view (Story 9.2, AC1-8). KPI cards, 14-day indexing activity,
// per-channel volume, personal read coverage, and the Top 5 most active users
// — all RBAC-scoped server-side (AD-12), rendered verbatim from GET
// /api/stats (D1: KPI label/sub content is API-owned, never hardcoded here).
// No router (UX-DR5) — third AppLayout screen-branch. No chart dependency:
// plain flex/grid + CSS gradients (linear/conic), mirroring SearchView's
// fetch-on-mount + AbortController pattern.
import { useEffect, useState } from 'react';
import type { CSSProperties, ReactElement } from 'react';

import type { StatsActivityPoint, StatsChannel, StatsCoverage, StatsKpi, StatsResponse, StatsTopUser } from '@hivly/shared/schemas';

import { fetchStats } from '../api/stats';

type Status = 'loading' | 'done' | 'error';

const containerStyle: CSSProperties = { flex: 1, overflowY: 'auto', padding: '34px 40px 60px' };
const innerStyle: CSSProperties = { maxWidth: 1040, margin: '0 auto' };

const sectionCardStyle: CSSProperties = {
  padding: '22px 24px',
  background: 'var(--surface)',
  borderRadius: 16,
  border: '1px solid var(--border)',
};

const sectionTitleStyle: CSSProperties = {
  margin: 0,
  fontFamily: "'Space Grotesk', sans-serif",
  fontWeight: 600,
  fontSize: 16,
  color: 'var(--text-primary)',
};

const monoMutedStyle: CSSProperties = {
  fontFamily: "'IBM Plex Mono', monospace",
  fontSize: 12,
  color: 'var(--text-muted)',
};

// D4: 6-color avatar palette (mock-verbatim), deterministically hashed over authorId.
const AVATAR_PALETTE = ['#F2A03D', '#5BC0DE', '#C792EA', '#57C98A', '#EE6C8A', '#F5A623'];

function avatarColor(authorId: string): string {
  let sum = 0;
  for (let i = 0; i < authorId.length; i++) sum += authorId.charCodeAt(i);
  return AVATAR_PALETTE[sum % AVATAR_PALETTE.length];
}

// D4: split on [_- ], first char of first two parts uppercased; single part → first 2 chars.
function statsInitials(authorName: string): string {
  const parts = authorName.split(/[_\- ]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0].charAt(0) + parts[1].charAt(0)).toUpperCase();
  return (parts[0] ?? authorName).slice(0, 2).toUpperCase();
}

// D1: KPI glyph paths extracted verbatim from the mock (17px, viewBox 24, stroke 1.9).
const KPI_ICON_PATHS: Record<StatsKpi['key'], ReactElement> = {
  resources: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
  channels: <path d="M4 9h16M4 15h16M10 3L8 21M16 3l-2 18" />,
  authors: (
    <>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13A4 4 0 0 1 16 11" />
    </>
  ),
  queries: <path d="M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z" />,
};

function KpiIcon({ kpiKey }: { kpiKey: StatsKpi['key'] }): ReactElement {
  return (
    <svg
      width={17}
      height={17}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {KPI_ICON_PATHS[kpiKey]}
    </svg>
  );
}

export function StatsView(): ReactElement {
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [status, setStatus] = useState<Status>('loading');

  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    fetchStats(controller.signal)
      .then((res) => {
        setStats(res);
        setStatus('done');
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setStatus('error');
      });

    return () => {
      controller.abort();
    };
  }, []);

  return (
    <div style={containerStyle}>
      <div style={innerStyle}>
        <h2
          style={{
            margin: 0,
            fontFamily: "'Space Grotesk', sans-serif",
            fontWeight: 600,
            fontSize: 25,
            letterSpacing: '-0.02em',
            color: 'var(--text-primary)',
          }}
        >
          Estadísticas
        </h2>
        <p style={{ margin: '7px 0 0', fontSize: 14, color: 'var(--text-tertiary)' }}>
          El pulso del conocimiento de la comunidad: qué se indexa, quién participa y cuánto se
          consulta al agente.
        </p>

        {status === 'loading' && (
          <div data-testid="stats-loading" style={{ marginTop: 24, ...monoMutedStyle }}>
            Cargando estadísticas…
          </div>
        )}

        {status === 'error' && (
          <div data-testid="stats-error" style={{ marginTop: 24, fontSize: 14, color: 'var(--text-tertiary)' }}>
            No se pudieron cargar las estadísticas. Reintentá.
          </div>
        )}

        {status === 'done' && stats && (
          <>
            <KpiGrid kpis={stats.kpis} />
            <ActivityChart activity={stats.activity} />
            <div
              style={{
                marginTop: 22,
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))',
                gap: 18,
                alignItems: 'start',
              }}
            >
              <ChannelsCard channels={stats.channels} />
              <CoverageCard coverage={stats.coverage} />
            </div>
            <TopUsersCard topUsers={stats.topUsers} />
          </>
        )}
      </div>
    </div>
  );
}

function KpiGrid({ kpis }: { kpis: StatsKpi[] }): ReactElement {
  return (
    <div
      style={{
        marginTop: 24,
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit,minmax(210px,1fr))',
        gap: 14,
      }}
    >
      {kpis.map((kpi) => (
        <div
          key={kpi.key}
          data-testid="stats-kpi-card"
          data-kpi={kpi.key}
          style={{
            padding: '18px 20px',
            borderRadius: 14,
            background: 'var(--surface)',
            border: '1px solid var(--border)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>{kpi.label}</span>
            <span
              style={{
                width: 32,
                height: 32,
                borderRadius: 9,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--accent-ink)',
                background: 'rgba(245,166,35,0.12)',
              }}
            >
              <KpiIcon kpiKey={kpi.key} />
            </span>
          </div>
          <div
            style={{
              marginTop: 12,
              fontFamily: "'Space Grotesk', sans-serif",
              fontWeight: 700,
              fontSize: 29,
              letterSpacing: '-0.01em',
              color: 'var(--text-primary)',
            }}
          >
            {kpi.value.toLocaleString('es')}
          </div>
          <div style={{ marginTop: 4, fontSize: 12, color: 'var(--text-muted)' }}>{kpi.sub}</div>
        </div>
      ))}
    </div>
  );
}

function ActivityChart({ activity }: { activity: StatsActivityPoint[] }): ReactElement {
  const total = activity.reduce((sum, a) => sum + a.count, 0);
  const maxCount = Math.max(1, ...activity.map((a) => a.count)); // D6: zero-safe divisor
  const lastIndex = activity.length - 1;

  return (
    <div data-testid="stats-activity-chart" style={{ marginTop: 22, ...sectionCardStyle }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={sectionTitleStyle}>Actividad de indexado</h3>
        <span
          data-testid="stats-activity-total"
          style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11.5, color: 'var(--text-muted)' }}
        >
          {total.toLocaleString('es')} recursos · últimos 14 días
        </span>
      </div>

      <div style={{ marginTop: 22, display: 'flex', alignItems: 'flex-end', gap: 8, height: 180 }}>
        {activity.map((point, i) => {
          const pct = Math.round((point.count / maxCount) * 100);
          return (
            <div
              key={point.date}
              data-testid="stats-activity-bar"
              title={`${point.count.toLocaleString('es')} recursos`}
              style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: '100%' }}
            >
              <div
                style={{
                  width: '100%',
                  height: `${pct}%`,
                  minHeight: 4,
                  borderRadius: '5px 5px 3px 3px',
                  background: i === lastIndex ? 'linear-gradient(180deg,#FFCB6B,#F5A623)' : 'var(--track)',
                }}
              />
            </div>
          );
        })}
      </div>

      <div
        style={{
          marginTop: 10,
          display: 'flex',
          justifyContent: 'space-between',
          fontFamily: "'IBM Plex Mono', monospace",
          fontSize: 10.5,
          color: 'var(--text-subtle)',
        }}
      >
        <span>hace 14 días</span>
        <span>hoy</span>
      </div>
    </div>
  );
}

function ChannelsCard({ channels }: { channels: StatsChannel[] }): ReactElement {
  const maxCount = Math.max(1, ...channels.map((c) => c.count)); // D6: zero-safe divisor

  return (
    <div style={sectionCardStyle}>
      <h3 style={sectionTitleStyle}>Recursos por canal</h3>

      {channels.length === 0 ? (
        <div data-testid="stats-channels-empty" style={{ marginTop: 18, ...monoMutedStyle }}>
          Sin datos en tus canales todavía.
        </div>
      ) : (
        <div style={{ marginTop: 18, display: 'flex', flexDirection: 'column', gap: 15 }}>
          {channels.map((ch) => {
            const pct = Math.round((ch.count / maxCount) * 100);
            return (
              <div key={ch.channelId} data-testid="stats-channel-row">
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 7 }}>
                  <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12.5, color: 'var(--accent-ink)' }}>
                    #{ch.channelName}
                  </span>
                  <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: 'var(--text-tertiary)' }}>
                    {ch.count.toLocaleString('es')}
                  </span>
                </div>
                <div style={{ height: 9, borderRadius: 5, background: 'var(--track)', overflow: 'hidden' }}>
                  <div
                    style={{
                      height: '100%',
                      width: `${pct}%`,
                      borderRadius: 5,
                      background: 'linear-gradient(90deg,#F5A623,#FFCB6B)',
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CoverageCard({ coverage }: { coverage: StatsCoverage }): ReactElement {
  const { readCount, totalCount, readPct } = coverage;
  const unread = totalCount - readCount;

  return (
    <div style={sectionCardStyle}>
      <h3 style={sectionTitleStyle}>Cobertura de lectura</h3>
      <p style={{ margin: '6px 0 0', fontSize: 12.5, color: 'var(--text-muted)' }}>
        Documentos indexados que ya revisaste.
      </p>

      <div style={{ marginTop: 18, display: 'flex', alignItems: 'center', gap: 24 }}>
        <div
          data-testid="stats-coverage-donut"
          style={{
            position: 'relative',
            width: 120,
            height: 120,
            borderRadius: '50%',
            background: `conic-gradient(#F5A623 ${readPct}%, var(--track) 0)`,
          }}
        >
          <div
            style={{
              position: 'absolute',
              inset: 14,
              borderRadius: '50%',
              background: 'var(--surface)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <span
              style={{
                fontFamily: "'Space Grotesk', sans-serif",
                fontWeight: 700,
                fontSize: 23,
                color: 'var(--text-primary)',
              }}
            >
              {readPct}%
            </span>
            <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>leído</span>
          </div>
        </div>

        <div data-testid="stats-coverage-legend" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <LegendRow color="#F5A623" label="Leídos" value={readCount} />
          <LegendRow color="var(--track)" label="Sin leer" value={unread} />
        </div>
      </div>

      <div
        style={{
          marginTop: 2,
          fontFamily: "'IBM Plex Mono', monospace",
          fontSize: 11,
          color: 'var(--text-subtle)',
        }}
      >
        {totalCount.toLocaleString('es')} documentos en total
      </div>
    </div>
  );
}

function LegendRow({ color, label, value }: { color: string; label: string; value: number }): ReactElement {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 13, color: 'var(--text-secondary)' }}>
      <span style={{ width: 11, height: 11, borderRadius: 3, background: color }} />
      <span>
        {label} · <strong style={{ color: 'var(--text-primary)' }}>{value.toLocaleString('es')}</strong>
      </span>
    </div>
  );
}

function TopUsersCard({ topUsers }: { topUsers: StatsTopUser[] }): ReactElement {
  const topCount = Math.max(1, topUsers[0]?.count ?? 1); // D6: zero-safe divisor

  return (
    <div style={{ marginTop: 22, ...sectionCardStyle }}>
      <h3 style={sectionTitleStyle}>Top 5 · usuarios más activos</h3>

      {topUsers.length === 0 ? (
        <div data-testid="stats-top-users-empty" style={{ marginTop: 18, ...monoMutedStyle }}>
          Sin autores todavía.
        </div>
      ) : (
        <div style={{ marginTop: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {topUsers.map((user, i) => {
            const pct = Math.round((user.count / topCount) * 100);
            return (
              <div key={user.authorId} data-testid="stats-top-user-row" style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <span
                  style={{
                    fontFamily: "'IBM Plex Mono', monospace",
                    fontSize: 12,
                    color: 'var(--text-subtle)',
                    width: 16,
                    textAlign: 'center',
                    flexShrink: 0,
                  }}
                >
                  {i + 1}
                </span>
                <div
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: '50%',
                    flexShrink: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 11,
                    fontWeight: 600,
                    color: 'var(--on-accent)',
                    background: avatarColor(user.authorId),
                  }}
                >
                  {statsInitials(user.authorName)}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                    <span style={{ fontSize: 13.5, color: 'var(--text-primary)' }}>{user.authorName}</span>
                    <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: 'var(--text-tertiary)' }}>
                      {user.count.toLocaleString('es')}
                    </span>
                  </div>
                  <div style={{ height: 7, borderRadius: 4, background: 'var(--track)', overflow: 'hidden' }}>
                    <div
                      style={{
                        height: '100%',
                        width: `${pct}%`,
                        borderRadius: 4,
                        background: 'linear-gradient(90deg,#5865F2,#8891F5)',
                      }}
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
