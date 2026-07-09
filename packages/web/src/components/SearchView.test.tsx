// Component tests for SearchView (Story 4.3, AC1-6). Mocks the api/search and
// api/channels clients (mirror App.test.tsx's vi.mock pattern) — no network, no
// jest-dom matchers (toBeTruthy()/toBeNull(), per project testing rules).
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SearchFragment } from '@hivly/shared/schemas';

import * as channelsApi from '../api/channels';
import * as searchApi from '../api/search';
import { SearchView } from './SearchView';

vi.mock('../api/channels', () => ({ fetchChannels: vi.fn() }));
vi.mock('../api/search', () => ({ search: vi.fn() }));

const fetchChannels = vi.mocked(channelsApi.fetchChannels);
const search = vi.mocked(searchApi.search);

const GUILD_ID = '999888777666555444';

const FRAGMENT_GENERAL: SearchFragment = {
  id: '550e8400-e29b-41d4-a716-446655440001',
  title: 'The Answer to Everything',
  description: 'the answer is 42',
  link: 'https://example.com/e2e/the-answer',
  channelId: 'chan-general',
  channelName: 'general',
  authorId: 'author-1',
  authorName: 'author-1',
  createdAt: '2026-07-06T00:00:00.000Z',
  similarity: 0.87,
  messageId: 'msg-1',
};

const FRAGMENT_RANDOM: SearchFragment = {
  id: '550e8400-e29b-41d4-a716-446655440002',
  title: 'Unrelated Topic',
  description: 'unrelated content',
  link: 'https://example.com/e2e/unrelated-topic',
  channelId: 'chan-random',
  channelName: 'random',
  authorId: 'author-2',
  authorName: 'author-2',
  createdAt: '2026-07-05T00:00:00.000Z',
  similarity: 0.5,
  messageId: 'msg-2',
};

const CHANNELS = [
  { id: 'chan-general', name: 'general' },
  { id: 'chan-random', name: 'random' },
];

function typeQuery(value: string): void {
  fireEvent.change(screen.getByPlaceholderText('¿Cómo configuro los canales a indexar?'), {
    target: { value },
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SearchView', () => {
  it('should render the header title and description on load (AC1)', () => {
    fetchChannels.mockResolvedValue([]);
    render(<SearchView guildId={GUILD_ID} />);

    expect(screen.getByText('Búsqueda de conocimiento')).toBeTruthy();
  });

  it('should run no request and render neither results nor the empty state for a query under 2 chars (AC3)', async () => {
    fetchChannels.mockResolvedValue([]);
    render(<SearchView guildId={GUILD_ID} />);

    typeQuery('h');
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(search).not.toHaveBeenCalled();
    expect(screen.queryByText(/resultados/)).toBeNull();
    expect(screen.queryByText('Sin coincidencias en el conocimiento indexado.')).toBeNull();
  });

  it('should call search and render the result count + card content for a query of at least 2 chars (AC3, AC4)', async () => {
    fetchChannels.mockResolvedValue([]);
    search.mockResolvedValue({ results: [FRAGMENT_GENERAL] });
    render(<SearchView guildId={GUILD_ID} />);

    typeQuery('hola');

    expect(await screen.findByText('the answer is 42')).toBeTruthy();
    expect(screen.getByText('1 resultados')).toBeTruthy();
    expect(screen.getByText('ordenado por similitud')).toBeTruthy();
    expect(screen.getByText('#general')).toBeTruthy();
  });

  it('should render the empty state when a search returns 0 results (AC6)', async () => {
    fetchChannels.mockResolvedValue([]);
    search.mockResolvedValue({ results: [] });
    render(<SearchView guildId={GUILD_ID} />);

    typeQuery('nothing here');

    expect(
      await screen.findByText('Sin coincidencias en el conocimiento indexado.'),
    ).toBeTruthy();
    expect(screen.getByText('Probá con otros términos o consultá al agente en el chat.')).toBeTruthy();
  });

  it('should filter the visible cards client-side when a channel chip is clicked (AC5)', async () => {
    fetchChannels.mockResolvedValue(CHANNELS);
    search.mockResolvedValue({ results: [FRAGMENT_GENERAL, FRAGMENT_RANDOM] });
    render(<SearchView guildId={GUILD_ID} />);

    typeQuery('hola');
    await screen.findByText('the answer is 42');
    expect(screen.getByText('unrelated content')).toBeTruthy();

    const generalChip = await screen.findByRole('button', { name: '#general' });
    fireEvent.click(generalChip);

    expect(screen.getByText('the answer is 42')).toBeTruthy();
    expect(screen.queryByText('unrelated content')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'todos' }));
    expect(screen.getByText('unrelated content')).toBeTruthy();
  });

  it('should link "ver en Discord" to the correct guild/channel/message URL (AC4)', async () => {
    fetchChannels.mockResolvedValue([]);
    search.mockResolvedValue({ results: [FRAGMENT_GENERAL] });
    render(<SearchView guildId={GUILD_ID} />);

    typeQuery('hola');
    await screen.findByText('the answer is 42');

    const link = screen.getByRole('link', { name: /ver en Discord/i }) as HTMLAnchorElement;
    expect(link.href).toBe(
      `https://discord.com/channels/${GUILD_ID}/${FRAGMENT_GENERAL.channelId}/${FRAGMENT_GENERAL.messageId}`,
    );
  });

  it('should render the resource title as a heading above the description (AC2)', async () => {
    fetchChannels.mockResolvedValue([]);
    search.mockResolvedValue({ results: [FRAGMENT_GENERAL] });
    render(<SearchView guildId={GUILD_ID} />);

    typeQuery('hola');

    expect(await screen.findByText('The Answer to Everything')).toBeTruthy();
    expect(screen.getByText('the answer is 42')).toBeTruthy();
  });

  it('should link "ver recurso" to the fragment link (AC2)', async () => {
    fetchChannels.mockResolvedValue([]);
    search.mockResolvedValue({ results: [FRAGMENT_GENERAL] });
    render(<SearchView guildId={GUILD_ID} />);

    typeQuery('hola');
    await screen.findByText('The Answer to Everything');

    const link = screen.getByRole('link', { name: /ver recurso/i }) as HTMLAnchorElement;
    expect(link.href).toBe(FRAGMENT_GENERAL.link);
  });
});
