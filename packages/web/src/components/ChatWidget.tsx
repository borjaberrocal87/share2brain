// Floating chat widget — FAB launcher + working chat panel (Stories 5.3 + 5.4).
// 5.3 shipped the SHELL (FAB, header, empty state, history overlay). 5.4 turns it
// into a working chat: the message composer, user/agent bubbles, SSE `token`
// streaming with the amber blinking cursor, citation chips, wiring the empty-state
// suggestions to send, and loading a conversation's messages from history.
//
// The execution-trace "loop de ejecución" panel (UX-DR20 tool_call/observation) is
// DEFERRED (D1): the backend SSE contract emits only token/citation/done/error —
// there is no tool_exec node. Building it is a future backend+shared story.
//
// State is SELF-CONTAINED: chatOpen / chatHistoryOpen / activeConversationId /
// messages / sending / draft live here. It mounts as a `position: fixed` sibling
// after <AppLayout> (UX-DR5: the chat is a floating widget, not a nav item).
//
// Stream lifecycle (D6): the in-flight stream is NOT aborted on panel close — the
// widget stays mounted, the stream keeps writing to `messages`, and the FAB shows
// the pulsing launcher dot (`launcherActive = sending && !chatOpen`). It is aborted
// only on component unmount.
//
// Cascade rule (Epic 4 AI#4): any element whose border/background/color changes on
// :hover/:focus-within declares its BASE value in a components.css class, never
// inline — an inline shorthand outranks a stylesheet pseudo-class and the state
// silently dies. The send button's disabled/enabled bg is the one deliberate inline
// state (React-driven, not a CSS pseudo-class).
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, ReactElement, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { CitationType, ConversationSummary } from '@share2brain/shared/schemas';

import { streamChat, ChatStreamError } from '../api/chat';
import { fetchConversation, fetchConversations } from '../api/conversations';
import { translateErrorCode } from '../lib/apiError';
import { relativeTime } from '../lib/relativeTime';
import { Hexagon, CLIP_PATH, AMBER_GRADIENT } from './Hexagon';
import { ChatIcon, CloseIcon, ExternalLinkIcon, HistoryIcon, LockIcon, PlusIcon, SendIcon } from './icons';

type HistoryStatus = 'idle' | 'loading' | 'error';

/** One rendered chat message. `id` is client-generated for React keys; `streaming`,
 * `errored`, and `errorNote` apply to an assistant bubble only. `errorNote` overrides
 * the default inline error text (e.g. a history-load failure vs. a stream failure). */
interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations: CitationType[];
  streaming?: boolean;
  errored?: boolean;
  errorNote?: string;
}

interface ChatWidgetProps {
  /** The signed-in user, for the user-bubble avatar (UX-DR19, D4). */
  user: { name: string; initials: string };
  /**
   * Guest mode (Story 2.5). All guests share one sentinel identity, so the
   * conversation history is server-side isolated (list empty, detail 404). Hide
   * the "Historial" button too — a guest has no navigable history.
   */
  isGuest?: boolean;
}

const AMBER = '#F5A623';
const DISCORD_BLURPLE = '#5865F2';

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

// Immutably replace the message with `id` (used to mutate the streaming assistant
// bubble as token/citation/done frames arrive).
function replaceMessage(
  messages: ChatMessage[],
  id: string,
  fn: (m: ChatMessage) => ChatMessage,
): ChatMessage[] {
  return messages.map((m) => (m.id === id ? fn(m) : m));
}

// Empty-state suggestion prompts (the prototype leaves these dynamic). Knowledge-
// oriented. Clicking one sends it as a message (AC5).
// D9 trap: this is evaluated at import time, before main.tsx resolves the boot
// language — these are translation KEYS, resolved at render (below), never
// plain text here.
const SUGGESTIONS: readonly ('common.exampleQuestion' | 'chat.suggestions.backfill' | 'chat.suggestions.rbac')[] = [
  'common.exampleQuestion',
  'chat.suggestions.backfill',
  'chat.suggestions.rbac',
];

const AMBER_SHADOW = '0 14px 34px -10px rgba(245,166,35,0.65)';
// Amber tint that marks the active history row — set INLINE so it beats the
// class-level :hover background (mirrors .kh-nav-item--active).
const ACTIVE_ROW_STYLE: CSSProperties = {
  background: 'rgba(245,166,35,0.12)',
  color: 'var(--accent-ink)',
};

