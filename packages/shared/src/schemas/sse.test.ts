import { describe, expect, it } from 'vitest';

import { SSEFrameSchema } from './sse.js';

describe('SSEFrameSchema', () => {
  it('should parse a token frame when it has content', () => {
    const result = SSEFrameSchema.safeParse({ type: 'token', content: 'hello' });
    expect(result.success).toBe(true);
  });

  it('should parse a citation frame with a valid HTTP(S) link', () => {
    const result = SSEFrameSchema.safeParse({
      type: 'citation',
      title: 'Deploying with Docker Compose',
      channel: 'general',
      author: 'ada',
      date: '2026-07-03T00:00:00Z',
      link: 'https://example.com/doc',
    });
    expect(result.success).toBe(true);
  });

  it('should reject a citation frame with an empty link', () => {
    const result = SSEFrameSchema.safeParse({
      type: 'citation',
      title: 'Deploying with Docker Compose',
      channel: 'general',
      author: 'ada',
      date: '2026-07-03T00:00:00Z',
      link: '',
    });
    expect(result.success).toBe(false);
  });

  it('should reject a citation frame with a non-URL non-empty link', () => {
    const result = SSEFrameSchema.safeParse({
      type: 'citation',
      title: 'Deploying with Docker Compose',
      channel: 'general',
      author: 'ada',
      date: '2026-07-03T00:00:00Z',
      link: 'not-a-url',
    });
    expect(result.success).toBe(false);
  });

  it('should reject a citation frame when link is missing', () => {
    const result = SSEFrameSchema.safeParse({
      type: 'citation',
      title: 'Deploying with Docker Compose',
      channel: 'general',
      author: 'ada',
      date: '2026-07-03T00:00:00Z',
    });
    expect(result.success).toBe(false);
  });

  it('should reject a citation frame with an empty title', () => {
    const result = SSEFrameSchema.safeParse({
      type: 'citation',
      title: '',
      channel: 'general',
      author: 'ada',
      date: '2026-07-03T00:00:00Z',
      link: 'https://example.com/doc',
    });
    expect(result.success).toBe(false);
  });

  it('should reject a citation frame with a whitespace-only title', () => {
    const result = SSEFrameSchema.safeParse({
      type: 'citation',
      title: '   ',
      channel: 'general',
      author: 'ada',
      date: '2026-07-03T00:00:00Z',
      link: 'https://example.com/doc',
    });
    expect(result.success).toBe(false);
  });

  it('should reject a citation frame when title is missing', () => {
    const result = SSEFrameSchema.safeParse({
      type: 'citation',
      channel: 'general',
      author: 'ada',
      date: '2026-07-03T00:00:00Z',
      link: 'https://example.com/doc',
    });
    expect(result.success).toBe(false);
  });

  it('should parse a done frame when it has a conversationId', () => {
    const result = SSEFrameSchema.safeParse({ type: 'done', conversationId: 'c-1' });
    expect(result.success).toBe(true);
  });

  it('should parse an error frame when it has code and message', () => {
    const result = SSEFrameSchema.safeParse({ type: 'error', code: 'E', message: 'boom' });
    expect(result.success).toBe(true);
  });

  it('should reject a frame with an unknown type', () => {
    const result = SSEFrameSchema.safeParse({ type: 'chunk', content: 'x' });
    expect(result.success).toBe(false);
  });

  it('should reject a token frame when content is missing', () => {
    const result = SSEFrameSchema.safeParse({ type: 'token' });
    expect(result.success).toBe(false);
  });

  it('should reject a citation frame when a required field is missing', () => {
    const result = SSEFrameSchema.safeParse({ type: 'citation', channel: 'general' });
    expect(result.success).toBe(false);
  });
});
