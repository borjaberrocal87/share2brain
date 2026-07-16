// Vendor-neutral LlmTracing PORT (Story ops-6). A DELIBERATELY SEPARATE seam from
// the ops-5 `Observability` port (D1, Interface Segregation): `Observability` +
// the Sentry adapter keep errors + logs; this port carries LLM/embeddings inference
// TRACES (spans with model, tokens, latency, prompt/completion) to a self-hosted
// collector. Neither the `Observability` port, the Sentry adapter, the logger, nor
// `redactSecrets` is touched by this story. As with `Observability`, no vendor name
// (Phoenix/OTel/Arize) appears in this type or its members — that is the whole point
// (DIP / Open–Closed): a second provider is a new adapter file + one factory branch +
// one config value, with ZERO edits to `backend`/`bot`/`workers`/`web`.

/** The providers `createLlmTracing` can select. Grows by one literal per new
 *  adapter; kept in sync with the `observability.tracing.provider` Zod enum in
 *  `../config/index.ts` (hand-synced, two sources of truth — mirrors
 *  `ObservabilityProvider`). */
export type LlmTracingProvider = 'phoenix';

/**
 * The LLM-tracing seam consumed by `backend` and `workers` (D3 — the bot makes no
 * LLM calls). An adapter wraps an operation in a span, and drains/tears-down its
 * exporter on flush/shutdown. Auto-instrumentation (OpenInference LangChain) captures
 * every `@langchain/core` model call transparently; `withSpan` is for the calls that
 * layer cannot see (embeddings, the pgvector similarity query).
 *
 * CONTRACT (mirrors `Observability`): tracing is best-effort — NO method throws and
 * `flush`/`shutdown` never reject. `withSpan` is TRANSPARENT: `fn`'s return value and
 * `fn`'s thrown error ALWAYS propagate unchanged; only a *tracing* fault (a broken
 * tracer/exporter) is swallowed, never masking or altering the wrapped operation.
 * A tracing fault must never fail a chat turn or an indexing batch. Callers never
 * need a try/catch. Span ATTRIBUTES at call sites carry counts/params only — message
 * content belongs to the auto-instrumentation layer (SNF-18).
 */
export interface LlmTracing {
  /** Wrap an operation in a span. TRANSPARENT: fn's result/error always propagate;
   *  tracing faults are swallowed. Attributes: counts/params only (SNF-18). */
  withSpan<T>(name: string, attributes: Record<string, unknown>, fn: () => Promise<T>): Promise<T>;
  /** Force-flush buffered spans, bounded; never rejects. */
  flush(timeoutMs?: number): Promise<void>;
  /** Tear down the exporter/provider; never rejects. Wired into graceful shutdown. */
  shutdown(): Promise<void>;
}

/**
 * Shared no-op adapter — the S-5 empty-endpoint behavior (mirrors
 * `NoopObservability`). `withSpan` just runs and returns `fn()` (transparent — no span
 * object is ever created), and `flush`/`shutdown` resolve immediately. A service booted
 * without a tracing endpoint behaves exactly as it did before any tracing existed: no
 * OTel object, no instrumentation patch, zero network.
 *
 * `withSpan` is `async` so a SYNCHRONOUS throw in `fn` surfaces as a rejected promise —
 * identical to the Phoenix adapter (which routes `fn` through `async runInSpan`) and to
 * the port's `Promise<T>` contract. A bare `fn()` would throw synchronously here while the
 * real adapter rejects, so a caller that does `.catch(...)` without `await` (or
 * `Promise.all([...])`) would diverge between tracing-off and tracing-on.
 */
export const NoopLlmTracing: LlmTracing = {
  withSpan: async (_name, _attrs, fn) => fn(),
  flush: async () => undefined,
  shutdown: async () => undefined,
};
