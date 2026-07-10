// Provider factory (AD-6). Builds the LLM chat model and the embeddings model
// from the validated Share2Brain config, so no service constructs a provider client
// directly. api_key and base_url are passed EXPLICITLY into the client
// constructors — we never rely on LangChain's implicit OPENAI_API_KEY /
// ANTHROPIC_API_KEY env-name lookup (our secrets are named LLM_API_KEY /
// EMBEDDINGS_API_KEY).
//
// This module is intentionally NOT re-exported from the root barrel or from
// /schemas: it pulls LangChain in transitively, and the browser bundle (web)
// plus config-only consumers (bot) must stay free of it. Import it via the
// dedicated "@share2brain/shared/providers" subpath only.
import { ChatAnthropic } from '@langchain/anthropic';
import type { Embeddings } from '@langchain/core/embeddings';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatOpenAI, OpenAIEmbeddings } from '@langchain/openai';

import type { Share2BrainConfig } from '../config/index.js';

function requireString(val: unknown, name: string): asserts val is string {
  if (typeof val !== 'string' || !val) {
    throw new Error(`Provider config error: ${name} must be a non-empty string`);
  }
}

/**
 * The structural shape `createChatModel` actually needs — satisfied by both
 * `Share2BrainConfig['agent']` and `Share2BrainConfig['enrichment']['llm']` (Epic 7), so the
 * Story 7.2+ enrichment pipeline can reuse this factory without agent-only fields
 * (`max_iterations`, `memory_window`) leaking into the type.
 */
export interface ChatModelConfig {
  provider: 'anthropic' | 'openai' | 'custom';
  model: string;
  temperature: number;
  base_url?: string;
  api_key: string;
}

/**
 * Build a chat model from an `agent`-shaped config (the RAG agent's `agent`
 * block, or Epic 7's `enrichment.llm` block).
 *
 * - `anthropic` → {@link ChatAnthropic} (native Anthropic API).
 * - `openai` / `custom` → {@link ChatOpenAI}; for `custom`, `base_url` points the
 *   OpenAI-compatible client at the operator's endpoint.
 *
 * Returns the LangChain base abstraction so consumers depend on the interface,
 * not the concrete provider class.
 */
export function createChatModel(agent: ChatModelConfig): BaseChatModel {
  const { provider, api_key, model, temperature, base_url } = agent;

  switch (provider) {
    case 'anthropic':
      requireString(api_key, 'agent.api_key');
      requireString(model, 'agent.model');
      return new ChatAnthropic({ apiKey: api_key, model, temperature });
    case 'openai':
    case 'custom':
      requireString(api_key, 'agent.api_key');
      requireString(model, 'agent.model');
      return new ChatOpenAI({
        apiKey: api_key,
        model,
        temperature,
        configuration: base_url ? { baseURL: base_url } : undefined,
      });
    default: {
      const exhaustive: never = provider;
      throw new Error(
        `Provider config error: unknown agent.provider "${exhaustive}". ` +
          `Expected "anthropic", "openai", or "custom".`,
      );
    }
  }
}

/**
 * Build the embeddings model from `embeddings` config. Both `openai` and
 * `custom` use the OpenAI-compatible client; `custom` sets `base_url`. Anthropic
 * is not a valid embeddings provider and is rejected at config-validation time.
 *
 * Returns the LangChain {@link Embeddings} base abstraction.
 */
export function createEmbeddingsModel(embeddings: Share2BrainConfig['embeddings']): Embeddings {
  const { provider, api_key, model, dimensions, base_url } = embeddings;

  switch (provider) {
    case 'openai':
    case 'custom':
      requireString(api_key, 'embeddings.api_key');
      requireString(model, 'embeddings.model');
      return new OpenAIEmbeddings({
        apiKey: api_key,
        model,
        dimensions,
        // Force plain-float responses. The OpenAI SDK otherwise requests
        // `encoding_format: "base64"` implicitly and decodes it client-side; an
        // OpenAI-compatible proxy (e.g. LiteLLM in front of a self-hosted model)
        // that ignores the param and returns a plain float array makes the SDK
        // mis-decode it into a corrupt, all-zero vector of the wrong length.
        // Asking for "float" keeps the wire format unambiguous for `custom` endpoints.
        encodingFormat: 'float',
        configuration: base_url ? { baseURL: base_url } : undefined,
      });
    default: {
      const exhaustive: never = provider;
      throw new Error(
        `Provider config error: unknown embeddings.provider "${exhaustive}". ` +
          `Expected "openai" or "custom".`,
      );
    }
  }
}

/**
 * Assert that a returned embedding vector has exactly the configured dimension
 * (AC-6). Story 3.3 calls this before UPSERT; on a throw it skips `XACK` so the
 * message is redelivered rather than persisted at the wrong width (protects
 * AD-13 and the fixed `vector(dimensions)` column).
 *
 * @throws {Error} when `vector` is null/undefined or `vector.length !== expected`.
 */
export function assertEmbeddingDimensions(vector: number[] | null | undefined, expected: number): void {
  if (vector == null) {
    throw new Error('Embedding dimension assertion failed: vector is null or undefined');
  }
  if (vector.length !== expected) {
    throw new Error(
      `Embedding dimension mismatch: got a vector of length ${vector.length}, ` +
        `expected ${expected}. The configured embeddings.dimensions and the model's ` +
        `output do not agree — refusing to persist.`,
    );
  }
}

/** Non-throwing companion to {@link assertEmbeddingDimensions} for callers that branch. */
export function isValidEmbeddingLength(vector: number[] | null | undefined, expected: number): boolean {
  return vector != null && vector.length === expected;
}
