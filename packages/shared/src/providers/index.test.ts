import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAI, OpenAIEmbeddings } from '@langchain/openai';
import { describe, expect, it } from 'vitest';

import type { Share2BrainConfig } from '../config/index.js';

import { assertEmbeddingDimensions, createChatModel, createEmbeddingsModel } from './index.js';

const baseAgent: Share2BrainConfig['agent'] = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  temperature: 0.7,
  max_iterations: 10,
  memory_window: 20,
  api_key: 'sk-ant-test',
};

const baseEmbeddings: Share2BrainConfig['embeddings'] = {
  provider: 'openai',
  model: 'text-embedding-3-small',
  dimensions: 1536,
  api_key: 'sk-openai-test',
  timeout_ms: 60_000,
};

describe('createChatModel', () => {
  it('should return a ChatAnthropic when provider is "anthropic"', () => {
    const model = createChatModel({ ...baseAgent, provider: 'anthropic' });

    expect(model).toBeInstanceOf(ChatAnthropic);
  });

  it('should return a ChatOpenAI when provider is "openai"', () => {
    const model = createChatModel({ ...baseAgent, provider: 'openai' });

    expect(model).toBeInstanceOf(ChatOpenAI);
  });

  it('should return a ChatOpenAI with the configured baseURL when provider is "custom"', () => {
    const model = createChatModel({
      ...baseAgent,
      provider: 'custom',
      base_url: 'https://llm.internal/v1',
    });

    expect(model).toBeInstanceOf(ChatOpenAI);
    expect((model as ChatOpenAI).clientConfig.baseURL).toBe('https://llm.internal/v1');
  });
});

describe('createEmbeddingsModel', () => {
  it('should return an OpenAIEmbeddings for the "openai" provider', () => {
    const model = createEmbeddingsModel({ ...baseEmbeddings, provider: 'openai' });

    expect(model).toBeInstanceOf(OpenAIEmbeddings);
    expect((model as OpenAIEmbeddings).model).toBe('text-embedding-3-small');
    expect((model as OpenAIEmbeddings).dimensions).toBe(1536);
  });

  it('should return an OpenAIEmbeddings for the "custom" provider', () => {
    const model = createEmbeddingsModel({
      ...baseEmbeddings,
      provider: 'custom',
      base_url: 'https://emb.internal/v1',
    });

    expect(model).toBeInstanceOf(OpenAIEmbeddings);
  });

  // Regression: the OpenAI SDK implicitly requests encoding_format:"base64" and
  // decodes it client-side. An OpenAI-compatible proxy (e.g. LiteLLM in front of
  // a self-hosted model) that ignores the param and returns a plain float array
  // makes the SDK mis-decode it into a corrupt, all-zero vector of the wrong
  // length. Pinning "float" keeps the wire format unambiguous for custom endpoints.
  it.each(['openai', 'custom'] as const)(
    'should pin encodingFormat to "float" for the "%s" provider',
    (provider) => {
      const model = createEmbeddingsModel({
        ...baseEmbeddings,
        provider,
        base_url: provider === 'custom' ? 'https://emb.internal/v1' : undefined,
      });

      expect((model as OpenAIEmbeddings).encodingFormat).toBe('float');
    },
  );

  // AUDIT M4: the embeddings client must carry the configured request timeout so a
  // stalled provider can't wedge the sequential Indexer/Sync loop (or a search).
  it('should pass the configured timeout_ms through to the embeddings client', () => {
    const model = createEmbeddingsModel({ ...baseEmbeddings, timeout_ms: 12_345 });

    expect((model as OpenAIEmbeddings).timeout).toBe(12_345);
  });
});

describe('assertEmbeddingDimensions', () => {
  it('should not throw when the vector length matches the expected dimension', () => {
    expect(() => assertEmbeddingDimensions(new Array(1536).fill(0), 1536)).not.toThrow();
  });

  it('should throw a descriptive error naming both lengths on a mismatch', () => {
    expect(() => assertEmbeddingDimensions(new Array(768).fill(0), 1536)).toThrow(/768.*1536|1536.*768/);
  });

  it('should throw when the vector is null', () => {
    expect(() => assertEmbeddingDimensions(null, 1536)).toThrow(/null or undefined/);
  });

  it('should throw when the vector is undefined', () => {
    expect(() => assertEmbeddingDimensions(undefined, 1536)).toThrow(/null or undefined/);
  });
});
