// Unit tests for the conversation application service — pagination math, title
// derivation, and the ownership → null path for detail. Uses a plain fake (no
// Drizzle, no Express): the service depends only on the domain port. Mirrors
// documentService.test.ts.
import { describe, expect, it, vi } from 'vitest';

import type {
  Conversation,
  ConversationRepository,
  ConversationSummaryRow,
  MessageRow,
} from '../../domain/repositories/conversationRepository.js';
import { createConversationService, deriveTitle } from './conversationService.js';

const TS = '2026-07-06T00:00:00.000Z';

function fakeRepo(overrides: Partial<ConversationRepository> = {}): ConversationRepository {
  return {
    createConversation: vi.fn(),
    getOwnedConversation: vi.fn(),
    appendMessage: vi.fn(),
    touchConversation: vi.fn(),
    listConversations: vi.fn(async () => []),
    countConversations: vi.fn(async () => 0),
    getMessages: vi.fn(async () => []),
    ...overrides,
  };
}

describe('deriveTitle', () => {
  it('should return the trimmed message when short', () => {
    expect(deriveTitle('  How do I deploy?  ')).toBe('How do I deploy?');
  });

  it('should collapse internal whitespace', () => {
    expect(deriveTitle('How   do\n\tI   deploy?')).toBe('How do I deploy?');
  });

  it('should truncate to 80 characters', () => {
    const long = 'a'.repeat(200);
    expect(deriveTitle(long)).toHaveLength(80);
  });

  it('should fall back to a stable Spanish title when the message is empty', () => {
    expect(deriveTitle('')).toBe('Nueva conversación');
  });

  it('should fall back when the message is only whitespace', () => {
    expect(deriveTitle('   \n\t  ')).toBe('Nueva conversación');
  });
});

describe('conversationService.listConversations', () => {
  const rows: ConversationSummaryRow[] = [
    { id: '550e8400-e29b-41d4-a716-446655440001', firstUserMessage: 'Second question', createdAt: TS, updatedAt: '2026-07-06T02:00:00.000Z' },
    { id: '550e8400-e29b-41d4-a716-446655440002', firstUserMessage: '', createdAt: TS, updatedAt: '2026-07-06T01:00:00.000Z' },
  ];

  it('should map rows to summaries with a derived title and pass through the DESC order', async () => {
    const repo = fakeRepo({
      listConversations: vi.fn(async () => rows),
      countConversations: vi.fn(async () => 2),
    });
    const service = createConversationService({ conversationRepo: repo });

    const result = await service.listConversations('user-1', 1, 20);

    expect(result).toEqual({
      results: [
        { id: rows[0].id, title: 'Second question', createdAt: TS, updatedAt: '2026-07-06T02:00:00.000Z' },
        { id: rows[1].id, title: 'Nueva conversación', createdAt: TS, updatedAt: '2026-07-06T01:00:00.000Z' },
      ],
      page: 1,
      limit: 20,
      total: 2,
    });
  });

  it('should compute the offset as (page-1)*limit', async () => {
    const listConversations = vi.fn(async () => []);
    const repo = fakeRepo({ listConversations, countConversations: vi.fn(async () => 0) });
    const service = createConversationService({ conversationRepo: repo });

    await service.listConversations('user-1', 3, 10);

    expect(listConversations).toHaveBeenCalledWith('user-1', 10, 20);
  });

  it('should return an empty page when the user has no conversations', async () => {
    const service = createConversationService({ conversationRepo: fakeRepo() });

    const result = await service.listConversations('user-1', 1, 20);

    expect(result).toEqual({ results: [], page: 1, limit: 20, total: 0 });
  });
});

describe('conversationService.getConversation', () => {
  const conversation: Conversation = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    userId: 'user-1',
    createdAt: TS,
    updatedAt: '2026-07-06T03:00:00.000Z',
  };
  const messages: MessageRow[] = [
    { id: '660e8400-e29b-41d4-a716-446655440001', role: 'user', content: 'hi', citations: [], createdAt: TS },
    {
      id: '660e8400-e29b-41d4-a716-446655440002',
      role: 'assistant',
      content: 'hello',
      citations: [{ channel: 'general', author: 'ada', date: TS, link: '' }],
      createdAt: '2026-07-06T00:01:00.000Z',
    },
  ];

  it('should return null when the conversation is not owned/unknown', async () => {
    const getMessages = vi.fn(async () => messages);
    const repo = fakeRepo({ getOwnedConversation: vi.fn(async () => null), getMessages });
    const service = createConversationService({ conversationRepo: repo });

    const result = await service.getConversation('user-1', 'unknown');

    expect(result).toBeNull();
    // No message fetch when ownership fails — cheap, and no leak.
    expect(getMessages).not.toHaveBeenCalled();
  });

  it('should return the detail with chronological messages when owned', async () => {
    const repo = fakeRepo({
      getOwnedConversation: vi.fn(async () => conversation),
      getMessages: vi.fn(async () => messages),
    });
    const service = createConversationService({ conversationRepo: repo });

    const result = await service.getConversation('user-1', conversation.id);

    expect(result).toEqual({
      id: conversation.id,
      createdAt: TS,
      updatedAt: '2026-07-06T03:00:00.000Z',
      messages: [
        { id: messages[0].id, role: 'user', content: 'hi', citations: [], createdAt: TS },
        {
          id: messages[1].id,
          role: 'assistant',
          content: 'hello',
          citations: [{ channel: 'general', author: 'ada', date: TS, link: '' }],
          createdAt: '2026-07-06T00:01:00.000Z',
        },
      ],
    });
  });
});