export function ChatWidget({ user, isGuest = false }: ChatWidgetProps): ReactElement {
  const { t, i18n } = useTranslation();
  const [chatOpen, setChatOpen] = useState(false);
  const [chatHistoryOpen, setChatHistoryOpen] = useState(false);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [historyStatus, setHistoryStatus] = useState<HistoryStatus>('idle');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState('');
  // UX-DR15: the pulsing green launcher dot shows while a send is in flight and
  // the panel is closed (the stream keeps running — D6).
  const launcherActive = sending && !chatOpen;

  const fabRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const historyBtnRef = useRef<HTMLButtonElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  // The in-flight stream's controller; aborted only on unmount (D6) or when the
  // user explicitly abandons it via newChat/selectConversation (review fix).
  const streamAbortRef = useRef<AbortController | null>(null);
  // Mirrors `sending` synchronously (state updates are batched/async) so send()'s
  // re-entrancy guard can't be bypassed by two triggers in the same tick (review fix).
  const sendingRef = useRef(false);
  // Bumped on every selectConversation/newChat call; a fetchConversation response
  // is applied only if it's still the most recent request (review fix — races
  // between rapid history-row clicks, or a load racing a newChat).
  const conversationLoadIdRef = useRef(0);
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

  // Abort the in-flight stream ONLY on unmount (D6) — panel close keeps it alive.
  useEffect(() => {
    return () => streamAbortRef.current?.abort();
  }, []);

  // Auto-scroll the message list to the newest content as messages/tokens arrive.
  // jsdom has no scrollIntoView, so guard it (unit tests must not crash).
  useEffect(() => {
    const el = messagesEndRef.current;
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'end' });
  }, [messages]);

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

  // Selecting a history row loads its messages (closes 5.3's deferral) and closes
  // the overlay. Ownership is enforced server-side. Abandons any in-flight send
  // stream (review fix — otherwise its eventual `done` frame could silently
  // reassign activeConversationId back to the conversation the user just left) and
  // tags this load with a monotonic id so a slower, superseded response (from a
  // previous row click or a since-issued newChat) is ignored on arrival.
  function selectConversation(id: string): void {
    streamAbortRef.current?.abort();
    setChatHistoryOpen(false);
    const loadId = ++conversationLoadIdRef.current;
    fetchConversation(id)
      .then((detail) => {
        if (conversationLoadIdRef.current !== loadId) return;
        setActiveConversationId(id);
        setMessages(
          detail.messages
            // A `system` message (none are seeded) is not rendered as a bubble.
            .filter((m): m is typeof m & { role: 'user' | 'assistant' } => m.role !== 'system')
            .map((m) => ({ id: m.id, role: m.role, content: m.content, citations: m.citations })),
        );
      })
      .catch((err: unknown) => {
        if (conversationLoadIdRef.current !== loadId) return;
        if (err instanceof DOMException && err.name === 'AbortError') return;
        // Surface a visible error instead of failing silently; leave any existing
        // messages in place (append, don't replace).
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: '',
            citations: [],
            errored: true,
            errorNote: t('chat.historyLoadError'),
          },
        ]);
      });
  }

  function newChat(): void {
    // Abandon any in-flight stream/history-load so its result can't land after
    // the reset (review fix, mirrors selectConversation).
    streamAbortRef.current?.abort();
    conversationLoadIdRef.current++;
    setActiveConversationId(null);
    setMessages([]);
    setChatHistoryOpen(false);
  }

  // Send one turn: append a user bubble + a streaming assistant bubble, then
  // consume the SSE frames (token→citation→done, or error). Blocks a second send
  // while one is in flight (also drives the composer's disabled state, AC2).
  // `clearDraft` is false for a suggestion-chip send (AC5), since `text` there is
  // the suggestion, not the composer's draft — clearing it would silently discard
  // whatever the user had already typed (review fix).
  function send(text: string, clearDraft = true): void {
    const trimmed = text.trim();
    // Read the ref, not the `sending` state: state updates are async/batched, so a
    // second trigger in the same tick (e.g. Enter key-repeat) could otherwise read
    // a stale `sending === false` and start a second concurrent stream (review fix).
    if (!trimmed || sendingRef.current) return;
    sendingRef.current = true;

    if (clearDraft) {
      setDraft('');
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
    }

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: trimmed,
      citations: [],
    };
    const assistantId = crypto.randomUUID();
    const assistantMsg: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      citations: [],
      streaming: true,
    };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setSending(true);

    const controller = new AbortController();
    streamAbortRef.current = controller;

    void (async () => {
      try {
        for await (const frame of streamChat(
          { message: trimmed, conversationId: activeConversationId ?? undefined },
          controller.signal,
        )) {
          if (frame.type === 'token') {
            const { content } = frame;
            setMessages((prev) =>
              replaceMessage(prev, assistantId, (m) => ({ ...m, content: m.content + content })),
            );
          } else if (frame.type === 'citation') {
            const citation: CitationType = {
              title: frame.title,
              channel: frame.channel,
              author: frame.author,
              date: frame.date,
              link: frame.link,
            };
            setMessages((prev) =>
              replaceMessage(prev, assistantId, (m) => ({
                ...m,
                citations: [...m.citations, citation],
              })),
            );
          } else if (frame.type === 'done') {
            const { conversationId } = frame;
            setActiveConversationId(conversationId);
            setMessages((prev) =>
              replaceMessage(prev, assistantId, (m) => ({ ...m, streaming: false })),
            );
          } else {
            // `error` frame: mark the bubble errored and stop the cursor. The
            // frame's `message` is the fallback for an unmapped code (AC5/D4).
            const errorNote = translateErrorCode(frame.code, frame.message);
            setMessages((prev) =>
              replaceMessage(prev, assistantId, (m) => ({
                ...m,
                streaming: false,
                errored: true,
                errorNote,
              })),
            );
          }
        }
      } catch (err) {
        // Unmount abort: the component is going away — leave state untouched.
        if (err instanceof DOMException && err.name === 'AbortError') return;
        // A pre-stream ChatStreamError carries a `code` (AC5/D4); any other
        // failure falls back to the generic chat error → errored bubble.
        const fallback = t('chat.genericError');
        const errorNote = err instanceof ChatStreamError ? translateErrorCode(err.code, fallback) : fallback;
        setMessages((prev) =>
          replaceMessage(prev, assistantId, (m) => ({ ...m, streaming: false, errored: true, errorNote })),
        );
      } finally {
        sendingRef.current = false;
        setSending(false);
        if (streamAbortRef.current === controller) streamAbortRef.current = null;
      }
    })();
  }

  function onComposerKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    // Enter (without Shift) sends; Shift+Enter inserts a newline (default).
    // Skip while an IME composition is active (e.g. typing Japanese/Chinese) — the
    // Enter that confirms a candidate must not also send the partial draft (review
    // fix).
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send(draft);
    }
  }

  function onDraftChange(e: React.ChangeEvent<HTMLTextAreaElement>): void {
    setDraft(e.target.value);
    // Auto-grow up to 120px, then scroll: reset height, then match content.
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }

  const canSend = draft.trim().length > 0 && !sending;

  if (!chatOpen) {
    return (
      <button
        ref={fabRef}
        type="button"
        className="kh-chat-fab"
        data-testid="chat-fab"
        aria-label={t('chat.openAriaLabel')}
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
            data-testid="chat-launcher-dot"
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
      aria-label={t('chat.panelAriaLabel')}
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
              color: 'var(--tx)',
            }}
          >
            Share2Brain
          </div>
          <div
            style={{
              marginTop: 1,
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              fontSize: 11,
              color: 'var(--tx4)',
            }}
          >
            <span
              aria-hidden="true"
              style={{ width: 6, height: 6, borderRadius: '50%', background: '#3BA55D' }}
            />
            {t('chat.tagline')}
          </div>
        </div>

        {/* Story 2.5: guests share one identity, so there is no per-guest history
            to browse — hide the button entirely (the list/detail endpoints are also
            server-side isolated for guests). */}
        {!isGuest && (
          <button
            ref={historyBtnRef}
            type="button"
            className="kh-chat-header-btn"
            aria-label={t('chat.historyTitle')}
            title={t('chat.historyButtonTitle')}
            onClick={toggleHistory}
            style={headerBtnStyle}
          >
            <HistoryIcon size={16} />
          </button>
        )}
        <button
          type="button"
          className="kh-chat-header-btn"
          aria-label={t('chat.newConversation')}
          title={t('chat.newConversation')}
          onClick={newChat}
          style={headerBtnStyle}
        >
          <PlusIcon size={17} />
        </button>
        <button
          type="button"
          className="kh-chat-header-btn kh-chat-header-btn--danger"
          aria-label={t('chat.closeAriaLabel')}
          title={t('chat.closeTitle')}
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
                color: 'var(--tx5)',
              }}
            >
              {t('chat.historyTitle')}
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
                <p style={historyMessageStyle}>{t('chat.historyLoading')}</p>
              )}
              {historyStatus === 'error' && (
                <p style={historyMessageStyle}>{t('chat.historyError')}</p>
              )}
              {historyStatus === 'idle' && conversations.length === 0 && (
                <p data-testid="chat-history-empty" style={historyMessageStyle}>
                  {t('chat.historyEmpty')}
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
                      <span style={{ flexShrink: 0, fontSize: 10.5, color: 'var(--tx5)' }}>
                        {relativeTime(c.updatedAt, i18n.language)}
                      </span>
                    </button>
                  );
                })}
            </div>
          </div>
        )}

        {/* Message-area content (empty state OR the message list) is rendered only
            while the overlay is closed (D10 — same focus-trap reason as 5.3
            round-3: an overlay-covered interactive element must not become a
            Tab-trap boundary, since getFocusableElements ignores visual stacking).
            The empty state renders iff there are no messages (D5). */}
        {!chatHistoryOpen &&
          (messages.length === 0 ? (
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
                      color: 'var(--tx)',
                    }}
                  >
                    {t('chat.emptyStateTitle')}
                  </h3>
                  <p style={{ margin: '8px 0 0', fontSize: 14, color: 'var(--tx3)' }}>
                    {t('chat.emptyStateDescription')}
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
                    {SUGGESTIONS.map((key) => {
                      const text = t(key);
                      return (
                        <button
                          key={key}
                          type="button"
                          className="kh-chat-suggestion"
                          data-testid="chat-suggestion"
                          onClick={() => send(text, false)}
                          style={{
                            textAlign: 'left',
                            padding: '13px 16px',
                            borderRadius: 11,
                            background: 'var(--surface)',
                            color: 'var(--tx2)',
                            fontSize: 13.5,
                            cursor: 'pointer',
                          }}
                        >
                          {text}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div style={{ flex: 1, overflowY: 'auto' }} data-testid="chat-messages">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 22, padding: '22px 18px' }}>
                {messages.map((m) =>
                  m.role === 'user' ? (
                    <UserBubble key={m.id} name={user.name} initials={user.initials} content={m.content} />
                  ) : (
                    <AgentBubble key={m.id} message={m} />
                  ),
                )}
                <div ref={messagesEndRef} />
              </div>
            </div>
          ))}
      </div>

      {/* Composer (UX-DR22): sibling below the message area, NOT covered by the
          history overlay — a legitimate, always-visible Tab-trap boundary (D10). */}
      <div
        style={{
          flexShrink: 0,
          padding: '12px 16px 16px',
          borderTop: '1px solid var(--line)',
          background: 'var(--bg)',
        }}
      >
        <div
          className="kh-chat-input-row"
          data-testid="chat-input-row"
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            gap: 9,
            padding: '7px 7px 7px 14px',
            background: 'var(--surface)',
            borderRadius: 14,
          }}
        >
          <textarea
            ref={textareaRef}
            data-testid="chat-input"
            rows={1}
            value={draft}
            onChange={onDraftChange}
            onKeyDown={onComposerKeyDown}
            placeholder={t('chat.composerPlaceholder')}
            aria-label={t('chat.inputAriaLabel')}
            style={{
              flex: 1,
              resize: 'none',
              maxHeight: 120,
              border: 'none',
              outline: 'none',
              background: 'transparent',
              color: 'var(--tx)',
              fontSize: 14,
              lineHeight: 1.5,
              padding: '8px 0',
              fontFamily: 'inherit',
            }}
          />
          <button
            type="button"
            className="kh-chat-send"
            data-testid="chat-send"
            aria-label={t('chat.sendAriaLabel')}
            disabled={!canSend}
            onClick={() => send(draft)}
            style={{
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 40,
              height: 40,
              borderRadius: 11,
              border: 'none',
              transition: 'all 0.12s ease',
              background: canSend ? AMBER : 'var(--line)',
              color: canSend ? 'var(--on-accent)' : 'var(--tx5)',
              cursor: canSend ? 'pointer' : 'not-allowed',
            }}
          >
            <SendIcon size={17} />
          </button>
        </div>
        <div
          style={{
            marginTop: 8,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            fontSize: 10.5,
            color: 'var(--tx5)',
          }}
        >
          <span aria-hidden="true" style={{ display: 'flex' }}>
            <LockIcon size={11} />
          </span>
          {t('chat.privacyFooter')}
        </div>
      </div>
    </div>
  );
}

