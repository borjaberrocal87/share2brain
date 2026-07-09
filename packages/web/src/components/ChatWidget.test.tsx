// Unit tests for the ChatWidget (Stories 5.3 shell + 5.4 chat). Behavior only —
// the visual/CSS ACs (geometry, tokens, hexagon clip-path, streaming cursor color)
// are verified by the Playwright spec (tests/chat.spec.ts), since jsdom applies no
// external CSS (Epic 4 lesson: a visual AC is not done until the harness asserts it).
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConversationDetail, ConversationsResponse, SSEFrame } from '@hivly/shared/schemas';

import * as chatApi from '../api/chat';
import * as conversationsApi from '../api/conversations';
import { ChatWidget } from './ChatWidget';

vi.mock('../api/conversations', () => ({
  fetchConversations: vi.fn(),
  fetchConversation: vi.fn(),
}));
vi.mock('../api/chat', () => ({ streamChat: vi.fn() }));

const fetchConversations = vi.mocked(conversationsApi.fetchConversations);
const fetchConversation = vi.mocked(conversationsApi.fetchConversation);
const streamChat = vi.mocked(chatApi.streamChat);

const USER = { name: 'ada lovelace', initials: 'AL' };
const UUID = '550e8400-e29b-41d4-a716-446655440000';

const emptyResponse: ConversationsResponse = { results: [], page: 1, limit: 20, total: 0 };

function conversationsResponse(results: ConversationsResponse['results']): ConversationsResponse {
  return { results, page: 1, limit: 20, total: results.length };
}

// The panel's focusable set (same selector the component's focus trap uses), so
// the trap tests stay robust as the composer adds a textarea/send button.
function focusables(panel: HTMLElement): HTMLElement[] {
  return Array.from(
    panel.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );
}

