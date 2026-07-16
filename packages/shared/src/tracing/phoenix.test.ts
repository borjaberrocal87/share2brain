import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the vendor SDKs: unit tests never open a real OTel provider / Phoenix
// exporter / network, and never patch the real @langchain/core CallbackManager. Only
// the surface the adapter touches is stubbed. Shared spies live in vi.hoisted so the
// (hoisted) vi.mock factories and the test body reference the SAME instances.
const h = vi.hoisted(() => {
  const span = { setStatus: vi.fn(), recordException: vi.fn(), end: vi.fn() };
  // startActiveSpan(name, options, cb) → runs cb(span) and returns its result, exactly
  // like the real active-span API (so the callback's Promise is what withSpan returns).
  const startActiveSpan = vi.fn((_name: string, _options: unknown, cb: (s: typeof span) => unknown) =>
    cb(span),
  );
  const tracer = { startActiveSpan };
  const forceFlush = vi.fn().mockResolvedValue(undefined);
  const shutdown = vi.fn().mockResolvedValue(undefined);
  const register = vi.fn();
  const getTracer = vi.fn(() => tracer);
  // Constructed with `new`, so these need real function bodies (arrow functions
  // cannot be used as constructors). Returning an object replaces the instance.
  const NodeTracerProvider = vi.fn(function (config: unknown) {
    return { register, getTracer, forceFlush, shutdown, config };
  });
  const BatchSpanProcessor = vi.fn(function (exporter: unknown) {
    return { exporter };
  });
  const OTLPTraceExporter = vi.fn(function (cfg: { url: string }) {
    return { url: cfg.url };
  });
  const resourceFromAttributes = vi.fn((attrs: Record<string, unknown>) => ({ attrs }));
  const manuallyInstrument = vi.fn();
  const LangChainInstrumentation = vi.fn(function () {
    return { manuallyInstrument };
  });
  return {
    span,
    startActiveSpan,
    tracer,
    forceFlush,
    shutdown,
    register,
    getTracer,
    NodeTracerProvider,
    BatchSpanProcessor,
    OTLPTraceExporter,
    resourceFromAttributes,
    manuallyInstrument,
    LangChainInstrumentation,
  };
});

vi.mock('@opentelemetry/sdk-trace-node', () => ({
  NodeTracerProvider: h.NodeTracerProvider,
  BatchSpanProcessor: h.BatchSpanProcessor,
}));
vi.mock('@opentelemetry/exporter-trace-otlp-proto', () => ({ OTLPTraceExporter: h.OTLPTraceExporter }));
vi.mock('@opentelemetry/resources', () => ({ resourceFromAttributes: h.resourceFromAttributes }));
// SpanStatusCode is the only runtime value the adapter imports from the API (the rest
// are type-only, erased at compile time). Mirror the real numeric enum.
vi.mock('@opentelemetry/api', () => ({ SpanStatusCode: { UNSET: 0, OK: 1, ERROR: 2 } }));
vi.mock('@arizeai/openinference-instrumentation-langchain', () => ({
  LangChainInstrumentation: h.LangChainInstrumentation,
}));
vi.mock('@arizeai/openinference-semantic-conventions', () => ({
  SEMRESATTRS_PROJECT_NAME: 'openinference.project.name',
}));
// A stand-in for the module the instrumentation patches — the adapter imports it as a
// namespace and forwards it to manuallyInstrument; the test only asserts identity/shape.
vi.mock('@langchain/core/callbacks/manager', () => ({ CallbackManager: class {}, __marker: true }));

import { createLlmTracing } from './index.js';
import { createPhoenixLlmTracing } from './phoenix.js';
import { NoopLlmTracing, type LlmTracingProvider } from './tracing.js';

