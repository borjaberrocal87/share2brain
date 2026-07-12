// Sidebar (Story 2.2, AC3 + AC5). Logo + wordmark, three nav items with
// active/inactive styling, a flexible spacer, the system-status panel, and a
// footer. Navigation is in-app state (no router — UX-DR5); clicking an item
// calls onNavigate. UI copy Spanish verbatim; identifiers English.
import type { CSSProperties, ReactElement } from 'react';
import { useTranslation } from 'react-i18next';

import { DocsIcon, SearchIcon, StatsIcon } from './icons';
import { Hexagon } from './Hexagon';

export type Screen = 'search' | 'docs' | 'stats';

interface SidebarProps {
  activeScreen: Screen;
  onNavigate: (screen: Screen) => void;
  /** Documentos badge count; 0 (default) renders no badge. */
  unreadCount?: number;
}

const asideStyle: CSSProperties = {
  width: 236,
  flexShrink: 0,
  display: 'flex',
  flexDirection: 'column',
  background: 'var(--bg-deep)',
  borderRight: '1px solid var(--line)',
  padding: '18px 14px',
};

// Base nav-item layout; active/inactive background + color come from the CSS
// classes (kh-nav-item / kh-nav-item--active) so :hover works.
const navItemStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  width: '100%',
  padding: '10px 12px',
  border: 'none',
  borderRadius: 10,
  cursor: 'pointer',
  fontSize: 14,
  fontWeight: 500,
  textAlign: 'left',
  transition: 'background .12s ease',
};

const iconSpanStyle: CSSProperties = { display: 'flex', width: 18, justifyContent: 'center' };

const badgeStyle: CSSProperties = {
  marginLeft: 'auto',
  minWidth: 18,
  height: 18,
  padding: '0 5px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontFamily: "'IBM Plex Mono', monospace",
  fontSize: 10.5,
  fontWeight: 600,
  color: 'var(--on-accent)',
  background: '#F5A623',
  borderRadius: 9,
};

const statusRowStyle: CSSProperties = { display: 'flex', justifyContent: 'space-between' };

// D9 trap: this is evaluated at import time, before main.tsx resolves the
// boot language — labels are translation KEYS, resolved at render (below),
// never plain text here.
const NAV_ITEMS: {
  screen: Screen;
  labelKey: 'sidebar.nav.search' | 'sidebar.nav.docs' | 'sidebar.nav.stats';
  icon: ReactElement;
}[] = [
  { screen: 'search', labelKey: 'sidebar.nav.search', icon: <SearchIcon size={18} /> },
  { screen: 'docs', labelKey: 'sidebar.nav.docs', icon: <DocsIcon size={18} /> },
  { screen: 'stats', labelKey: 'sidebar.nav.stats', icon: <StatsIcon size={18} /> },
];

export function Sidebar({ activeScreen, onNavigate, unreadCount = 0 }: SidebarProps): ReactElement {
  const { t } = useTranslation();
  return (
    <aside style={asideStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '6px 8px 18px' }}>
        <Hexagon size={32} innerBg="bg-deep" />
        <div
          style={{
            fontFamily: "'Space Grotesk', sans-serif",
            fontWeight: 700,
            fontSize: 17,
            letterSpacing: '-0.01em',
          }}
        >
          Share2Brain
        </div>
      </div>

      <nav style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 6 }}>
        {NAV_ITEMS.map(({ screen, labelKey, icon }) => {
          const active = screen === activeScreen;
          return (
            <button
              key={screen}
              type="button"
              className={active ? 'kh-nav-item kh-nav-item--active' : 'kh-nav-item'}
              aria-current={active ? 'page' : undefined}
              onClick={() => onNavigate(screen)}
              style={navItemStyle}
            >
              <span style={iconSpanStyle}>{icon}</span>
              {t(labelKey)}
              {screen === 'docs' && unreadCount > 0 && (
                <span data-testid="sidebar-badge" style={badgeStyle}>
                  {unreadCount}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div style={{ flex: 1 }} />

      <div
        style={{
          padding: 13,
          border: '1px solid var(--border)',
          borderRadius: 12,
          background: 'var(--surface)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: '#3BA55D',
              boxShadow: '0 0 0 3px rgba(59,165,93,0.18)',
            }}
          />
          <span
            style={{
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: 11,
              color: 'var(--text-tertiary)',
            }}
          >
            share2brain.config.yml
          </span>
        </div>

        <div
          style={{
            marginTop: 9,
            display: 'flex',
            flexDirection: 'column',
            gap: 5,
            fontSize: 11.5,
            color: 'var(--text-muted)',
          }}
        >
          <div style={statusRowStyle}>
            <span>indexer</span>
            <span style={{ color: '#3BA55D' }}>running</span>
          </div>
          <div style={statusRowStyle}>
            <span>redis stream</span>
            <span style={{ color: '#3BA55D' }}>ok</span>
          </div>
          <div style={statusRowStyle}>
            <span>pgvector</span>
            <span style={{ color: '#3BA55D' }}>ok</span>
          </div>
        </div>
      </div>

      <div
        style={{
          marginTop: 12,
          textAlign: 'center',
          fontFamily: "'IBM Plex Mono', monospace",
          fontSize: 10,
          color: 'var(--text-subtle)',
          letterSpacing: '0.05em',
        }}
      >
        self-hosted · open source
      </div>
    </aside>
  );
}