// A streamChat mock implementation yielding a fixed frame list.
function genOf(frames: SSEFrame[]) {
  return async function* (): AsyncGenerator<SSEFrame> {
    for (const f of frames) yield f;
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function renderWidget(): ReturnType<typeof render> {
  return render(<ChatWidget user={USER} />);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  fetchConversations.mockResolvedValue(emptyResponse);
  fetchConversation.mockResolvedValue({ id: UUID, createdAt: '', updatedAt: '', messages: [] });
  streamChat.mockImplementation(genOf([{ type: 'done', conversationId: UUID }]));
});

function openPanel(): void {
  fireEvent.click(screen.getByTestId('chat-fab'));
}

function typeDraft(value: string): void {
  fireEvent.change(screen.getByTestId('chat-input'), { target: { value } });
}

describe('ChatWidget — shell (5.3)', () => {
  it('should render the FAB and no panel initially', () => {
    renderWidget();

    expect(screen.getByTestId('chat-fab')).toBeTruthy();
    expect(screen.queryByTestId('chat-panel')).toBeNull();
  });

  it('should open the panel and hide the FAB when the FAB is clicked', () => {
    renderWidget();

    openPanel();

    expect(screen.getByTestId('chat-panel')).toBeTruthy();
    expect(screen.queryByTestId('chat-fab')).toBeNull();
  });

  it('should close the panel and bring back the FAB when the close button is clicked', () => {
    renderWidget();
    openPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Cerrar chat' }));

    expect(screen.queryByTestId('chat-panel')).toBeNull();
    expect(screen.getByTestId('chat-fab')).toBeTruthy();
  });

  it('should close the panel when Escape is pressed', () => {
    renderWidget();
    openPanel();

    fireEvent.keyDown(screen.getByTestId('chat-panel'), { key: 'Escape' });

    expect(screen.queryByTestId('chat-panel')).toBeNull();
    expect(screen.getByTestId('chat-fab')).toBeTruthy();
  });

  it('should render the empty state with a heading and 3 suggestion chips', () => {
    renderWidget();
    openPanel();

    expect(screen.getByTestId('chat-empty-state')).toBeTruthy();
    expect(screen.getByText('Preguntá lo que quieras')).toBeTruthy();
    expect(screen.getAllByTestId('chat-suggestion')).toHaveLength(3);
  });

  it('should open the history overlay and fetch conversations when the history button is clicked', async () => {
    renderWidget();
    openPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Historial de conversaciones' }));

    await waitFor(() => expect(fetchConversations).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('chat-history-overlay')).toBeTruthy();
    expect(await screen.findByTestId('chat-history-empty')).toBeTruthy();
  });

  it('should render conversation titles and relative times when the history is populated', async () => {
    fetchConversations.mockResolvedValue(
      conversationsResponse([
        {
          id: UUID,
          title: 'How do I configure the channels to index?',
          createdAt: '2020-01-01T00:00:00.000Z',
          updatedAt: '2020-01-01T00:00:00.000Z',
        },
      ]),
    );
    renderWidget();
    openPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Historial de conversaciones' }));

    const item = await screen.findByTestId('chat-history-item');
    expect(within(item).getByText('How do I configure the channels to index?')).toBeTruthy();
    expect(within(item).getByText(/hace/)).toBeTruthy();
  });

  it('should show an error message when the history fetch fails', async () => {
    fetchConversations.mockRejectedValue(new Error('boom'));
    renderWidget();
    openPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Historial de conversaciones' }));

    expect(await screen.findByText('No se pudo cargar el historial. Reintentá.')).toBeTruthy();
  });

  it('should close only the history overlay (not the whole panel) on the first Escape', async () => {
    renderWidget();
    openPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Historial de conversaciones' }));
    await screen.findByTestId('chat-history-empty');

    fireEvent.keyDown(screen.getByTestId('chat-panel'), { key: 'Escape' });

    expect(screen.queryByTestId('chat-history-overlay')).toBeNull();
    expect(screen.getByTestId('chat-panel')).toBeTruthy();

    fireEvent.keyDown(screen.getByTestId('chat-panel'), { key: 'Escape' });

    expect(screen.queryByTestId('chat-panel')).toBeNull();
  });

  it('should restore focus to the history toggle button when the overlay closes without closing the panel', async () => {
    renderWidget();
    openPanel();
    const historyBtn = screen.getByRole('button', { name: 'Historial de conversaciones' });
    fireEvent.click(historyBtn);
    await screen.findByTestId('chat-history-empty');

    fireEvent.keyDown(screen.getByTestId('chat-panel'), { key: 'Escape' });

    expect(screen.queryByTestId('chat-history-overlay')).toBeNull();
    expect(document.activeElement).toBe(historyBtn);
  });

  it('should focus the FAB (not crash) when the whole panel closes while the history overlay is still open', async () => {
    renderWidget();
    openPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Historial de conversaciones' }));
    await screen.findByTestId('chat-history-empty');

    fireEvent.click(screen.getByRole('button', { name: 'Cerrar chat' }));

    const fab = screen.getByTestId('chat-fab');
    expect(fab).toBeTruthy();
    expect(document.activeElement).toBe(fab);
  });

  it('should not render the empty-state suggestions while the history overlay covers them', () => {
    renderWidget();
    openPanel();
    const historyBtn = screen.getByRole('button', { name: 'Historial de conversaciones' });
    fireEvent.click(historyBtn);

    expect(screen.queryByTestId('chat-suggestion')).toBeNull();

    // Shift+Tab from the (focused) "Historial" button must wrap to the last
    // VISIBLE focusable — now the composer textarea (a legitimate boundary below
    // the overlay), NOT a suggestion hidden behind the overlay.
    const panel = screen.getByTestId('chat-panel');
    fireEvent.keyDown(panel, { key: 'Tab', shiftKey: true });

    const last = focusables(panel).at(-1);
    expect(document.activeElement).toBe(last);
    expect(last).toBe(screen.getByTestId('chat-input'));
  });

  it('should trap Tab focus inside the panel (wrapping from the last to the first focusable element)', () => {
    renderWidget();
    openPanel();

    const panel = screen.getByTestId('chat-panel');
    const els = focusables(panel);
    const first = els[0];
    const last = els[els.length - 1];
    last.focus();

    fireEvent.keyDown(panel, { key: 'Tab' });

    expect(document.activeElement).toBe(first);
  });

  it('should trap Shift+Tab focus inside the panel (wrapping from the first to the last focusable element)', () => {
    renderWidget();
    openPanel();

    const panel = screen.getByTestId('chat-panel');
    const els = focusables(panel);
    const first = els[0];
    const last = els[els.length - 1];
    first.focus();

    fireEvent.keyDown(panel, { key: 'Tab', shiftKey: true });

    expect(document.activeElement).toBe(last);
  });

  it('should trap Shift+Tab even before focus moves off the panel container (immediately after opening)', () => {
    renderWidget();
    openPanel();

    const panel = screen.getByTestId('chat-panel');
    expect(document.activeElement).toBe(panel);
    const last = focusables(panel).at(-1);

    fireEvent.keyDown(panel, { key: 'Tab', shiftKey: true });

    expect(document.activeElement).toBe(last);
  });
});

describe('ChatWidget — composer (5.4)', () => {
  it('should disable the send button when the draft is empty and enable it after typing', () => {
    renderWidget();
    openPanel();

    const send = screen.getByTestId('chat-send') as HTMLButtonElement;
    expect(send.disabled).toBe(true);

    typeDraft('hola');
    expect(send.disabled).toBe(false);

    // A whitespace-only draft stays disabled (trimmed).
    typeDraft('   ');
    expect(send.disabled).toBe(true);
  });

  it('should render the composer footer with the privacy string', () => {
    renderWidget();
    openPanel();

    expect(screen.getByText(/tools de hivly\.config\.yml/)).toBeTruthy();
  });

  it('should send on Enter and NOT send on Shift+Enter', () => {
    renderWidget();
    openPanel();
    typeDraft('¿Qué es RBAC?');

    const input = screen.getByTestId('chat-input');
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(streamChat).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(streamChat).toHaveBeenCalledTimes(1);
    expect(streamChat.mock.calls[0][0]).toMatchObject({ message: '¿Qué es RBAC?' });
  });
});

describe('ChatWidget — streaming (5.4)', () => {
  it('should append a user bubble, stream tokens into the agent bubble, and drop the cursor on done', async () => {
    const gate = deferred<void>();
    streamChat.mockImplementation(() =>
      (async function* (): AsyncGenerator<SSEFrame> {
        yield { type: 'token', content: 'Hola' };
        yield { type: 'token', content: ' mundo' };
        await gate.promise;
        yield {
          type: 'citation',
          title: 'Deploying with Docker Compose',
          channel: 'general',
          author: 'ada',
          date: '2026-06-01T10:00:00Z',
          link: 'https://example.com/doc',
        };
        yield { type: 'done', conversationId: UUID };
      })(),
    );

    renderWidget();
    openPanel();
    typeDraft('hola');
    fireEvent.click(screen.getByTestId('chat-send'));

    // User bubble reflects the sent text.
    expect((await screen.findByTestId('chat-msg-user')).textContent).toContain('hola');
    // Tokens accumulate; the cursor is present while streaming.
    await waitFor(() =>
      expect(screen.getByTestId('chat-msg-agent').textContent).toContain('Hola mundo'),
    );
    expect(screen.getByTestId('chat-cursor')).toBeTruthy();

    // Let the rest of the stream through: citation chip renders, cursor disappears.
    gate.resolve();
    const chip = (await screen.findByTestId('chat-citation')) as HTMLAnchorElement;
    expect(chip.textContent).toContain('Deploying with Docker Compose');
    expect(chip.href).toBe('https://example.com/doc');
    await waitFor(() => expect(screen.queryByTestId('chat-cursor')).toBeNull());
  });

  it('should show a non-crashing error note on a mid-stream error frame', async () => {
    streamChat.mockImplementation(
      genOf([
        { type: 'token', content: 'parcial' },
        { type: 'error', code: 'INTERNAL', message: 'boom' },
      ]),
    );
    renderWidget();
    openPanel();
    typeDraft('hola');
    fireEvent.click(screen.getByTestId('chat-send'));

    expect(await screen.findByTestId('chat-error')).toBeTruthy();
    expect(screen.queryByTestId('chat-cursor')).toBeNull();
  });

  it('should show an error note when the pre-stream request throws', async () => {
    streamChat.mockImplementation(() =>
      (async function* (): AsyncGenerator<SSEFrame> {
        throw new Error('pre-stream 404');
      })(),
    );
    renderWidget();
    openPanel();
    typeDraft('hola');
    fireEvent.click(screen.getByTestId('chat-send'));

    expect(await screen.findByTestId('chat-error')).toBeTruthy();
  });

  it('should send the suggestion text when an empty-state suggestion is clicked', async () => {
    renderWidget();
    openPanel();

    fireEvent.click(screen.getAllByTestId('chat-suggestion')[0]);

    await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(1));
    expect((await screen.findByTestId('chat-msg-user')).textContent).toContain(
      '¿Cómo configuro los canales a indexar?',
    );
  });

  it('should show the launcher dot while sending with the panel closed, keeping the stream alive', async () => {
    const gate = deferred<void>();
    streamChat.mockImplementation(() =>
      (async function* (): AsyncGenerator<SSEFrame> {
        yield { type: 'token', content: 'Hola' };
        await gate.promise;
        yield { type: 'done', conversationId: UUID };
      })(),
    );

    renderWidget();
    openPanel();
    typeDraft('hola');
    fireEvent.click(screen.getByTestId('chat-send'));
    await screen.findByTestId('chat-msg-agent');

    // Close the panel mid-stream: the FAB shows the pulsing launcher dot.
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar chat' }));
    expect(screen.getByTestId('chat-launcher-dot')).toBeTruthy();

    // Reopen: the streaming message state survived the close (not aborted — D6).
    fireEvent.click(screen.getByTestId('chat-fab'));
    expect(screen.getByTestId('chat-msg-agent').textContent).toContain('Hola');

    gate.resolve();
    await waitFor(() => expect(screen.queryByTestId('chat-launcher-dot')).toBeNull());
  });

  it('should abort the in-flight stream on unmount', async () => {
    const abortSpy = vi.spyOn(AbortController.prototype, 'abort');
    streamChat.mockImplementation(() =>
      (async function* (): AsyncGenerator<SSEFrame> {
        yield { type: 'token', content: 'Hola' };
        await new Promise<void>(() => {}); // never resolves — stays in flight
      })(),
    );

    const { unmount } = renderWidget();
    openPanel();
    typeDraft('hola');
    fireEvent.click(screen.getByTestId('chat-send'));
    await screen.findByTestId('chat-msg-agent');

    unmount();

    expect(abortSpy).toHaveBeenCalled();
    abortSpy.mockRestore();
  });
});