// ── Bubbles ────────────────────────────────────────────────────────────────────

function MessageRow({ avatar, children }: { avatar: ReactNode; children: ReactNode }): ReactElement {
  return (
    <div style={{ display: 'flex', gap: 14 }}>
      <div style={{ flexShrink: 0 }}>{avatar}</div>
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  );
}

const NAME_LABEL_STYLE: CSSProperties = {
  fontSize: 12.5,
  fontWeight: 600,
  color: 'var(--tx3)',
  marginBottom: 8,
};

const MESSAGE_TEXT_STYLE: CSSProperties = {
  fontSize: 15,
  lineHeight: 1.7,
  color: 'var(--tx)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

function UserBubble({
  name,
  initials,
  content,
}: {
  name: string;
  initials: string;
  content: string;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <MessageRow
      avatar={
        // Label is chat.you (D4); the real username surfaces as the avatar tooltip.
        <span
          aria-hidden="true"
          title={name}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 30,
            height: 30,
            borderRadius: '50%',
            background: DISCORD_BLURPLE,
            color: '#fff',
            fontSize: 11,
            fontWeight: 600,
          }}
        >
          {initials}
        </span>
      }
    >
      <div style={NAME_LABEL_STYLE}>{t('chat.you')}</div>
      <div data-testid="chat-msg-user" style={MESSAGE_TEXT_STYLE}>
        {content}
      </div>
    </MessageRow>
  );
}

