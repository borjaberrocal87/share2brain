import { describe, expect, it } from 'vitest';

import type { SearchFragment } from '@hivly/shared/schemas';

import { buildRAGContext, SYSTEM_PROMPT } from './prompt.js';

function fakeFragment(overrides: Partial<SearchFragment> = {}): SearchFragment {
  return {
    id: '550e8400-e29b-41d4-a716-446655440000',
    title: 'Deploying with Docker Compose',
    description: 'A guide to deploying the stack with Docker Compose',
    link: 'https://example.com/e2e/deploying-with-docker-compose',
    channelId: 'chan-1',
    channelName: 'general',
    authorId: 'author-1',
    authorName: 'ada',
    createdAt: '2026-07-06T00:00:00.000Z',
    similarity: 0.9,
    messageId: 'msg-1',
    ...overrides,
  };
}

describe('SYSTEM_PROMPT', () => {
  it('should instruct the model to ground answers only in the provided resources', () => {
    expect(SYSTEM_PROMPT).toMatch(/ONLY the curated community resources/i);
    expect(SYSTEM_PROMPT).toMatch(/do not use outside knowledge/i);
  });

  it('should instruct the model to include the resource link when recommending a resource', () => {
    expect(SYSTEM_PROMPT).toMatch(/include its link/i);
  });

  it('should instruct the model to admit when it has no relevant resource', () => {
    expect(SYSTEM_PROMPT).toMatch(/don't have enough information/i);
  });
});

describe('buildRAGContext', () => {
  it('should render a single fragment with the [n] #channel — author (date) header and title — description (link) line', () => {
    const context = buildRAGContext([fakeFragment()]);

    expect(context).toContain(
      '[1] #general — ada (2026-07-06T00:00:00.000Z):\nDeploying with Docker Compose — A guide to deploying the stack with Docker Compose (https://example.com/e2e/deploying-with-docker-compose)',
    );
  });

  it('should number multiple fragments sequentially starting at [1]', () => {
    const context = buildRAGContext([
      fakeFragment({ title: 'First Resource' }),
      fakeFragment({ title: 'Second Resource' }),
    ]);

    expect(context).toContain('[1] #general');
    expect(context).toContain('First Resource');
    expect(context).toContain('[2] #general');
    expect(context).toContain('Second Resource');
  });

  it('should speak of "resources", not "knowledge fragments", when nothing was retrieved', () => {
    const context = buildRAGContext([]);

    expect(context).toBe('No relevant resources were found for this question.');
    expect(context).not.toMatch(/knowledge fragment/i);
  });
});
