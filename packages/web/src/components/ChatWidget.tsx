// Floating chat widget — FAB launcher + panel shell (Story 5.3). This is the
// SHELL only: FAB, panel chrome (header), empty state, and the conversation-
// history overlay (reading GET /api/conversations). The message composer,
// bubble rendering, SSE streaming, execution trace, and citation chips are all
// Story 5.4 — selecting a history item or "nueva conversación" here only updates
// panel state; it does NOT load or render messages yet (the empty state stays).
//
// State is SELF-CONTAINED (D1): chatOpen / chatHistoryOpen / activeConversationId
// live here, not lifted to App.tsx — nothing outside the widget consumes them in
// 5.3. It mounts as a `position: fixed` sibling after <AppLayout> (which is
// overflow:hidden), so it overlays the whole authenticated shell (UX-DR5: the
// chat is a floating widget, not a nav item).
//
// Chrome detail follows UX-DR16 + the prototype (KeepHive Web.dc.html:284-348),
// NOT the loose epic phrasing "título Chat" (D3): the header shows the hexagon
// logo + brand "Hivly" + status "Agente de conocimiento", no literal "Chat".
// Prototype `--tx*` token names are STALE (Story 2.1 rename) — real names used
// throughout (D2). Reduced motion is handled globally in global.css (no local
// block). Hover/focus border+color live in components.css classes, never inline,
// because an inline `border`/`color` outranks a stylesheet `:hover` (Epic 4 AI#4).
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactElement } from 'react';

import type { ConversationSummary } from '@hivly/shared/schemas';

import { fetchConversations } from '../api/conversations';
import { relativeTimeEs } from '../lib/relativeTime';
import { Hexagon, CLIP_PATH, AMBER_GRADIENT } from './Hexagon';
import { ChatIcon, CloseIcon, HistoryIcon, PlusIcon } from './icons';

type HistoryStatus = 'idle' | 'loading' | 'error';

// Focus-trap helper (AC6 hardening): the elements Tab/Shift+Tab should cycle
// between while the panel is open, so keyboard focus never escapes into the
// still-interactive AppLayout behind it.
function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );
}

// Empty-state suggestion prompts (the prototype leaves these dynamic). Knowledge-
// oriented, Spanish. In 5.3 clicking is a no-op stub; 5.4 wires it to send a
// prefilled message.
const SUGGESTIONS: readonly string[] = [
  '¿Cómo configuro los canales a indexar?',
  '¿Qué es el backfill histórico?',
  '¿Cómo funciona el filtrado RBAC?',
];

const AMBER_SHADOW = '0 14px 34px -10px rgba(245,166,35,0.65)';
// Amber tint that marks the active history row — set INLINE so it beats the
// class-level :hover background (mirrors .kh-nav-item--active).
const ACTIVE_ROW_STYLE: CSSProperties = {
  background: 'rgba(245,166,35,0.12)',
  color: 'var(--accent-ink)',
};