// The agent avatar is a single amber hexagon with an inner var(--bg) hexagon
// (outline effect), inline like the FAB — reusing CLIP_PATH/AMBER_GRADIENT from
// Hexagon.tsx rather than re-inlining the polygon string.
function AgentHexAvatar(): ReactElement {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 30,
        height: 30,
        background: AMBER_GRADIENT,
        clipPath: CLIP_PATH,
      }}
    >
      <span style={{ width: 15, height: 15, background: 'var(--bg)', clipPath: CLIP_PATH }} />
    </span>
  );
}

function AgentBubble({ message }: { message: ChatMessage }): ReactElement {
  const { t } = useTranslation();
  return (
    <MessageRow avatar={<AgentHexAvatar />}>
      <div style={NAME_LABEL_STYLE}>Share2Brain</div>
      <div data-testid="chat-msg-agent" style={MESSAGE_TEXT_STYLE}>
        {message.content}
        {message.streaming && (
          <span
            aria-hidden="true"
            data-testid="chat-cursor"
            style={{
              display: 'inline-block',
              width: 8,
              height: 17,
              marginLeft: 2,
              verticalAlign: -2,
              background: AMBER,
              animation: 'kh-blink 1s step-end infinite',
            }}
          />
        )}
      </div>
      {message.errored && (
        <div data-testid="chat-error" style={{ marginTop: 8, fontSize: 13, color: 'var(--tx3)' }}>
          {message.errorNote || t('chat.genericError')}
        </div>
      )}
      {message.citations.length > 0 && <Citations citations={message.citations} />}
    </MessageRow>
  );
}

