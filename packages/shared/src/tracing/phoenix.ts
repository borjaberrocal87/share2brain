// Arize Phoenix ADAPTER for the LlmTracing port (Story ops-6). `@opentelemetry/*`
// and `@arizeai/*` live ONLY in this file (AD-2, grep-green rule mirroring
// `@sentry/node` in `observability/sentry.ts`): the services depend on the
// vendor-neutral `LlmTracing` port from `./tracing.js`, never on OTel/Arize, and
// never on each other. Obtained via `createPhoenixLlmTracing` — itself only reached
// through `createLlmTracing` in `./index.js`.
//
// SDK 2.x idioms (see the story's § Resolved versions — the OpenInference README
// still shows the pre-2.x pattern, which will NOT compile): the `Resource` class is
// gone → `resourceFromAttributes()`; `addSpanProcessor()` is gone → `spanProcessors`
// in the provider constructor. OTLP over PROTOBUF (`-proto`) on `${endpoint}/v1/traces`
// — Phoenix's OTLP/HTTP collector expects protobuf on its UI port (6006), not JSON.
//
// GLOBAL SIDE EFFECTS (register + CallbackManager patch) happen ONLY inside
// `createPhoenixLlmTracing`, never at module top level (AC11): a service booted with
// an empty endpoint imports this module (the factory in index.ts is static) but never
// calls this function, so nothing OTel/Arize is constructed or registered.
//
// We deliberately do NOT touch OTel's GLOBAL `diag` logger: `@opentelemetry/api`'s
// diag defaults to a no-op, so a down/unreachable collector stays silent on its own
// (tracing is best-effort, SNF-18). The `@opentelemetry/api` copy is shared with the
// ops-5 Sentry adapter's OTel; globally re-configuring diag here would reach across
// into that seam (violates D1), so we leave it alone.
import { LangChainInstrumentation } from '@arizeai/openinference-instrumentation-langchain';
import { SEMRESATTRS_PROJECT_NAME } from '@arizeai/openinference-semantic-conventions';
import { SpanStatusCode, type Attributes, type Span } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
// The module the OpenInference instrumentation patches. LangChain exposes no
// patchable module structure, so registration is MANUAL (`manuallyInstrument`) — see
// § Resolved versions. Importing it as a namespace gives the exact object the
// instrumentation must patch; the workspace must resolve a SINGLE @langchain/core
// copy or the patched CallbackManager won't be the one the graph runs (gate check
// `npm ls @langchain/core`).
import * as CallbackManagerModule from '@langchain/core/callbacks/manager';

import type { LlmTracing } from './tracing.js';

/** The tracer name/scope stamped on manual spans (embeddings, pgvector). */
const TRACER_SCOPE = '@share2brain/shared/tracing';
/** The OpenInference project Phoenix groups these traces under (no server-side env var). */
const PROJECT_NAME = 'share2brain';

/**
 * Coerce the port's `Record<string, unknown>` attributes to OTel's `Attributes`
 * (string/number/boolean or arrays thereof). Call sites carry counts/params only
 * (SNF-18, AC9), so this is mostly a type bridge; any exotic value is stringified
 * rather than dropped. null/undefined are omitted.
 */
function toOtelAttributes(attributes: Record<string, unknown>): Attributes {
  const out: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    } else if (
      Array.isArray(value) &&
      value.every((v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
    ) {
      out[key] = value as string[] | number[] | boolean[];
    } else {
      out[key] = String(value);
    }
  }
  return out;
}

/**
 * Run a span-side effect that must NEVER throw into the caller (mirrors `guard()`
 * in `sentry.ts`). A fault in `recordException`/`setStatus`/`end` must not mask
 * `fn`'s own error or return value — the port's transparency contract. Swallows
 * silently: this is the per-operation hot path and a tracing fault is not the app's
 * concern.
 */
function guardSpan(fn: () => void): void {
  try {
    fn();
  } catch {
    // Best-effort: a broken tracer/span must never fail a chat turn or a batch.
  }
}

/**
 * Await a tracing-teardown promise, bounded so a hung exporter can't wedge shutdown,
 * and never reject (mirrors the Sentry adapter's `flush`). A tracing fault must never
 * mask the reason we are flushing/exiting.
 */
