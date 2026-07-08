import { describe, expect, it } from 'vitest';

import type { ChatTurn } from '../domain/repositories/chatModel.js';
import { assertSingleLeadingSystem } from './chatModel.langchain.js';

// The structural guard for the Anthropic contract "a 'system' message can only
// appear at index 0". Tested directly (the real adapter talks to a live provider
// and is not exercised in CI, so this pure function is where the invariant fails
// loud in CI). Mirrors the multi-system defect surfaced in the Epic 5 retro.
describe('assertSingleLeadingSystem', () => {
  it('accepts exactly one system message at index 0', () => {
    const messages: ChatTurn[] = [
      { role: 'system', content: 'grounding + rag' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'follow-up' },
    ];
    expect(() => assertSingleLeadingSystem(messages)).not.toThrow();
  });

  it('accepts a prompt with no system message', () => {
    const messages: ChatTurn[] = [{ role: 'user', content: 'hi' }];
    expect(() => assertSingleLeadingSystem(messages)).not.toThrow();
  });

  it('rejects two system messages (the compression-path regression)', () => {
    const messages: ChatTurn[] = [
      { role: 'system', content: 'grounding + rag' },
      { role: 'system', content: '<conversation summary> ...' },
      { role: 'user', content: 'follow-up' },
    ];
    expect(() => assertSingleLeadingSystem(messages)).toThrow(/only one leading system message/);
  });

  it('rejects a single system message at a non-zero index', () => {
    const messages: ChatTurn[] = [
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'grounding' },
    ];
    expect(() => assertSingleLeadingSystem(messages)).toThrow(/non-zero index/);
  });
});