function Citations({ citations }: { citations: CitationType[] }): ReactElement {
  const { t } = useTranslation();
  return (
    <div style={{ marginTop: 16 }}>
      <div
        style={{
          fontFamily: "'IBM Plex Mono', monospace",
          fontSize: 10,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: 'var(--tx5)',
          marginBottom: 8,
        }}
      >
        {t('chat.sources')}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {citations.map((c, i) => (
          <CitationChip key={`${c.channel}-${c.author}-${i}`} citation={c} />
        ))}
      </div>
    </div>
  );
}

function CitationChip({ citation }: { citation: CitationType }): ReactElement {
  return (
    <a
      className="kh-chat-citation"
      data-testid="chat-citation"
      href={citation.link}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 11px 6px 6px',
        borderRadius: 9,
        background: 'var(--surface)',
        textDecoration: 'none',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 20,
          height: 20,
          borderRadius: '50%',
          background: AMBER,
          color: 'var(--on-accent)',
          fontSize: 9.5,
          fontWeight: 600,
        }}
      >
        {authorInitials(citation.author)}
      </span>
      <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11.5, color: 'var(--accent-ink)' }}>
        #{citation.channel}
      </span>
      <span
        style={{
          fontSize: 11.5,
          color: 'var(--tx)',
          maxWidth: 180,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {citation.title}
      </span>
      <span style={{ fontSize: 11.5, color: 'var(--tx3)' }}>{citation.author}</span>
      <span aria-hidden="true" style={{ display: 'flex', color: 'var(--tx5)' }}>
        <ExternalLinkIcon size={12} />
      </span>
    </a>
  );
}

// First two letters/digits of the author string, uppercased (no per-author color
// map is in scope — the avatar uses a fixed amber background). Unicode-aware so
// accented/non-Latin Discord usernames (e.g. "Ángela", Cyrillic/CJK) keep their
// own initials instead of collapsing to the "?" fallback (review fix).
function authorInitials(author: string): string {
  const alnum = author.replace(/[^\p{L}\p{N}]/gu, '');
  return alnum ? alnum.slice(0, 2).toUpperCase() : '?';
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
  color: 'var(--tx5)',
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
  color: 'var(--tx2)',
};
