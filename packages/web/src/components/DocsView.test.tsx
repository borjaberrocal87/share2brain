// Component tests for DocsView (Story 4.4, AC1-8). Mocks api/documents,
// api/readStatus and api/channels (mirror SearchView.test.tsx) — no network, no
// jest-dom matchers (toBeTruthy()/toBeNull(), per project testing rules).
// jsdom ignores external CSS, so exact fonts/box-shadow/grid are NOT asserted
// here — that gap is covered retroactively by the Story 4.5 Playwright harness.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DocumentFragment, DocumentsResponse } from '@hivly/shared/schemas';

import * as channelsApi from '../api/channels';
import * as documentsApi from '../api/documents';
import * as readStatusApi from '../api/readStatus';
import { DocsView } from './DocsView';

vi.mock('../api/channels', () => ({ fetchChannels: vi.fn() }));
vi.mock('../api/documents', () => ({ fetchDocuments: vi.fn() }));
vi.mock('../api/readStatus', () => ({ markRead: vi.fn(), markAll: vi.fn() }));

const fetchChannels = vi.mocked(channelsApi.fetchChannels);
const fetchDocuments = vi.mocked(documentsApi.fetchDocuments);
const markRead = vi.mocked(readStatusApi.markRead);
const markAll = vi.mocked(readStatusApi.markAll);

const DOC_UNREAD: DocumentFragment = {
  id: '550e8400-e29b-41d4-a716-446655440001',
  content: 'unread fragment content',
  channelId: 'chan-general',
  channelName: 'general',
  authorId: 'author-1',
  authorName: 'author-1',
  createdAt: '2026-07-06T00:00:00.000Z',
  indexedAt: '2026-07-06T01:00:00.000Z',
  messageId: 'msg-1',
  isRead: false,
};

const DOC_READ: DocumentFragment = {
  id: '550e8400-e29b-41d4-a716-446655440002',
  content: 'already read fragment',
  channelId: 'chan-general',
  channelName: 'general',
  authorId: 'author-2',
  authorName: 'author-2',
  createdAt: '2026-07-05T00:00:00.000Z',
  indexedAt: '2026-07-05T01:00:00.000Z',
  messageId: 'msg-2',
  isRead: true,
};

function page(results: DocumentFragment[], total: number): DocumentsResponse {
  return { results, page: 1, limit: 20, total };
}