export function ChatWidget(): ReactElement {
  const [chatOpen, setChatOpen] = useState(false);
  const [chatHistoryOpen, setChatHistoryOpen] = useState(false);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [historyStatus, setHistoryStatus] = useState<HistoryStatus>('idle');
  // Forward-compatible (UX-DR15): the pulsing "sending while closed" launcher dot
  // is 5.4's trigger; the markup is present but the flag stays false in 5.3.
  const launcherActive = false;

  const fabRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const historyBtnRef = useRef<HTMLButtonElement>(null);
  // Only steal focus back to the FAB on a genuine open→close transition, never on
  // the initial mount (which would hijack focus from the app on load).
  const wasOpenRef = useRef(false);
  // Same guard for the history overlay: only refocus the toggle button on a
  // genuine open→close transition (Escape/select/newChat), never on mount.
  const wasHistoryOpenRef = useRef(false);

  // Focus management (AC6): move focus into the panel on open; return it to the
  // FAB on close. This effect runs after render, so on close the FAB is already
  // remounted and fabRef points at it.
  useEffect(() => {
    if (chatOpen) {
      panelRef.current?.focus();
      wasOpenRef.current = true;
    } else if (wasOpenRef.current) {
      fabRef.current?.focus();
      wasOpenRef.current = false;
    }
  }, [chatOpen]);

  // The overlay unmounts its own focused row/button when it closes (Escape,
  // selecting a row, or "nueva conversación") — without this, focus is dropped
  // to document.body, which would let the very next Tab escape the panel (the
  // Tab-trap below only intercepts Tab when the focused element is tracked).
  useEffect(() => {
    if (chatHistoryOpen) {
      wasHistoryOpenRef.current = true;
    } else if (wasHistoryOpenRef.current) {
      historyBtnRef.current?.focus();
      wasHistoryOpenRef.current = false;
    }
  }, [chatHistoryOpen]);

  // Fetch the history list each time the overlay opens (fresh view). AbortController
  // cancels an in-flight request if the overlay closes before it resolves.
  useEffect(() => {
    if (!chatHistoryOpen) return;
    const controller = new AbortController();
    setHistoryStatus('loading');
    fetchConversations({}, controller.signal)
      .then((res) => {
        setConversations(res.results);
        setHistoryStatus('idle');
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setHistoryStatus('error');
      });
    return () => controller.abort();
  }, [chatHistoryOpen]);

  function openChat(): void {
    setChatOpen(true);
  }

  function closeChat(): void {
    setChatOpen(false);
    setChatHistoryOpen(false);
  }

  function toggleHistory(): void {
    setChatHistoryOpen((v) => !v);
  }

  // 5.3: selecting a conversation only sets the active id + closes the overlay —
  // no message loading/rendering (that is 5.4). The empty state stays visible.
  function selectConversation(id: string): void {
    setActiveConversationId(id);
    setChatHistoryOpen(false);
  }

  function newChat(): void {
    setActiveConversationId(null);
    setChatHistoryOpen(false);
  }

  if (!chatOpen) {
    return (
      <button
        ref={fabRef}
        type="button"
        className="kh-chat-fab"
        data-testid="chat-fab"
        aria-label="Abrir chat con el agente"
        onClick={openChat}
        style={{
          position: 'fixed',
          bottom: 24,
          right: 24,
          zIndex: 60,
          width: 60,
          height: 60,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: 'none',
          background: 'transparent',
          cursor: 'pointer',
        }}
      >
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            background: AMBER_GRADIENT,
            clipPath: CLIP_PATH,
            boxShadow: AMBER_SHADOW,
          }}
        />
        <span style={{ position: 'relative', display: 'flex', color: 'var(--on-accent)' }}>
          <ChatIcon size={25} />
        </span>
        {launcherActive && (
          <span
            aria-hidden="true"
            style={{
              position: 'absolute',
              top: 1,
              right: 1,
              width: 13,
              height: 13,
              borderRadius: '50%',
              background: '#3BA55D',
              border: '2px solid var(--bg)',
              animation: 'kh-pulse 1.4s ease-in-out infinite',
            }}
          />
        )}
      </button>
    );
  }

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="Chat con el agente"
      data-testid="chat-panel"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          // Dismiss the history overlay first if it's open, mirroring the usual
          // nested-panel pattern; a second Escape then closes the whole widget.
          if (chatHistoryOpen) {
            setChatHistoryOpen(false);
          } else {
            closeChat();
          }
          return;
        }
        if (e.key === 'Tab' && panelRef.current) {
          const focusable = getFocusableElements(panelRef.current);
          if (focusable.length === 0) return;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          // Immediately after opening, focus sits on the panel container itself
          // (see the focus-management effect above), not on `first` — so a
          // Shift+Tab from there must wrap too, or it escapes into AppLayout.
          const atStart =
            document.activeElement === first || document.activeElement === panelRef.current;
          if (e.shiftKey && atStart) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }}
      style={{
        position: 'fixed',
        bottom: 24,
        right: 24,
        zIndex: 60,
        width: 404,
        maxWidth: 'calc(100vw - 32px)',
        height: 642,
        maxHeight: 'calc(100vh - 48px)',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg)',
        border: '1px solid var(--border-strong)',
        borderRadius: 18,
        boxShadow: '0 30px 80px -20px rgba(0,0,0,0.6)',
        overflow: 'hidden',
        outline: 'none',
        animation: 'kh-pop 0.2s ease both',
      }}
    >
      {/* Header (UX-DR16): hexagon logo + brand + status + 3 icon buttons. */}
      <div
        style={{
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '13px 12px 13px 16px',
          borderBottom: '1px solid var(--line)',
          background: 'var(--bg-deep)',
        }}
      >
        <Hexagon size={32} innerBg="bg-deep" showDot={false} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontFamily: "'Space Grotesk', sans-serif",
              fontWeight: 700,
              fontSize: 15,
              lineHeight: 1.15,
              color: 'var(--text-primary)',
            }}
          >
            Hivly
          </div>
          <div
            style={{
              marginTop: 1,
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              fontSize: 11,
              color: 'var(--text-muted)',
            }}
          >
            <span
              aria-hidden="true"
              style={{ width: 6, height: 6, borderRadius: '50%', background: '#3BA55D' }}
            />
            Agente de conocimiento
          </div>
        </div>

        <button
          ref={historyBtnRef}
          type="button"
          className="kh-chat-header-btn"
          aria-label="Historial de conversaciones"
          title="Historial"
          onClick={toggleHistory}
          style={headerBtnStyle}
        >
          <HistoryIcon size={16} />
        </button>
        <button
          type="button"
          className="kh-chat-header-btn"
          aria-label="Nueva conversación"
          title="Nueva conversación"
          onClick={newChat}
          style={headerBtnStyle}
        >
          <PlusIcon size={17} />
        </button>
        <button
          type="button"
          className="kh-chat-header-btn kh-chat-header-btn--danger"
          aria-label="Cerrar chat"
          title="Cerrar"
          onClick={closeChat}
          style={headerBtnStyle}
        >
          <CloseIcon size={16} />
        </button>
      </div>

      {/* Message area (relative parent for the history overlay). */}
      <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {chatHistoryOpen && (
          <div
            data-testid="chat-history-overlay"
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 5,
              background: 'var(--bg)',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div
              style={{
                padding: '14px 16px 8px',
                fontFamily: "'IBM Plex Mono', monospace",
                fontSize: 10,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: 'var(--text-subtle)',
              }}
            >
              Historial de conversaciones
            </div>
            <div
              style={{
                flex: 1,
                overflowY: 'auto',
                padding: '0 10px 14px',
                display: 'flex',
                flexDirection: 'column',
                gap: 3,
              }}
            >
              {historyStatus === 'loading' && (
                <p style={historyMessageStyle}>Cargando conversaciones…</p>
              )}
              {historyStatus === 'error' && (
                <p style={historyMessageStyle}>No se pudo cargar el historial. Reintentá.</p>
              )}
              {historyStatus === 'idle' && conversations.length === 0 && (
                <p data-testid="chat-history-empty" style={historyMessageStyle}>
                  Todavía no tenés conversaciones guardadas.
                </p>
              )}
              {historyStatus === 'idle' &&
                conversations.map((c) => {
                  const active = c.id === activeConversationId;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      className="kh-chat-history-item"
                      data-testid="chat-history-item"
                      onClick={() => selectConversation(c.id)}
                      style={{ ...historyRowStyle, ...(active ? ACTIVE_ROW_STYLE : null) }}
                    >
                      <span style={{ flexShrink: 0, display: 'flex', opacity: 0.7 }}>
                        <ChatIcon size={15} />
                      </span>
                      <span
                        style={{
                          flex: 1,
                          minWidth: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          textAlign: 'left',
                        }}
                      >
                        {c.title}
                      </span>
                      <span style={{ flexShrink: 0, fontSize: 10.5, color: 'var(--text-subtle)' }}>
                        {relativeTimeEs(c.updatedAt)}
                      </span>
                    </button>
                  );
                })}
            </div>
          </div>
        )}

        {/* 5.3 shows the empty state unconditionally while the overlay is closed —
            there is no message rendering yet (5.4). Selecting a history item keeps
            it visible (scope boundary). Not rendered while chatHistoryOpen: it sits
            underneath the opaque overlay, and getFocusableElements has no notion of
            visual stacking, so a mounted-but-covered suggestion button could still
            become the Tab-trap's `first`/`last` boundary and silently steal focus. */}
        {!chatHistoryOpen && (
          <div style={{ flex: 1, overflowY: 'auto', padding: '22px 0' }}>
            <div style={{ margin: '0 auto', padding: '0 18px', display: 'flex', flexDirection: 'column', gap: 22 }}>
              <div data-testid="chat-empty-state" style={{ marginTop: 40, textAlign: 'center' }}>
                <Hexagon size={60} innerBg="bg" showDot={false} style={{ margin: '0 auto' }} />
                <h3
                  style={{
                    margin: '20px 0 0',
                    fontFamily: "'Space Grotesk', sans-serif",
                    fontWeight: 600,
                    fontSize: 21,
                    color: 'var(--text-primary)',
                  }}
                >
                  Preguntá lo que quieras
                </h3>
                <p style={{ margin: '8px 0 0', fontSize: 14, color: 'var(--text-tertiary)' }}>
                  El agente responde con RAG sobre el conocimiento de la comunidad y cita sus fuentes.
                </p>
                <div
                  style={{
                    marginTop: 24,
                    marginLeft: 'auto',
                    marginRight: 'auto',
                    maxWidth: 440,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 9,
                  }}
                >
                  {SUGGESTIONS.map((text) => (
                    <button
                      key={text}
                      type="button"
                      className="kh-chat-suggestion"
                      data-testid="chat-suggestion"
                      // 5.3: no-op stub. 5.4 wires this to send a prefilled message.
                      onClick={() => {}}
                      style={{
                        textAlign: 'left',
                        padding: '13px 16px',
                        borderRadius: 11,
                        background: 'var(--surface)',
                        color: 'var(--text-secondary)',
                        fontSize: 13.5,
                        cursor: 'pointer',
                      }}
                    >
                      {text}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Layout-only inline styles; the base border+color live in .kh-chat-header-btn
// (components.css) so the :hover border-color/color can override them — an inline
// border/color shorthand would outrank the stylesheet :hover and kill it.
const headerBtnStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 32,
  height: 32,
  borderRadius: 9,
  background: 'transparent',
  cursor: 'pointer',
};

const historyMessageStyle: CSSProperties = {
  margin: '10px 6px',
  fontSize: 12.5,
  color: 'var(--text-subtle)',
  textAlign: 'center',
};

// Layout-only; base `background` lives in .kh-chat-history-item so :hover can set
// it. Non-active rows carry NO inline background (the class transparent shows).
const historyRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  width: '100%',
  padding: '9px 10px',
  borderRadius: 9,
  border: 'none',
  cursor: 'pointer',
  fontSize: 13,
  textAlign: 'left',
  color: 'var(--text-secondary)',
};
