// Documentos view (Story 4.4, AC1-8). Browses every indexed fragment in a
// table, with server-side channel/unread filtering and pagination (D1 —
// /api/documents is paginated, so filtering must stay server-side to keep
// "Cargar más" coherent). No router (UX-DR5) — replaces the `docs` placeholder
// branch in AppLayout. No data library — useState + useEffect + fetch, mirroring
// SearchView.tsx.
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactElement } from 'react';
import { useTranslation } from 'react-i18next';

import type { Channel, DocumentFragment, UnreadCountResponse } from '@share2brain/shared/schemas';

import { fetchChannels } from '../api/channels';
import { fetchDocuments } from '../api/documents';
import { markAll, markRead } from '../api/readStatus';
import { authorColor } from '../lib/authorColor';
import { initialsFromUsername } from '../lib/initials';
import { CheckIcon, ExternalLinkIcon } from './icons';

interface DocsViewProps {
  unreadCounts: UnreadCountResponse;
  onUnreadChange: () => void;
}

type Status = 'idle' | 'loading' | 'error';

const PAGE_SIZE = 20;

const containerStyle: CSSProperties = { flex: 1, overflowY: 'auto', padding: '34px 40px 60px' };
const innerStyle: CSSProperties = { maxWidth: 980, margin: '0 auto' };

