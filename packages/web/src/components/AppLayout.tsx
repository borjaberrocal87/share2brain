// Authenticated app shell (Story 2.2, AC2 + AC5). Outer flex row: Sidebar +
// a content column (Header on top, scrollable content below). The content
// area renders Search (4.3), Documentos (4.4), or Estadísticas (9.2) per the
// active screen.
import type { CSSProperties, ReactElement } from 'react';

import type { UnreadCountResponse } from '@hivly/shared/schemas';

import { DocsView } from './DocsView';
import { Header } from './Header';
import { SearchView } from './SearchView';
import { Sidebar, type Screen } from './Sidebar';
import { StatsView } from './StatsView';
import type { Theme } from '../hooks/useTheme';

interface AppLayoutProps {
  activeScreen: Screen;
  onNavigate: (screen: Screen) => void;
  communityName: string;
  statsLine: string;
  user: { name: string; initials: string };
  theme: Theme;
  onToggleTheme: () => void;
  onLogout: () => void;
  guildId: string;
  /** Total unread count across all allowed channels — drives the sidebar badge (AC7). */
  unreadCount: number;
  /** Per-channel unread map — drives the Documentos view's "Sin leer · N" + mark-all (AC4/AC6). */
  unreadCounts: UnreadCountResponse;
  /** Re-fetch the unread map after a mark-read/mark-all action. */
  onUnreadChange: () => void;
}

const shellStyle: CSSProperties = {
  display: 'flex',
  height: '100vh',
  width: '100vw',
  overflow: 'hidden',
};

const contentColumnStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
};

export function AppLayout({
  activeScreen,
  onNavigate,
  communityName,
  statsLine,
  user,
  theme,
  onToggleTheme,
  onLogout,
  guildId,
  unreadCount,
  unreadCounts,
  onUnreadChange,
}: AppLayoutProps): ReactElement {
  return (
    <div style={shellStyle}>
      <Sidebar activeScreen={activeScreen} onNavigate={onNavigate} unreadCount={unreadCount} />

      <div style={contentColumnStyle}>
        <Header
          communityName={communityName}
          statsLine={statsLine}
          user={user}
          theme={theme}
          onToggleTheme={onToggleTheme}
          onLogout={onLogout}
        />

        {activeScreen === 'search' ? (
          <SearchView guildId={guildId} />
        ) : activeScreen === 'docs' ? (
          <DocsView unreadCounts={unreadCounts} onUnreadChange={onUnreadChange} />
        ) : (
          <StatsView />
        )}
      </div>
    </div>
  );
}
