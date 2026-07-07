import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DocumentFragment, DocumentsResponse, UnreadCountResponse } from '@hivly/shared/schemas';

import { App } from './App';
import * as authApi from './api/auth';
import * as channelsApi from './api/channels';
import * as documentsApi from './api/documents';
import * as readStatusApi from './api/readStatus';

// Mock the fetch client (Story 2.4): tests drive the real session flow through
// fetchMe/logout without touching the network. LOGIN_URL keeps its real value.
vi.mock('./api/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api/auth')>();
  return { ...actual, fetchMe: vi.fn(), logout: vi.fn() };
});

// Story 4.4: the unread map is fetched once auth resolves, owned above the
// sidebar badge + the Documentos view. markRead/markAll are mocked so the
// Documentos view (mounted when navigating there) can trigger onUnreadChange.
vi.mock('./api/readStatus', () => ({ fetchUnreadCount: vi.fn(), markRead: vi.fn(), markAll: vi.fn() }));
vi.mock('./api/documents', () => ({ fetchDocuments: vi.fn() }));
vi.mock('./api/channels', () => ({ fetchChannels: vi.fn() }));

const fetchMe = vi.mocked(authApi.fetchMe);
const logout = vi.mocked(authApi.logout);
const fetchUnreadCount = vi.mocked(readStatusApi.fetchUnreadCount);
const markRead = vi.mocked(readStatusApi.markRead);
const fetchDocuments = vi.mocked(documentsApi.fetchDocuments);
const fetchChannels = vi.mocked(channelsApi.fetchChannels);

const emptyDocs: DocumentsResponse = { results: [], page: 1, limit: 20, total: 0 };

const PROFILE = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  discordId: '123456789012345678',
  username: 'ada lovelace',
  avatar: null,
  guildId: '111222333444555666',
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

fetchUnreadCount.mockResolvedValue({});
fetchChannels.mockResolvedValue([]);
fetchDocuments.mockResolvedValue(emptyDocs);
markRead.mockResolvedValue();

describe('App session flow', () => {
  it('should show the login screen when the session check returns 401 (anon)', async () => {
    fetchMe.mockResolvedValue(null);

    render(<App />);

    // The login screen appears once /me resolves; the authed shell (a <header>
    // banner) is NOT rendered.
    expect(await screen.findByRole('button', { name: /Continuar con Discord/i })).toBeTruthy();
    expect(screen.queryByRole('banner')).toBeNull();
  });

  it('should render the authenticated shell with the real username, initials and community name', async () => {
    fetchMe.mockResolvedValue(PROFILE);

    render(<App />);

    // The real username derived from the session profile.
    expect(await screen.findByText('ada lovelace')).toBeTruthy();
    // Initials derived from the username ("ada lovelace" → "AL").
    expect(screen.getByText('AL')).toBeTruthy();
    // Community name (build default) renders in the header banner (unambiguous:
    // "Hivly" also appears as the sidebar wordmark).
    expect(within(screen.getByRole('banner')).getByText('Hivly')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Continuar con Discord/i })).toBeNull();
  });

  it('should navigate to the login URL when the Discord button is clicked', async () => {
    fetchMe.mockResolvedValue(null);
    const original = window.location;
    Object.defineProperty(window, 'location', { value: { href: '' }, writable: true });

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /Continuar con Discord/i }));

    expect(window.location.href).toBe(authApi.LOGIN_URL);
    Object.defineProperty(window, 'location', { value: original, writable: true });
  });

  it('should return to the login screen after logout', async () => {
    fetchMe.mockResolvedValue(PROFILE);
    logout.mockResolvedValue();

    render(<App />);
    await screen.findByText('ada lovelace');

    fireEvent.click(screen.getByRole('button', { name: /Cerrar sesión/i }));

    expect(await screen.findByRole('button', { name: /Continuar con Discord/i })).toBeTruthy();
    await waitFor(() => expect(logout).toHaveBeenCalledOnce());
    expect(screen.queryByRole('banner')).toBeNull();
  });

  it('should switch the active content pane when a nav item is clicked (authed)', async () => {
    fetchMe.mockResolvedValue(PROFILE);

    render(<App />);
    // Default pane is Búsqueda once authenticated.
    expect(await screen.findByText('Búsqueda de conocimiento')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Documentos/i }));

    expect(screen.getByText('Documentos indexados')).toBeTruthy();
    expect(screen.queryByText('Búsqueda de conocimiento')).toBeNull();
  });

  it('should render the Documentos sidebar badge with the total unread count', async () => {
    fetchMe.mockResolvedValue(PROFILE);
    fetchUnreadCount.mockResolvedValue({ 'chan-1': 3, 'chan-2': 2 });

    render(<App />);
    await screen.findByText('ada lovelace');

    expect(await screen.findByText('5')).toBeTruthy();
  });

  it('should not render the Documentos sidebar badge when the unread total is 0', async () => {
    fetchMe.mockResolvedValue(PROFILE);
    fetchUnreadCount.mockResolvedValue({});

    render(<App />);
    await screen.findByText('ada lovelace');

    const navButton = screen.getByRole('button', { name: /Documentos/i });
    expect(within(navButton).queryByText(/^\d+$/)).toBeNull();
  });

  // Regression for the code-review patch: two overlapping unread-count refreshes
  // resolving out of order must not let a stale (older) response win the badge.
  it('should keep the latest unread count when two refreshes resolve out of order (Patch: generation token)', async () => {
    fetchMe.mockResolvedValue(PROFILE);
    const docUnread: DocumentFragment = {
      id: '550e8400-e29b-41d4-a716-446655440009',
      content: 'unread fragment content',
      channelId: 'chan-1',
      channelName: 'general',
      authorId: 'author-1',
      authorName: 'author-1',
      createdAt: '2026-07-06T00:00:00.000Z',
      indexedAt: '2026-07-06T01:00:00.000Z',
      messageId: 'msg-9',
      isRead: false,
    };
    fetchDocuments.mockResolvedValue({ results: [docUnread], page: 1, limit: 20, total: 1 });

    // call 1 (auth-mount refresh) resolves LATE with a stale value; call 2 (after
    // the row's markRead → onUnreadChange) resolves EARLY with the fresh value.
    let resolveMount: ((v: UnreadCountResponse) => void) | undefined;
    let resolveSecond: ((v: UnreadCountResponse) => void) | undefined;
    fetchUnreadCount
      .mockReturnValueOnce(new Promise<UnreadCountResponse>((r) => (resolveMount = r)))
      .mockReturnValueOnce(new Promise<UnreadCountResponse>((r) => (resolveSecond = r)));

    render(<App />);
    await screen.findByText('ada lovelace');
    fireEvent.click(screen.getByRole('button', { name: /Documentos/i }));

    const content = await screen.findByText('unread fragment content');
    fireEvent.click(content.closest('.kh-doc-row') as HTMLElement); // → markRead → refresh call 2

    await vi.waitFor(() => expect(fetchUnreadCount).toHaveBeenCalledTimes(2));

    // The newer refresh (call 2) resolves first with the fresh count.
    resolveSecond?.({ 'chan-1': 1 });
    await waitFor(() =>
      expect(within(screen.getByRole('button', { name: /Documentos/i })).queryByText('1')).toBeTruthy(),
    );

    // The stale mount refresh resolves late — its value must be ignored.
    resolveMount?.({ 'chan-1': 99 });
    await Promise.resolve();
    const nav = screen.getByRole('button', { name: /Documentos/i });
    expect(within(nav).queryByText('1')).toBeTruthy();
    expect(within(nav).queryByText('99')).toBeNull();
  });
});
