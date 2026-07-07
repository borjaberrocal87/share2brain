// Header (Story 2.2, AC4 + AC6 + AC7). Left: Discord icon + community name,
// separator, stats line. Right: live-indexing badge, user avatar + name, theme
// toggle, logout. The theme button shows a sun while dark is active (click ->
// light) and a moon while light is active. UI copy Spanish verbatim.
import type { CSSProperties, ReactElement } from 'react';

import { DiscordIcon, LogoutIcon, MoonIcon, SunIcon } from './icons';
import type { Theme } from '../hooks/useTheme';

interface HeaderProps {
  communityName: string;
  statsLine: string;
  user: { name: string; initials: string };
  theme: Theme;
  onToggleTheme: () => void;
  onLogout: () => void;
}

const headerStyle: CSSProperties = {
  height: 62,
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '0 26px',
  borderBottom: '1px solid var(--line)',
  background: 'var(--bg)',
};

// Shared base for the two icon buttons; hover accents come from CSS classes.
const iconBtnStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 30,
  height: 30,
  border: '1px solid var(--border)',
  borderRadius: 8,
  background: 'transparent',
  color: 'var(--text-tertiary)',
  cursor: 'pointer',
};

export function Header({
  communityName,
  statsLine,
  user,
  theme,
  onToggleTheme,
  onLogout,
}: HeaderProps): ReactElement {
  return (
    <header style={headerStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <span style={{ color: '#5865F2', display: 'flex' }}>
            <DiscordIcon size={17} />
          </span>
          <span style={{ fontWeight: 600, fontSize: 15 }}>{communityName}</span>
        </div>
        <span style={{ width: 1, height: 18, background: 'var(--border-strong)' }} />
        <span
          style={{
            fontFamily: "'IBM Plex Mono', monospace",
            fontSize: 11.5,
            color: 'var(--text-muted)',
          }}
        >
          {statsLine}
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            padding: '5px 11px',
            border: '1px solid var(--border)',
            borderRadius: 999,
            background: 'var(--surface)',
          }}
        >
          <span
            aria-hidden="true"
            data-testid="live-pulse"
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: '#F5A623',
              animation: 'kh-pulse 1.6s ease-in-out infinite',
            }}
          />
          <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>indexando en vivo</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <span
            style={{
              width: 30,
              height: 30,
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 12,
              fontWeight: 600,
              color: '#fff',
              background: '#5865F2',
            }}
          >
            {user.initials}
          </span>
          <span style={{ fontSize: 13.5, color: 'var(--text-secondary)' }}>{user.name}</span>

          <button
            type="button"
            className="kh-icon-btn"
            onClick={onToggleTheme}
            title={theme === 'dark' ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro'}
            aria-label={theme === 'dark' ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro'}
            style={iconBtnStyle}
          >
            {theme === 'dark' ? <SunIcon size={16} /> : <MoonIcon size={16} />}
          </button>

          <button
            type="button"
            className="kh-icon-btn kh-logout-btn"
            onClick={onLogout}
            title="Cerrar sesión"
            aria-label="Cerrar sesión"
            style={iconBtnStyle}
          >
            <LogoutIcon size={15} />
          </button>
        </div>
      </div>
    </header>
  );
}
