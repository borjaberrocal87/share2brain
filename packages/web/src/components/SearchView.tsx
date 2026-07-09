// Búsqueda view (Story 4.3, AC1-6). Semantic search over the indexed knowledge,
// RBAC-scoped server-side (AD-12). No router (UX-DR5) — this replaces the
// `search` placeholder branch in AppLayout. No data library — useState + useEffect
// + fetch, debounced with an AbortController per the auth.ts client pattern.
import { useEffect, useState } from 'react';
import type { CSSProperties, ReactElement } from 'react';

import type { Channel, SearchFragment } from '@hivly/shared/schemas';

import { fetchChannels } from '../api/channels';
import { search } from '../api/search';
import { ExternalLinkIcon, SearchIcon } from './icons';
import { authorColor } from '../lib/authorColor';
import { initialsFromUsername } from '../lib/initials';

interface SearchViewProps {
  guildId: string;
}

type Status = 'idle' | 'loading' | 'done' | 'error';

const SEARCH_DEBOUNCE_MS = 250;
const MIN_QUERY_LENGTH = 2;

const containerStyle: CSSProperties = { flex: 1, overflowY: 'auto', padding: '34px 40px 60px' };
const innerStyle: CSSProperties = { maxWidth: 860, margin: '0 auto' };

export function SearchView({ guildId }: SearchViewProps): ReactElement {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchFragment[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [activeChannelId, setActiveChannelId] = useState<'all' | string>('all');
  const [status, setStatus] = useState<Status>('idle');
  const [searched, setSearched] = useState(false);

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
    // A new query starts a fresh result set — clear any active channel filter so
    // matches in other channels are not silently hidden by a stale chip selection.
    setActiveChannelId('all');
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      setResults([]);
      setSearched(false);
      setStatus('idle');
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      setStatus('loading');
      search(trimmed, controller.signal)
        .then((res) => {
          setResults(res.results);
          setSearched(true);
          setStatus('done');
        })
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === 'AbortError') return;
          setResults([]);
          setSearched(true);
          setStatus('error');
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const visibleResults =
    activeChannelId === 'all' ? results : results.filter((r) => r.channelId === activeChannelId);
  const showEmptyState = searched && status === 'done' && visibleResults.length === 0;

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
          Búsqueda de conocimiento
        </h2>
        <p style={{ margin: '7px 0 0', fontSize: 14, color: 'var(--text-tertiary)' }}>
          Búsqueda semántica sobre los mensajes indexados de Discord. Cada resultado cita su
          fuente original.
        </p>

        <div style={{ marginTop: 22, position: 'relative' }}>
          <span
            aria-hidden="true"
            style={{
              position: 'absolute',
              left: 17,
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'var(--text-muted)',
              display: 'flex',
            }}
          >
            <SearchIcon size={19} />
          </span>
          <input
            className="kh-search-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="¿Cómo configuro los canales a indexar?"
            style={{
              width: '100%',
              height: 54,
              padding: '0 18px 0 48px',
              fontSize: 15,
              color: 'var(--text-primary)',
              background: 'var(--surface)',
              // Base border lives in the .kh-search-input CSS class (not inline) so
              // the :focus rule can override border-color to var(--accent-ink) —
              // an inline `border` shorthand would outrank the :focus rule and the
              // focus ring's border would never turn amber (Story 4.3 AC2).
              borderRadius: 14,
              outline: 'none',
            }}
          />
        </div>

        <div style={{ marginTop: 16, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <ChannelChip label="todos" active={activeChannelId === 'all'} onClick={() => setActiveChannelId('all')} />
          {channels.map((ch) => (
            <ChannelChip
              key={ch.id}
              label={`#${ch.name}`}
              active={activeChannelId === ch.id}
              onClick={() => setActiveChannelId(ch.id)}
            />
          ))}
        </div>

        {status === 'loading' && (
          <div
            style={{
              marginTop: 24,
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: 12,
              color: 'var(--text-muted)',
            }}
          >
            Buscando…
          </div>
        )}

        {status === 'error' && (
          <div
            style={{
              marginTop: 24,
              fontSize: 14,
              color: 'var(--text-tertiary)',
            }}
          >
            No se pudo completar la búsqueda. Reintentá.
          </div>
        )}

        {status === 'done' && (
          <div
            style={{
              marginTop: 24,
              display: 'flex',
              justifyContent: 'space-between',
            }}
          >
            <span
              style={{
                fontFamily: "'IBM Plex Mono', monospace",
                fontSize: 12,
                color: 'var(--text-muted)',
              }}
            >
              {visibleResults.length} resultados
            </span>
            <span
              style={{
                fontFamily: "'IBM Plex Mono', monospace",
                fontSize: 11,
                color: 'var(--text-subtle)',
              }}
            >
              ordenado por similitud
            </span>
          </div>
        )}

        <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 13 }}>
          {visibleResults.map((r) => (
            <ResultCard key={r.id} fragment={r} guildId={guildId} />
          ))}
        </div>

        {showEmptyState && (
          <div
            data-testid="search-empty-state"
            style={{
              marginTop: 30,
              textAlign: 'center',
              padding: '50px 20px',
              border: '1px dashed var(--border-strong)',
              borderRadius: 16,
            }}
          >
            <div style={{ fontSize: 15, color: 'var(--text-tertiary)' }}>
              Sin coincidencias en el conocimiento indexado.
            </div>
            <div style={{ marginTop: 6, fontSize: 13, color: 'var(--text-subtle)' }}>
              Probá con otros términos o consultá al agente en el chat.
            </div>
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
              // Base border lives in .kh-chip so :hover can override border-color
              // (Epic 4 retro Action Item #4); the active branch keeps it inline.
              background: 'var(--surface)',
              color: 'var(--text-tertiary)',
            }),
      }}
    >
      {label}
    </button>
  );
}