function renderView(unreadCounts: Record<string, number> = {}) {
  const onUnreadChange = vi.fn();
  render(<DocsView unreadCounts={unreadCounts} onUnreadChange={onUnreadChange} />);
  return { onUnreadChange };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('DocsView', () => {
  it('should render the title, description and table header labels (AC1)', async () => {
    fetchChannels.mockResolvedValue([]);
    fetchDocuments.mockResolvedValue(page([], 0));

    renderView();

    expect(screen.getByText('Documentos indexados')).toBeTruthy();
    expect(await screen.findByText('chunk')).toBeTruthy();
    expect(screen.getByText('canal')).toBeTruthy();
    expect(screen.getByText('autor')).toBeTruthy();
    expect(screen.getByText('indexado')).toBeTruthy();
  });

  it('should render rows from the fetched page (AC2)', async () => {
    fetchChannels.mockResolvedValue([]);
    fetchDocuments.mockResolvedValue(page([DOC_UNREAD, DOC_READ], 2));

    renderView();

    expect(await screen.findByText('unread fragment content')).toBeTruthy();
    expect(screen.getByText('already read fragment')).toBeTruthy();
  });

  it('should mark an unread row read on click and call markRead with its id (AC3)', async () => {
    fetchChannels.mockResolvedValue([]);
    fetchDocuments.mockResolvedValue(page([DOC_UNREAD], 1));
    markRead.mockResolvedValue();

    renderView();
    const content = await screen.findByText('unread fragment content');
    const row = content.closest('.kh-doc-row') as HTMLElement;
    expect(row.dataset.read).toBe('false');

    fireEvent.click(row);

    expect(markRead).toHaveBeenCalledWith(DOC_UNREAD.id);
    expect(row.dataset.read).toBe('true');
  });

  it('should be a no-op when clicking an already-read row (D2)', async () => {
    fetchChannels.mockResolvedValue([]);
    fetchDocuments.mockResolvedValue(page([DOC_READ], 1));

    renderView();
    const content = await screen.findByText('already read fragment');
    const row = content.closest('.kh-doc-row') as HTMLElement;

    fireEvent.click(row);

    expect(markRead).not.toHaveBeenCalled();
  });

  it('should refetch with unreadOnly=true when the "Sin leer" toggle is clicked (AC4)', async () => {
    fetchChannels.mockResolvedValue([]);
    fetchDocuments.mockResolvedValue(page([DOC_UNREAD], 1));

    renderView({ 'chan-general': 1 });
    await screen.findByText('unread fragment content');

    fireEvent.click(screen.getByRole('button', { name: /Sin leer/i }));

    await vi.waitFor(() => expect(fetchDocuments.mock.calls.length).toBeGreaterThanOrEqual(2));
    const lastCall = fetchDocuments.mock.calls.at(-1);
    expect(lastCall?.[0].unreadOnly).toBe(true);
  });

  it('should refetch with channelId when a channel chip is clicked (AC5)', async () => {
    fetchChannels.mockResolvedValue([{ id: 'chan-general', name: 'general' }]);
    fetchDocuments.mockResolvedValue(page([DOC_UNREAD], 1));

    renderView();
    const chip = await screen.findByRole('button', { name: '#general' });
    fireEvent.click(chip);

    await screen.findByText('unread fragment content');
    const lastCall = fetchDocuments.mock.calls.at(-1);
    expect(lastCall?.[0].channelId).toBe('chan-general');
  });

  it('should append the next page on "Cargar más" and hide the button once fully loaded (AC8)', async () => {
    fetchChannels.mockResolvedValue([]);
    fetchDocuments.mockResolvedValueOnce(page([DOC_UNREAD], 2));
    fetchDocuments.mockResolvedValueOnce(page([DOC_READ], 2));

    renderView();
    await screen.findByText('unread fragment content');
    expect(screen.getByText('mostrando 1 de 2')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Cargar más' }));

    expect(await screen.findByText('already read fragment')).toBeTruthy();
    expect(screen.getByText('mostrando 2 de 2')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cargar más' })).toBeNull();
  });

  it('should show the empty state when "Sin leer" is on and there are no unread fragments (AC4)', async () => {
    fetchChannels.mockResolvedValue([]);
    fetchDocuments.mockResolvedValue(page([], 0));

    renderView();
    await screen.findByText('chunk');

    fireEvent.click(screen.getByRole('button', { name: /Sin leer/i }));

    expect(await screen.findByText('¡Estás al día! No te quedan fuentes sin leer.')).toBeTruthy();
    expect(
      screen.getByText('Quitá el filtro "Sin leer" para ver todo el conocimiento indexado.'),
    ).toBeTruthy();
  });

  it('should call markAll with the active channel and optimistically mark loaded rows read (AC6)', async () => {
    fetchChannels.mockResolvedValue([]);
    fetchDocuments.mockResolvedValue(page([DOC_UNREAD], 1));
    markAll.mockResolvedValue({ markedCount: 1 });

    const { onUnreadChange } = renderView({ 'chan-general': 1 });
    await screen.findByText('unread fragment content');

    fireEvent.click(screen.getByRole('button', { name: 'Marcar todas como leídas' }));

    expect(markAll).toHaveBeenCalledWith(undefined);
    await vi.waitFor(() => expect(onUnreadChange).toHaveBeenCalled());
  });

  // --- Regression tests for the code-review patches ---

  it('should render an error message and hide the footer when the documents fetch fails (Patch: error state)', async () => {
    fetchChannels.mockResolvedValue([]);
    fetchDocuments.mockRejectedValue(new Error('boom'));

    renderView();

    expect(await screen.findByText('No se pudieron cargar los documentos. Reintentá.')).toBeTruthy();
    expect(screen.queryByText(/^mostrando/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cargar más' })).toBeNull();
  });

  it('should revert loaded rows to unread when markAll fails, without dropping them (Patch: mark-all revert)', async () => {
    fetchChannels.mockResolvedValue([]);
    fetchDocuments.mockResolvedValue(page([DOC_UNREAD], 1));
    markAll.mockRejectedValue(new Error('boom'));

    const { onUnreadChange } = renderView({ 'chan-general': 1 });
    const content = await screen.findByText('unread fragment content');
    const row = content.closest('.kh-doc-row') as HTMLElement;
    expect(row.dataset.read).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: 'Marcar todas como leídas' }));
    // Optimistic flip to read.
    expect(row.dataset.read).toBe('true');

    // After the failure the row reverts to unread (and is preserved, not dropped).
    await vi.waitFor(() => expect(row.dataset.read).toBe('false'));
    expect(screen.getByText('unread fragment content')).toBeTruthy();
    await vi.waitFor(() => expect(onUnreadChange).toHaveBeenCalled());
  });

  it('should disable "Cargar más" while a filter-change reload is still loading (Patch: page-race guard)', async () => {
    fetchChannels.mockResolvedValue([{ id: 'chan-general', name: 'general' }]);
    fetchDocuments.mockResolvedValueOnce(page([DOC_UNREAD], 2)); // initial: total 2 → button shows
    let resolveReload: ((v: DocumentsResponse) => void) | undefined;
    fetchDocuments.mockReturnValueOnce(
      new Promise<DocumentsResponse>((r) => {
        resolveReload = r;
      }),
    );

    renderView();
    await screen.findByText('unread fragment content');
    expect((screen.getByRole('button', { name: 'Cargar más' }) as HTMLButtonElement).disabled).toBe(false);

    // Change filter → page-1 reload in flight (status='loading'); prior rows/total remain.
    fireEvent.click(screen.getByRole('button', { name: '#general' }));

    await vi.waitFor(() =>
      expect((screen.getByRole('button', { name: 'Cargar más' }) as HTMLButtonElement).disabled).toBe(true),
    );

    resolveReload?.(page([DOC_UNREAD], 1));
  });

  it('should swallow an aborted "Cargar más" on filter change without surfacing an error (Patch: loadMore abort)', async () => {
    fetchChannels.mockResolvedValue([{ id: 'chan-general', name: 'general' }]);
    fetchDocuments.mockResolvedValueOnce(page([DOC_UNREAD], 2)); // page 1 (todos)
    fetchDocuments.mockRejectedValueOnce(new DOMException('Aborted', 'AbortError')); // loadMore aborted
    fetchDocuments.mockResolvedValueOnce(page([DOC_READ], 1)); // channel page 1

    renderView();
    await screen.findByText('unread fragment content');

    fireEvent.click(screen.getByRole('button', { name: 'Cargar más' }));
    fireEvent.click(screen.getByRole('button', { name: '#general' }));

    expect(await screen.findByText('already read fragment')).toBeTruthy();
    expect(screen.queryByText('No se pudieron cargar los documentos. Reintentá.')).toBeNull();
  });
});