async function bounded(op: () => Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve()
        .then(op)
        .then(() => undefined)
        .catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } catch {
    // Never let tracing teardown throw.
  } finally {
    // Clear the race timer on the fast path (op won): the helper must not keep the event
    // loop alive on its own, so it stays correct even if a caller ever invokes flush/
    // shutdown outside an immediate-exit path.
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Build the Phoenix adapter for the LlmTracing port. Called (indirectly, via
 * `createLlmTracing`) once per process in `main.ts`, in the AD-8 boot slot — after
 * `loadConfig()`/`createObservability`/`createLogger`, before any network I/O AND
 * before any LangChain model is constructed (so the CallbackManager patch is in
 * place before any chain runs). The caller guarantees a non-empty `endpoint`
 * (`createLlmTracing` routes an empty endpoint to `NoopLlmTracing`, S-5).
 *
 * The constructor is deliberately UNGUARDED (same rule as `Sentry.init`): a bad
 * endpoint/registration is a boot-time misconfiguration that SHOULD fail loud (AD-8),
 * not silently produce a half-armed tracer. Only the runtime surface (`withSpan`,
 * `flush`, `shutdown`) swallows its own faults.
 */
export function createPhoenixLlmTracing(opts: { endpoint: string; service: string }): LlmTracing {
  const { endpoint, service } = opts;

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [SEMRESATTRS_PROJECT_NAME]: PROJECT_NAME,
      'service.name': service,
    }),
    // BatchSpanProcessor (NEVER SimpleSpanProcessor, AC13): spans export
    // asynchronously off the hot path, so the SSE first-chunk latency (SNF-3) is
    // never blocked by a synchronous per-span/per-token export.
    spanProcessors: [
      // Append `/v1/traces` to the collector root, stripping only a trailing slash so a
      // slash in the endpoint can't produce `…//v1/traces` (a silent 404 the best-effort
      // exporter would swallow). APPEND (not `new URL('/v1/traces', endpoint)`, which would
      // discard a deliberate subpath): this mirrors the standard OTLP
      // `OTEL_EXPORTER_OTLP_ENDPOINT` semantics, so Phoenix behind a reverse-proxy subpath
      // (`http://host/phoenix`) resolves to `http://host/phoenix/v1/traces`.
      new BatchSpanProcessor(
        new OTLPTraceExporter({ url: `${endpoint.replace(/\/+$/, '')}/v1/traces` }),
      ),
    ],
  });
  provider.register();

  // Register the OpenInference LangChain auto-instrumentation ONCE at creation. This
  // patches @langchain/core's CallbackManager, so every model call that flows through
  // it — the RAG `reason` node, `respond` streaming, `compress.ts`, workers `enrich.ts`
  // — is auto-traced with prompt/completion/token/latency attributes (D2), with NO
  // edit to any business module.
  //
  // Bind the instrumentation to OUR `provider` explicitly (constructor `tracerProvider`),
  // never the OTel GLOBAL tracer. The ops-5 Sentry adapter (@sentry/node) runs first in
  // the AD-8 boot slot and unconditionally registers its own TracerProvider as the OTel
  // global, so our `provider.register()` above no-ops (OTel refuses to overwrite an
  // already-registered global) — leaving the global pointing at Sentry's tracer. Without
  // this binding the auto-instrumented spans would be created by Sentry's tracer and
  // dropped (Sentry has no tracesSampleRate), never reaching Phoenix. OpenInference builds
  // its span-emitting OITracer from `tracerProvider.getTracer(...)` AT CONSTRUCTION, so the
  // provider MUST be passed to the constructor (a later `setTracerProvider` would not
  // rebuild that tracer). Keeps D1 intact — no edit to the Sentry seam.
  new LangChainInstrumentation({ tracerProvider: provider }).manuallyInstrument(CallbackManagerModule);

  const tracer = provider.getTracer(TRACER_SCOPE);

  return {
    // Start an ACTIVE span (nests under any live auto-instrumented trace) around
    // `fn`. TRANSPARENT: `fn`'s value is returned, `fn`'s error is rethrown
    // unchanged with the exception + error status recorded, and the span always
    // ends. Every tracing-side call is guarded so a broken tracer never alters the
    // wrapped operation.
    withSpan: <T>(name: string, attributes: Record<string, unknown>, fn: () => Promise<T>): Promise<T> => {
      // Capture runInSpan's promise as we enter the callback. If startActiveSpan faults
      // (tracing-side) BEFORE the callback runs, `started` stays undefined and we run `fn`
      // transparently. If it ever faults AFTER the callback ran, `fn` has already been
      // invoked once — return that in-flight promise instead of re-invoking `fn` (which
      // would fire a duplicate embedding/pgvector call, breaking transparency).
      let started: Promise<T> | undefined;
      try {
        return tracer.startActiveSpan(name, { attributes: toOtelAttributes(attributes) }, (span: Span) => {
          started = runInSpan(span, fn);
          return started;
        });
      } catch {
        return started ?? fn();
      }
    },
    // Force-flush buffered spans before a fatal exit, bounded + never rejects.
    flush: (timeoutMs = 2000): Promise<void> => bounded(() => provider.forceFlush(), timeoutMs),
    // Tear down the provider (flushes + shuts the exporter), bounded + never rejects.
    shutdown: (): Promise<void> => bounded(() => provider.shutdown(), 2000),
  };
}

/**
 * Execute `fn` inside an already-started active `span`, recording success/error on
 * the span and always ending it, WITHOUT ever letting a span-side fault mask `fn`'s
 * result or thrown error (the port's transparency contract — the "test that lies"
 * assertions in phoenix.test.ts enforce both directions).
 */
async function runInSpan<T>(span: Span, fn: () => Promise<T>): Promise<T> {
  try {
    const result = await fn();
    guardSpan(() => span.setStatus({ code: SpanStatusCode.OK }));
    return result;
  } catch (err: unknown) {
    guardSpan(() => {
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
    });
    throw err; // fn's error propagates unchanged
  } finally {
    guardSpan(() => span.end());
  }
}