describe('ChatWidget — history load (5.4)', () => {
  const detail: ConversationDetail = {
    id: UUID,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:05.000Z',
    messages: [
      {
        id: '550e8400-e29b-41d4-a716-446655440001',
        role: 'user',
        content: '¿Cómo configuro las notificaciones?',
        citations: [],
        createdAt: '2026-07-01T00:00:00.000Z',
      },
      {
        id: '550e8400-e29b-41d4-a716-446655440002',
        role: 'assistant',
        content: 'Se configuran en Hivly.config.yml.',
        citations: [
          {
            title: 'Deploying with Docker Compose',
            channel: 'general',
            author: 'e2e-author-ada',
            date: '2026-06-01T10:00:00Z',
            link: 'https://example.com/doc',
          },
        ],
        createdAt: '2026-07-01T00:00:05.000Z',
      },
    ],
  };

  function populatedHistory(): void {
    fetchConversations.mockResolvedValue(
      conversationsResponse([
        {
          id: UUID,
          title: 'Seeded conversation',
          createdAt: '2026-07-01T00:00:00.000Z',
          updatedAt: '2026-07-01T00:00:05.000Z',
        },
      ]),
    );
  }

  it('should load and render a conversation when a history row is selected, then close the overlay', async () => {
    populatedHistory();
    fetchConversation.mockResolvedValue(detail);
    renderWidget();
    openPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Historial de conversaciones' }));
    fireEvent.click(await screen.findByTestId('chat-history-item'));

    await waitFor(() => expect(fetchConversation).toHaveBeenCalledWith(UUID));
    // Overlay closed; the seeded messages render as user + agent bubbles.
    expect(screen.queryByTestId('chat-history-overlay')).toBeNull();
    expect((await screen.findByTestId('chat-msg-user')).textContent).toContain(
      '¿Cómo configuro las notificaciones?',
    );
    expect(screen.getByTestId('chat-msg-agent').textContent).toContain(
      'Se configuran en Hivly.config.yml.',
    );
    const chip = screen.getByTestId('chat-citation') as HTMLAnchorElement;
    expect(chip.textContent).toContain('Deploying with Docker Compose');
    expect(chip.href).toBe('https://example.com/doc');
    // No streaming cursor on a loaded (historical) conversation.
    expect(screen.queryByTestId('chat-cursor')).toBeNull();
  });

  it('should clear the messages back to the empty state on "nueva conversación"', async () => {
    populatedHistory();
    fetchConversation.mockResolvedValue(detail);
    renderWidget();
    openPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Historial de conversaciones' }));
    fireEvent.click(await screen.findByTestId('chat-history-item'));
    await screen.findByTestId('chat-msg-user');

    fireEvent.click(screen.getByRole('button', { name: 'Nueva conversación' }));

    expect(screen.getByTestId('chat-empty-state')).toBeTruthy();
    expect(screen.queryByTestId('chat-msg-user')).toBeNull();
  });

  it('should mark the selected conversation active and clear it on "nueva conversación"', async () => {
    populatedHistory();
    fetchConversation.mockResolvedValue({ ...detail, messages: [] });
    renderWidget();
    openPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Historial de conversaciones' }));
    fireEvent.click(await screen.findByTestId('chat-history-item'));
    expect(screen.queryByTestId('chat-history-overlay')).toBeNull();
    await waitFor(() => expect(fetchConversation).toHaveBeenCalledWith(UUID));

    fireEvent.click(screen.getByRole('button', { name: 'Historial de conversaciones' }));
    const activeRow = await screen.findByTestId('chat-history-item');
    expect(activeRow.style.background).toBe('rgba(245, 166, 35, 0.12)');

    fireEvent.click(screen.getByRole('button', { name: 'Nueva conversación' }));
    fireEvent.click(screen.getByRole('button', { name: 'Historial de conversaciones' }));
    const clearedRow = await screen.findByTestId('chat-history-item');
    expect(clearedRow.style.background).toBe('');
  });
});