const ENDPOINT = 'http://phoenix:6006';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createLlmTracing (S-5 factory / composition root)', () => {
  it('returns the shared Noop and NEVER constructs a provider when the endpoint is empty (S-5, AC11)', () => {
    const tracing = createLlmTracing({ endpoint: '', service: 'backend' });

    expect(tracing).toBe(NoopLlmTracing);
    expect(h.NodeTracerProvider).not.toHaveBeenCalled();
    expect(h.LangChainInstrumentation).not.toHaveBeenCalled();
  });

  it('withSpan on the empty-endpoint Noop just runs fn (fully transparent, no span created)', async () => {
    const tracing = createLlmTracing({ endpoint: '', service: 'bot' });

    await expect(tracing.withSpan('x', {}, async () => 42)).resolves.toBe(42);
    expect(h.startActiveSpan).not.toHaveBeenCalled();
    await expect(tracing.flush()).resolves.toBeUndefined();
    await expect(tracing.shutdown()).resolves.toBeUndefined();
  });

  it('builds the Phoenix adapter for a non-empty endpoint (default provider)', () => {
    createLlmTracing({ endpoint: ENDPOINT, service: 'workers' });

    expect(h.NodeTracerProvider).toHaveBeenCalledTimes(1);
    expect(h.register).toHaveBeenCalledTimes(1);
  });

  it('fails safe to the shared Noop for an unrecognized provider (never crashes a boot)', () => {
    // The type + Zod enum admit only 'phoenix' today; cast past the type to reach the
    // fallthrough and prove it degrades to the Noop instead of throwing / constructing.
    const tracing = createLlmTracing({
      endpoint: ENDPOINT,
      service: 'backend',
      provider: 'langfuse' as LlmTracingProvider,
    });

    expect(tracing).toBe(NoopLlmTracing);
    expect(h.NodeTracerProvider).not.toHaveBeenCalled();
  });
});

describe('createPhoenixLlmTracing (adapter construction, AC3)', () => {
  it('wires resource, protobuf OTLP exporter, batch processor, register + manual instrumentation', () => {
    createPhoenixLlmTracing({ endpoint: ENDPOINT, service: 'backend' });

    // Resource carries the OpenInference project name + service.name (AC3).
    expect(h.resourceFromAttributes).toHaveBeenCalledWith({
      'openinference.project.name': 'share2brain',
      'service.name': 'backend',
    });
    // Exporter points at Phoenix's protobuf OTLP/HTTP collector: ${endpoint}/v1/traces.
    expect(h.OTLPTraceExporter).toHaveBeenCalledWith({ url: 'http://phoenix:6006/v1/traces' });
    // BatchSpanProcessor (NEVER Simple) wraps that exporter (AC13).
    expect(h.BatchSpanProcessor).toHaveBeenCalledTimes(1);
    const provider = h.NodeTracerProvider.mock.calls[0]![0] as { spanProcessors: unknown[] };
    expect(provider.spanProcessors).toHaveLength(1);
    // register() runs exactly once.
    expect(h.register).toHaveBeenCalledTimes(1);
  });

  it('registers the OpenInference LangChain instrumentation EXACTLY once with the CallbackManager module', () => {
    createPhoenixLlmTracing({ endpoint: ENDPOINT, service: 'workers' });

    expect(h.LangChainInstrumentation).toHaveBeenCalledTimes(1);
    // ops-6 review fix (the story's single most important line): the instrumentation MUST
    // be bound to OUR provider via the constructor `tracerProvider`, NOT the OTel global
    // (which @sentry/node registers first in the AD-8 boot slot). Pin it — without this
    // arg the OpenInference OITracer would emit through Sentry's tracer and the auto-spans
    // would be dropped, never reaching Phoenix.
    const providerInstance = h.NodeTracerProvider.mock.results[0]!.value as unknown;
    expect(h.LangChainInstrumentation).toHaveBeenCalledWith({ tracerProvider: providerInstance });
    expect(h.manuallyInstrument).toHaveBeenCalledTimes(1);
    const arg = h.manuallyInstrument.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg).toBeDefined();
    expect(arg).toHaveProperty('CallbackManager');
  });
});

