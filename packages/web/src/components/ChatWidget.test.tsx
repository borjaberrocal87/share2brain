// Unit tests for the ChatWidget shell (Story 5.3, jsdom). Behavior only — the
// visual/CSS ACs (geometry, tokens, hexagon clip-path) are verified by the
// Playwright spec (tests/chat.spec.ts), since jsdom applies no external CSS.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConversationsResponse } from '@hivly/shared/schemas';

import * as conversationsApi from '../api/conversations';
import { ChatWidget } from './ChatWidget';

vi.mock('../api/conversations', () => ({ fetchConversations: vi.fn() }));
const fetchConversations = vi.mocked(conversationsApi.fetchConversations);

const emptyResponse: ConversationsResponse = { results: [], page: 1, limit: 20, total: 0 };

function conversationsResponse(results: ConversationsResponse['results']): ConversationsResponse {
  return { results, page: 1, limit: 20, total: results.length };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  fetchConversations.mockResolvedValue(emptyResponse);
});

function openPanel(): void {
  fireEvent.click(screen.getByTestId('chat-fab'));
}

describe('ChatWidget', () => {
  it('should render the FAB and no panel initially', () => {
    render(<ChatWidget />);

    expect(screen.getByTestId('chat-fab')).toBeTruthy();
    expect(screen.queryByTestId('chat-panel')).toBeNull();
  });

  it('should open the panel and hide the FAB when the FAB is clicked', () => {
    render(<ChatWidget />);

    openPanel();

    expect(screen.getByTestId('chat-panel')).toBeTruthy();
    expect(screen.queryByTestId('chat-fab')).toBeNull();
  });

  it('should close the panel and bring back the FAB when the close button is clicked', () => {
    render(<ChatWidget />);
    openPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Cerrar chat' }));

    expect(screen.queryByTestId('chat-panel')).toBeNull();
    expect(screen.getByTestId('chat-fab')).toBeTruthy();
  });

  it('should close the panel when Escape is pressed', () => {
    render(<ChatWidget />);
    openPanel();

    fireEvent.keyDown(screen.getByTestId('chat-panel'), { key: 'Escape' });

    expect(screen.queryByTestId('chat-panel')).toBeNull();
    expect(screen.getByTestId('chat-fab')).toBeTruthy();
  });

  it('should render the empty state with a heading and 3 suggestion chips', () => {
    render(<ChatWidget />);
    openPanel();

    expect(screen.getByTestId('chat-empty-state')).toBeTruthy();
    expect(screen.getByText('Preguntá lo que quieras')).toBeTruthy();
    expect(screen.getAllByTestId('chat-suggestion')).toHaveLength(3);
  });

  it('should open the history overlay and fetch conversations when the history button is clicked', async () => {
    render(<ChatWidget />);
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
          id: '550e8400-e29b-41d4-a716-446655440000',
          title: 'How do I configure the channels to index?',
          createdAt: '2020-01-01T00:00:00.000Z',
          updatedAt: '2020-01-01T00:00:00.000Z',
        },
      ]),
    );
    render(<ChatWidget />);
    openPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Historial de conversaciones' }));

    const item = await screen.findByTestId('chat-history-item');
    expect(within(item).getByText('How do I configure the channels to index?')).toBeTruthy();
    // A far-past updatedAt always renders as "hace …".
    expect(within(item).getByText(/hace/)).toBeTruthy();
  });

  it('should mark the selected conversation active, then clear it on "nueva conversación"', async () => {
    fetchConversations.mockResolvedValue(
      conversationsResponse([
        {
          id: '550e8400-e29b-41d4-a716-446655440000',
          title: 'Seeded conversation',
          createdAt: '2026-07-01T00:00:00.000Z',
          updatedAt: '2026-07-01T00:00:00.000Z',
        },
      ]),
    );
    render(<ChatWidget />);
    openPanel();

    // Open history → select the row → overlay closes, id becomes active.
    fireEvent.click(screen.getByRole('button', { name: 'Historial de conversaciones' }));
    fireEvent.click(await screen.findByTestId('chat-history-item'));
    expect(screen.queryByTestId('chat-history-overlay')).toBeNull();

    // Reopen history → the selected row carries the inline amber active tint
    // (matches ChatWidget.tsx's ACTIVE_ROW_STYLE.background).
    fireEvent.click(screen.getByRole('button', { name: 'Historial de conversaciones' }));
    const activeRow = await screen.findByTestId('chat-history-item');
    expect(activeRow.style.background).toBe('rgba(245, 166, 35, 0.12)');

    // "Nueva conversación" clears the active id (and closes the overlay).
    fireEvent.click(screen.getByRole('button', { name: 'Nueva conversación' }));
    expect(screen.queryByTestId('chat-history-overlay')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Historial de conversaciones' }));
    const clearedRow = await screen.findByTestId('chat-history-item');
    expect(clearedRow.style.background).toBe('');
  });

  it('should show an error message when the history fetch fails', async () => {
    fetchConversations.mockRejectedValue(new Error('boom'));
    render(<ChatWidget />);
    openPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Historial de conversaciones' }));

    expect(await screen.findByText('No se pudo cargar el historial. Reintentá.')).toBeTruthy();
  });

  it('should close only the history overlay (not the whole panel) on the first Escape', async () => {
    render(<ChatWidget />);
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
    render(<ChatWidget />);
    openPanel();
    const historyBtn = screen.getByRole('button', { name: 'Historial de conversaciones' });
    fireEvent.click(historyBtn);
    await screen.findByTestId('chat-history-empty');

    fireEvent.keyDown(screen.getByTestId('chat-panel'), { key: 'Escape' });

    expect(screen.queryByTestId('chat-history-overlay')).toBeNull();
    // Without this, focus drops to document.body and the next Tab escapes the panel.
    expect(document.activeElement).toBe(historyBtn);
  });

  it('should focus the FAB (not crash) when the whole panel closes while the history overlay is still open', async () => {
    render(<ChatWidget />);
    openPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Historial de conversaciones' }));
    await screen.findByTestId('chat-history-empty');

    // "Cerrar chat" closes both chatOpen and chatHistoryOpen in the same tick —
    // the history-toggle button unmounts before either focus-restore effect runs.
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar chat' }));

    const fab = screen.getByTestId('chat-fab');
    expect(fab).toBeTruthy();
    expect(document.activeElement).toBe(fab);
  });

  it('should not render (or trap focus into) the empty-state suggestions while the history overlay covers them', () => {
    render(<ChatWidget />);
    openPanel();
    const historyBtn = screen.getByRole('button', { name: 'Historial de conversaciones' });
    fireEvent.click(historyBtn);

    expect(screen.queryByTestId('chat-suggestion')).toBeNull();

    // Shift+Tab from the (still-focused) "Historial" button must wrap to the last
    // VISIBLE control ("Cerrar chat"), not to a suggestion button hidden behind
    // the overlay (getFocusableElements would otherwise still find it in the DOM).
    fireEvent.keyDown(screen.getByTestId('chat-panel'), { key: 'Tab', shiftKey: true });

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cerrar chat' }));
  });

  it('should trap Tab focus inside the panel (wrapping from the last to the first focusable element)', () => {
    render(<ChatWidget />);
    openPanel();

    const buttons = screen.getByTestId('chat-panel').querySelectorAll('button');
    const last = buttons[buttons.length - 1];
    const first = buttons[0];
    last.focus();

    fireEvent.keyDown(screen.getByTestId('chat-panel'), { key: 'Tab' });

    expect(document.activeElement).toBe(first);
  });

  it('should trap Shift+Tab focus inside the panel (wrapping from the first to the last focusable element)', () => {
    render(<ChatWidget />);
    openPanel();

    const buttons = screen.getByTestId('chat-panel').querySelectorAll('button');
    const last = buttons[buttons.length - 1];
    const first = buttons[0];
    first.focus();

    fireEvent.keyDown(screen.getByTestId('chat-panel'), { key: 'Tab', shiftKey: true });

    expect(document.activeElement).toBe(last);
  });

  it('should trap Shift+Tab even before focus moves off the panel container (immediately after opening)', () => {
    render(<ChatWidget />);
    openPanel();

    const panel = screen.getByTestId('chat-panel');
    // Focus lands on the panel container itself right after opening (AC6) —
    // not on any header button — so the trap must recognize it as the start too.
    expect(document.activeElement).toBe(panel);
    const buttons = panel.querySelectorAll('button');
    const last = buttons[buttons.length - 1];

    fireEvent.keyDown(panel, { key: 'Tab', shiftKey: true });

    expect(document.activeElement).toBe(last);
  });
});