function ResultCard({ fragment, guildId }: { fragment: SearchFragment; guildId: string }): ReactElement {
  const date = new Intl.DateTimeFormat('es', { dateStyle: 'medium' }).format(
    new Date(fragment.createdAt),
  );
  const simPct = Math.round(fragment.similarity * 100);
  const link = `https://discord.com/channels/${guildId}/${fragment.channelId}/${fragment.messageId}`;

  return (
    <div
      className="kh-result-card"
      style={{
        // Base border lives in .kh-result-card so :hover can override
        // border-color (Epic 4 retro Action Item #4).
        padding: '18px 20px',
        background: 'var(--surface)',
        borderRadius: 14,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <span
            style={{
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: 12,
              fontWeight: 500,
              color: 'var(--accent-ink)',
              background: 'rgba(245,166,35,0.1)',
              padding: '3px 9px',
              borderRadius: 6,
            }}
          >
            #{fragment.channelName}
          </span>
          <span style={{ fontSize: 12, color: 'var(--text-subtle)' }}>{date}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexShrink: 0 }}>
          <div
            data-testid="similarity-bar"
            style={{
              width: 54,
              height: 5,
              borderRadius: 3,
              background: 'var(--track)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                height: '100%',
                width: `${simPct}%`,
                background: 'linear-gradient(90deg,#F5A623,#FFCB6B)',
                borderRadius: 3,
              }}
            />
          </div>
          <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11.5, color: 'var(--text-tertiary)' }}>
            {fragment.similarity.toFixed(2)}
          </span>
        </div>
      </div>

      <p
        style={{
          margin: '12px 0 0',
          fontSize: 14.5,
          lineHeight: 1.6,
          color: 'var(--text-primary)',
          overflowWrap: 'anywhere',
        }}
      >
        {fragment.description}
      </p>

      <div style={{ marginTop: 13, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <div
            style={{
              width: 24,
              height: 24,
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 10.5,
              fontWeight: 600,
              color: '#fff',
              background: authorColor(fragment.authorId),
            }}
          >
            {initialsFromUsername(fragment.authorName)}
          </div>
          <span style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{fragment.authorName}</span>
        </div>
        <a
          href={link}
          target="_blank"
          rel="noopener noreferrer"
          className="kh-discord-link"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12.5,
            color: 'var(--text-muted)',
            textDecoration: 'none',
          }}
        >
          <span>ver en Discord</span>
          <ExternalLinkIcon size={13} />
        </a>
      </div>
    </div>
  );
}