export function DocsView({ unreadCounts, onUnreadChange }: DocsViewProps): ReactElement {
  const { t } = useTranslation();
  const [docs, setDocs] = useState<DocumentFragment[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [activeChannelId, setActiveChannelId] = useState<'all' | string>('all');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [status, setStatus] = useState<Status>('idle');
  const [loadingMore, setLoadingMore] = useState(false);
  // Tracks the in-flight "Cargar más" request so a filter change can abort it —
  // otherwise a superseded page append lands on the new filter's list.
  const loadMoreControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let active = true;
    fetchChannels()
      .then((chs) => {
        if (active) setChannels(chs);
      })
      .catch(() => {
        // A failure just leaves the chips empty — don't block the view.
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    fetchDocuments(
      {
        page: 1,
        limit: PAGE_SIZE,
        channelId: activeChannelId === 'all' ? undefined : activeChannelId,
        unreadOnly: unreadOnly || undefined,
      },
      controller.signal,
    )
      .then((res) => {
        setDocs(res.results);
        setTotal(res.total);
        setPage(1);
        setStatus('idle');
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setStatus('error');
      });

    return () => {
      controller.abort();
      // Cancel any in-flight "Cargar más" from the previous filter so its page
      // append can't land on the new filter's list, and free the button.
      loadMoreControllerRef.current?.abort();
      loadMoreControllerRef.current = null;
      setLoadingMore(false);
    };
  }, [activeChannelId, unreadOnly]);

  function loadMore(): void {
    // Block while page 1 of a filter change is still loading: `page` is stale
    // until it resolves, so a click here would fetch the wrong page and race
    // page 1 → missing/duplicate rows.
    if (loadingMore || status === 'loading') return;
    const controller = new AbortController();
    loadMoreControllerRef.current = controller;
    setLoadingMore(true);
    const nextPage = page + 1;
    fetchDocuments(
      {
        page: nextPage,
        limit: PAGE_SIZE,
        channelId: activeChannelId === 'all' ? undefined : activeChannelId,
        unreadOnly: unreadOnly || undefined,
      },
      controller.signal,
    )
      .then((res) => {
        setDocs((prev) => [...prev, ...res.results]);
        setPage(nextPage);
        setTotal(res.total);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        // A failed page fetch just leaves "Cargar más" clickable again.
      })
      .finally(() => {
        // Only the current request clears the flag — an aborted stale request
        // (ref already replaced/nulled by a filter change) must not touch it.
        if (loadMoreControllerRef.current === controller) setLoadingMore(false);
      });
  }

  function handleRowClick(doc: DocumentFragment): void {
    if (doc.isRead) return; // D2: one-way, already-read is a no-op.

    setDocs((prev) => prev.map((d) => (d.id === doc.id ? { ...d, isRead: true } : d)));
    markRead(doc.id)
      .then(() => onUnreadChange())
      .catch(() => {
        setDocs((prev) => prev.map((d) => (d.id === doc.id ? { ...d, isRead: false } : d)));
      });
  }

  function handleMarkAll(): void {
    const channelId = activeChannelId === 'all' ? undefined : activeChannelId;
    // Snapshot the prior read-state by id, so a failure reverts only these rows
    // (mirrors handleRowClick) without discarding a page appended by "Cargar más"
    // while the request was in flight. onUnreadChange alone only refreshes the
    // count map, leaving the rows falsely marked read.
    const priorRead = new Map(docs.map((d) => [d.id, d.isRead]));
    setDocs((prev) => prev.map((d) => ({ ...d, isRead: true })));
    markAll(channelId)
      .then(() => onUnreadChange())
      .catch(() => {
        setDocs((prev) =>
          prev.map((d) => (priorRead.has(d.id) ? { ...d, isRead: priorRead.get(d.id) ?? d.isRead } : d)),
        );
        onUnreadChange();
      });
  }

  // Local mirror of the server-side unread filter: an optimistic mark-read while
  // "Sin leer" is active drops the row immediately without a refetch.
  const visibleDocs = unreadOnly ? docs.filter((d) => !d.isRead) : docs;
  const scopeUnread =
    activeChannelId === 'all'
      ? Object.values(unreadCounts).reduce((a, b) => a + b, 0)
      : (unreadCounts[activeChannelId] ?? 0);
  const showEmptyState = unreadOnly && visibleDocs.length === 0 && status !== 'loading';

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
          {t('docs.title')}
        </h2>
        <p style={{ margin: '7px 0 0', fontSize: 14, color: 'var(--text-tertiary)' }}>
          {t('docs.description')}
        </p>

        <div
          style={{
            marginTop: 20,
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <ChannelChip label={t('common.all')} active={activeChannelId === 'all'} onClick={() => setActiveChannelId('all')} />
            {channels.map((ch) => (
              <ChannelChip
                key={ch.id}
                label={`#${ch.name}`}
                active={activeChannelId === ch.id}
                onClick={() => setActiveChannelId(ch.id)}
              />
            ))}
          </div>

          <div style={{ flex: 1, minWidth: 12 }} />

          {scopeUnread > 0 && (
            <button
              type="button"
              className="kh-mark-all"
              onClick={handleMarkAll}
              style={{
                padding: '7px 12px',
                border: '1px solid var(--border)',
                borderRadius: 999,
                background: 'transparent',
                color: 'var(--text-tertiary)',
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              {t('docs.markAllRead')}
            </button>
          )}

          <button
            type="button"
            className="kh-unread-toggle"
            onClick={() => setUnreadOnly((v) => !v)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              padding: '7px 14px',
              borderRadius: 999,
              cursor: 'pointer',
              fontSize: 12.5,
              fontWeight: 500,
              fontFamily: "'IBM Plex Mono', monospace",
              ...(unreadOnly
                ? {
                    background: 'rgba(245,166,35,0.14)',
                    border: '1px solid rgba(245,166,35,0.45)',
                    color: 'var(--accent-ink)',
                  }
                : {
                    background: 'var(--surface)',
                    border: '1px solid var(--border)',
                    color: 'var(--text-tertiary)',
                  }),
            }}
          >
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#F5A623' }} />
            {t('docs.unreadToggle', { count: scopeUnread })}
          </button>
        </div>

        {status === 'error' ? (
          <div style={{ marginTop: 24, fontSize: 14, color: 'var(--text-tertiary)' }}>
            {t('docs.loadError')}
          </div>
        ) : showEmptyState ? (
          <div
            data-testid="docs-empty-state"
            style={{
              marginTop: 20,
              textAlign: 'center',
              padding: '48px 20px',
              border: '1px dashed var(--border-strong)',
              borderRadius: 14,
            }}
          >
            <div
              data-testid="docs-empty-state-check"
              style={{
                margin: '0 auto 14px',
                width: 38,
                height: 38,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#3BA55D',
                background: 'rgba(59,165,93,0.12)',
                borderRadius: '50%',
              }}
            >
              <CheckIcon size={20} />
            </div>
            <div style={{ fontSize: 15, color: 'var(--text-primary)' }}>
              {t('docs.emptyStateTitle')}
            </div>
            <div style={{ marginTop: 6, fontSize: 13, color: 'var(--text-subtle)' }}>
              {t('docs.emptyStateDescription')}
            </div>
          </div>
        ) : (
          <div
            style={{
              marginTop: 20,
              border: '1px solid var(--border)',
              borderRadius: 14,
              overflowX: 'auto',
              background: 'var(--surface)',
            }}
          >
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(240px,1fr) 44px 92px 116px 84px',
                gap: 12,
                minWidth: 620,
                padding: '12px 20px',
                background: 'var(--bg)',
                borderBottom: '1px solid var(--border)',
                fontFamily: "'IBM Plex Mono', monospace",
                fontSize: 10.5,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                color: 'var(--text-subtle)',
              }}
            >
              <span>{t('docs.columns.document')}</span>
              <span>{t('docs.columns.link')}</span>
              <span>{t('docs.columns.channel')}</span>
              <span>{t('docs.columns.author')}</span>
              <span style={{ textAlign: 'right' }}>{t('docs.columns.indexed')}</span>
            </div>

            {visibleDocs.map((doc) => (
              <DocRow key={doc.id} doc={doc} onClick={() => handleRowClick(doc)} />
            ))}
          </div>
        )}

        {status !== 'error' && (
          <div style={{ marginTop: 18, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11.5, color: 'var(--text-subtle)' }}>
              {t('docs.showing', { shown: visibleDocs.length, total })}
            </span>
            {docs.length < total && (
              <button
                type="button"
                className="kh-load-more"
                onClick={loadMore}
                disabled={loadingMore || status === 'loading'}
                style={{
                  padding: '9px 20px',
                  border: '1px solid var(--border-strong)',
                  borderRadius: 10,
                  background: 'var(--surface)',
                  color: 'var(--text-secondary)',
                  fontSize: 13,
                  fontWeight: 500,
                  cursor: 'pointer',
                }}
              >
                {t('docs.loadMore')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ChannelChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      className="kh-chip"
      onClick={onClick}
      style={{
        padding: '7px 14px',
        borderRadius: 999,
        fontSize: 12.5,
        fontWeight: 500,
        fontFamily: "'IBM Plex Mono', monospace",
        cursor: 'pointer',
        ...(active
          ? {
              background: 'rgba(245,166,35,0.14)',
              border: '1px solid rgba(245,166,35,0.45)',
              color: 'var(--accent-ink)',
            }
          : {
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              color: 'var(--text-tertiary)',
            }),
      }}
    >
      {label}
    </button>
  );
}

function DocRow({ doc, onClick }: { doc: DocumentFragment; onClick: () => void }): ReactElement {
  const { t, i18n } = useTranslation();
  const date = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' }).format(new Date(doc.indexedAt));

  return (
    <div
      className="kh-doc-row"
      data-read={doc.isRead}
      onClick={onClick}
      // L9 (audit): the row's primary action (mark-as-read) was mouse-only. Make it
      // a real interactive control so keyboard/screen-reader users can reach and
      // activate it — role/tabIndex expose it, onKeyDown mirrors the click on
      // Enter/Space (preventDefault stops Space from scrolling the page).
      role="button"
      tabIndex={0}
      aria-label={t('docs.rowAriaLabel', { title: doc.title })}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(240px,1fr) 44px 92px 116px 84px',
        gap: 12,
        minWidth: 620,
        padding: '15px 20px',
        borderBottom: '1px solid var(--line)',
        alignItems: 'center',
        cursor: 'pointer',
        boxShadow: doc.isRead ? 'inset 3px 0 0 transparent' : 'inset 3px 0 0 #F5A623',
      }}
    >
      <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start', minWidth: 0 }}>
        <div
          style={{
            marginTop: 2,
            flexShrink: 0,
            display: 'flex',
            width: 16,
            justifyContent: 'center',
          }}
        >
          {doc.isRead ? (
            <span data-testid="doc-row-check" style={{ color: 'var(--text-subtle)' }}>
              <CheckIcon size={14} />
            </span>
          ) : (
            <span
              data-testid="doc-row-dot"
              style={{
                width: 8,
                height: 8,
                marginTop: 4,
                borderRadius: '50%',
                background: '#F5A623',
                boxShadow: '0 0 0 3px rgba(245,166,35,0.16)',
              }}
            />
          )}
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <span
            data-testid="doc-row-content"
            style={{
              display: 'block',
              overflowWrap: 'anywhere',
              fontSize: 13.5,
              lineHeight: 1.4,
              color: 'var(--text-primary)',
              fontWeight: doc.isRead ? 500 : 700,
            }}
          >
            {doc.title}
          </span>
          {!doc.isRead && (
            <span
              data-testid="doc-row-new-badge"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                marginTop: 5,
                padding: '1px 7px',
                fontFamily: "'IBM Plex Mono', monospace",
                fontSize: 9.5,
                fontWeight: 600,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                color: 'var(--accent-ink)',
                background: 'rgba(245,166,35,0.13)',
                borderRadius: 5,
              }}
            >
              {t('docs.newBadge')}
            </span>
          )}
          {doc.description.trim() && (
            <span
              data-testid="doc-row-description"
              style={{
                display: 'block',
                overflowWrap: 'anywhere',
                marginTop: 4,
                fontSize: 13,
                lineHeight: 1.5,
                color: 'var(--text-tertiary)',
              }}
            >
              {doc.description}
            </span>
          )}
        </div>
      </div>

      <a
        href={doc.link}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={t('docs.viewResourceAriaLabel')}
        title={t('docs.viewResourceTitle')}
        className="kh-doc-link"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 28,
          height: 28,
          borderRadius: 8,
          textDecoration: 'none',
        }}
      >
        <ExternalLinkIcon size={13} />
      </a>

      <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: 'var(--accent-ink)' }}>
        #{doc.channelName}
      </span>

      <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
        <div
          style={{
            width: 20,
            height: 20,
            flexShrink: 0,
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 9.5,
            fontWeight: 600,
            color: '#fff',
            background: authorColor(doc.authorId),
          }}
        >
          {initialsFromUsername(doc.authorName)}
        </div>
        <span
          style={{
            fontSize: 12.5,
            color: 'var(--text-tertiary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {doc.authorName}
        </span>
      </div>

      <span
        style={{
          textAlign: 'right',
          fontFamily: "'IBM Plex Mono', monospace",
          fontSize: 11.5,
          color: 'var(--text-muted)',
        }}
      >
        {date}
      </span>
    </div>
  );
}