describe('withSpan transparency contract (AC1/AC3 — the "test that lies")', () => {
  it("returns fn's value and marks the span OK, then ends it", async () => {
    const tracing = createPhoenixLlmTracing({ endpoint: ENDPOINT, service: 'backend' });

    await expect(tracing.withSpan('embeddings.embed_query', { count: 3 }, async () => 'result')).resolves.toBe(
      'result',
    );
    // OK status recorded (code 1) and the span ended — removing the `return result`
    // would make the resolves assertion fail.
    expect(h.span.setStatus).toHaveBeenCalledWith({ code: 1 });
    expect(h.span.end).toHaveBeenCalledTimes(1);
  });

  it("rethrows fn's error UNCHANGED, records the exception + ERROR status, and still ends the span", async () => {
    const tracing = createPhoenixLlmTracing({ endpoint: ENDPOINT, service: 'backend' });
    const boom = new Error('embedding failed');

    await expect(
      tracing.withSpan('pgvector.similarity_search', { 'db.top_k': 5 }, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom); // same error instance — removing the `throw err` would fail this
    expect(h.span.recordException).toHaveBeenCalledWith(boom);
    expect(h.span.setStatus).toHaveBeenCalledWith({ code: 2, message: 'embedding failed' });
    expect(h.span.end).toHaveBeenCalledTimes(1);
  });

  it('coerces attribute values (numbers/strings/arrays through; objects stringified; null dropped)', async () => {
    const tracing = createPhoenixLlmTracing({ endpoint: ENDPOINT, service: 'backend' });

    await tracing.withSpan(
      'embeddings.embed_documents',
      { 'embedding.batch_size': 12, tag: 'x', arr: [1, 2], obj: { a: 1 }, gone: null },
      async () => undefined,
    );

    const attrs = (h.startActiveSpan.mock.calls[0]![1] as { attributes: Record<string, unknown> })
      .attributes;
    expect(attrs).toEqual({ 'embedding.batch_size': 12, tag: 'x', arr: [1, 2], obj: '[object Object]' });
    expect(attrs).not.toHaveProperty('gone');
  });
});

// Port contract (mirrors the Observability port): a broken tracer/exporter must NEVER
// throw into the app — a tracing fault must not fail a chat turn or an indexing batch.
describe('the port never throws even when the tracer/exporter does', () => {
  it('runs fn transparently when startActiveSpan itself throws (tracing-side fault)', async () => {
    const tracing = createPhoenixLlmTracing({ endpoint: ENDPOINT, service: 'backend' });
    h.startActiveSpan.mockImplementationOnce(() => {
      throw new Error('tracer disarmed');
    });

    // fn still runs and its value still propagates.
    await expect(tracing.withSpan('x', {}, async () => 'ok')).resolves.toBe('ok');
  });

  it("does not let a span side-effect fault mask fn's thrown error", async () => {
    const tracing = createPhoenixLlmTracing({ endpoint: ENDPOINT, service: 'backend' });
    const boom = new Error('the real failure');
    h.span.recordException.mockImplementationOnce(() => {
      throw new Error('recordException disarmed');
    });

    // The caller sees fn's error, NOT the tracing fault.
    await expect(
      tracing.withSpan('x', {}, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });

  it("does not let span.end() throwing mask fn's return value", async () => {
    const tracing = createPhoenixLlmTracing({ endpoint: ENDPOINT, service: 'backend' });
    h.span.end.mockImplementationOnce(() => {
      throw new Error('end disarmed');
    });

    await expect(tracing.withSpan('x', {}, async () => 7)).resolves.toBe(7);
  });

  it('flush() forwards to provider.forceFlush and resolves', async () => {
    const tracing = createPhoenixLlmTracing({ endpoint: ENDPOINT, service: 'backend' });
    await expect(tracing.flush(500)).resolves.toBeUndefined();
    expect(h.forceFlush).toHaveBeenCalledTimes(1);
  });

  it('flush() never rejects even if forceFlush rejects', async () => {
    const tracing = createPhoenixLlmTracing({ endpoint: ENDPOINT, service: 'backend' });
    h.forceFlush.mockRejectedValueOnce(new Error('exporter down'));
    await expect(tracing.flush(500)).resolves.toBeUndefined();
  });

  it('shutdown() forwards to provider.shutdown and resolves', async () => {
    const tracing = createPhoenixLlmTracing({ endpoint: ENDPOINT, service: 'backend' });
    await expect(tracing.shutdown()).resolves.toBeUndefined();
    expect(h.shutdown).toHaveBeenCalledTimes(1);
  });

  it('shutdown() never rejects even if provider.shutdown rejects', async () => {
    const tracing = createPhoenixLlmTracing({ endpoint: ENDPOINT, service: 'backend' });
    h.shutdown.mockRejectedValueOnce(new Error('provider down'));
    await expect(tracing.shutdown()).resolves.toBeUndefined();
  });
});
