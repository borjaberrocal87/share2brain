// Component tests for DocsView (Story 4.4, AC1-8). Mocks api/documents,
// api/readStatus and api/channels (mirror SearchView.test.tsx) — no network, no
// jest-dom matchers (toBeTruthy()/toBeNull(), per project testing rules).
// jsdom ignores external CSS, so exact fonts/box-shadow/grid are NOT asserted
// here — that gap is covered retroactively by the Story 4.5 Playwright harness.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DocumentFragment, DocumentsResponse } from '@share2brain/shared/schemas';

import * as channelsApi from '../api/channels';
import * as documentsApi from '../api/documents';
import * as readStatusApi from '../api/readStatus';
import i18n from '../i18n';
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
  title: 'Unread Fragment',
  description: 'unread fragment content',
  link: 'https://example.com/e2e/unread-fragment',
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
  title: 'Already Read Fragment',
  description: 'already read fragment',
  link: 'https://example.com/e2e/already-read-fragment',
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
  it('should render the title and 5-column table header labels (AC1, AC3)', async () => {
    fetchChannels.mockResolvedValue([]);
    fetchDocuments.mockResolvedValue(page([], 0));

    renderView();

    expect(screen.getByText('Documentos indexados')).toBeTruthy();
    expect(await screen.findByText('documento')).toBeTruthy();
    expect(screen.getByText('link')).toBeTruthy();
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

  it('should render the title and description stacked in the same cell on their own testids (AC2, D4)', async () => {
    fetchChannels.mockResolvedValue([]);
    fetchDocuments.mockResolvedValue(page([DOC_UNREAD], 1));

    renderView();

    const title = await screen.findByText('Unread Fragment');
    expect(title.getAttribute('data-testid')).toBe('doc-row-content');
    const description = screen.getByText('unread fragment content');
    expect(description.getAttribute('data-testid')).toBe('doc-row-description');
    // AC2/D4: both spans must live in the SAME documento cell — they share the
    // content wrapper as their parent. Guards against a regression that moves the
    // description back into its own standalone grid column.
    expect(title.parentElement).toBe(description.parentElement);
  });

  it('should render the title only, with no description node, when the description is empty (AC2, D5)', async () => {
    fetchChannels.mockResolvedValue([]);
    fetchDocuments.mockResolvedValue(page([{ ...DOC_UNREAD, description: '   ' }], 1));

    renderView();

    // Title still renders; the trimmed guard drops the description span entirely
    // (no empty/whitespace-only span with a stray marginTop gap).
    expect(await screen.findByText('Unread Fragment')).toBeTruthy();
    expect(screen.queryByTestId('doc-row-description')).toBeNull();
  });

  it('should switch title weight between unread and read while keeping the title color primary in both states (AC3)', async () => {
    fetchChannels.mockResolvedValue([]);
    fetchDocuments.mockResolvedValue(page([DOC_UNREAD, DOC_READ], 2));

    renderView();

    const unreadTitle = await screen.findByText('Unread Fragment');
    const readTitle = screen.getByText('Already Read Fragment');
    expect(unreadTitle.style.color).toBe('var(--text-primary)');
    expect(unreadTitle.style.fontWeight).toBe('700');
    expect(readTitle.style.color).toBe('var(--text-primary)');
    expect(readTitle.style.fontWeight).toBe('500');
  });

  it('should show the unread dot + "Nuevo" badge and hide the read checkmark on an unread row (AC2, D4)', async () => {
    fetchChannels.mockResolvedValue([]);
    fetchDocuments.mockResolvedValue(page([DOC_UNREAD], 1));

    renderView();
    const title = await screen.findByText('Unread Fragment');
    const row = title.closest('.kh-doc-row') as HTMLElement;

    expect(row.querySelector('[data-testid="doc-row-dot"]')).toBeTruthy();
    expect(row.querySelector('[data-testid="doc-row-check"]')).toBeNull();
    expect(row.querySelector('[data-testid="doc-row-new-badge"]')?.textContent).toBe('Nuevo');
  });

  it('should show the read checkmark and hide the unread dot + "Nuevo" badge on a read row (AC3, D4)', async () => {
    fetchChannels.mockResolvedValue([]);
    fetchDocuments.mockResolvedValue(page([DOC_READ], 1));

    renderView();
    const title = await screen.findByText('Already Read Fragment');
    const row = title.closest('.kh-doc-row') as HTMLElement;

    expect(row.querySelector('[data-testid="doc-row-check"]')).toBeTruthy();
    expect(row.querySelector('[data-testid="doc-row-dot"]')).toBeNull();
    expect(row.querySelector('[data-testid="doc-row-new-badge"]')).toBeNull();
  });

  it('should apply the amber row accent on unread rows and a transparent accent on read rows (AC2, AC3, D3)', async () => {
    fetchChannels.mockResolvedValue([]);
    fetchDocuments.mockResolvedValue(page([DOC_UNREAD, DOC_READ], 2));

    renderView();
    const unreadTitle = await screen.findByText('Unread Fragment');
    const unreadRow = unreadTitle.closest('.kh-doc-row') as HTMLElement;
    const readRow = screen.getByText('Already Read Fragment').closest('.kh-doc-row') as HTMLElement;

    expect(unreadRow.getAttribute('style')).toContain('inset 3px 0 0 #F5A623');
    expect(readRow.getAttribute('style')).toContain('inset 3px 0 0 transparent');
  });

  it('should link "ver recurso" to doc.link and mark the row read on click (AC3, F2, D6)', async () => {
    fetchChannels.mockResolvedValue([]);
    fetchDocuments.mockResolvedValue(page([DOC_UNREAD], 1));
    markRead.mockResolvedValue();

    renderView();
    await screen.findByText('unread fragment content');

    const link = screen.getByRole('link', { name: /ver recurso/i }) as HTMLAnchorElement;
    expect(link.href).toBe(DOC_UNREAD.link);

    fireEvent.click(link);

    expect(markRead).toHaveBeenCalledWith(DOC_UNREAD.id);
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
    await screen.findByText('documento');

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

describe('DocsView — en locale (Story 10.2, AC2)', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  afterEach(async () => {
    await i18n.changeLanguage('es');
  });

  it('should render the title and column headers in English', async () => {
    fetchChannels.mockResolvedValue([]);
    fetchDocuments.mockResolvedValue(page([], 0));

    renderView();

    expect(screen.getByText('Indexed documents')).toBeTruthy();
    expect(await screen.findByText('document')).toBeTruthy();
  });
});
