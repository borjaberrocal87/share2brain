// Composition root + extension point for the shared LlmTracing module (Story ops-6).
// `backend` and `workers` import ONLY from here (the `@share2brain/shared/tracing`
// subpath) — the vendor-neutral `LlmTracing` port + the `createLlmTracing` factory.
// No consumer names a vendor (Phoenix/OTel/Arize). This mirrors
// `observability/index.ts` file-for-file; the two ports are DELIBERATELY separate
// seams (D1): Sentry keeps errors+logs, Phoenix takes LLM traces.
//
// This module is NOT re-exported from the shared root barrel (same containment rule
// as `providers/index.ts`): the Phoenix adapter pulls OTel + LangChain in
// transitively, and the browser bundle (web) plus config-only consumers (bot) must
// stay free of it. Import via the dedicated "@share2brain/shared/tracing" subpath only.
//
// ADD A PROVIDER IN THREE STEPS (the point of the port — zero service edits):
//   1. New adapter file `tracing/<provider>.ts` exporting
//      `create<Provider>LlmTracing(opts): LlmTracing` (mirror `phoenix.ts`).
//   2. One branch in `createLlmTracing` below + the literal in `LlmTracingProvider`
//      (tracing.ts) and the `observability.tracing.provider` Zod enum (config/index.ts).
//   3. Set `observability.tracing.provider: <provider>` in `Share2Brain.config.yml`.
// The empty-endpoint → Noop rule (S-5) and the AD-8 boot slot are unchanged.
import { NoopLlmTracing, type LlmTracing, type LlmTracingProvider } from './tracing.js';
import { createPhoenixLlmTracing } from './phoenix.js';

export type { LlmTracing, LlmTracingProvider } from './tracing.js';
export { NoopLlmTracing } from './tracing.js';

/**
 * The ONLY function services call to obtain LLM tracing (mirrors
 * `createObservability`). SYNCHRONOUS — like `createObservability`, the adapter is
 * imported statically (an ESM dynamic import would force an async factory; don't do
 * it). Called once per process in `main.ts`, in the AD-8 boot slot: after
 * `loadConfig()`/`createObservability`/`createLogger`, before any network I/O and
 * before any LangChain model is constructed (so the CallbackManager patch precedes
 * any chain run).
 *
 * S-5 (the feature flag): an empty `endpoint` returns the shared `NoopLlmTracing` —
 * NO OTel object is constructed, NO instrumentation is registered, zero tracing
 * network calls. A service without a tracing endpoint behaves byte-identically to
 * before tracing existed. Otherwise the adapter is selected by `provider` (default
 * `'phoenix'`, fail-safe: an existing config with no `provider` behaves as today).
 */
export function createLlmTracing(opts: {
  endpoint: string;
  service: string;
  provider?: LlmTracingProvider;
  /** Optional bearer token for a Phoenix collector with auth enabled (blank ⇒ no auth). */
  apiKey?: string;
}): LlmTracing {
  if (opts.endpoint.trim() === '') return NoopLlmTracing; // S-5 — the feature flag (also treats whitespace-only as off)

  const provider = opts.provider ?? 'phoenix';
  if (provider === 'phoenix') {
    return createPhoenixLlmTracing({ endpoint: opts.endpoint, service: opts.service, apiKey: opts.apiKey });
  }
  // Unreachable today — the Zod enum admits only 'phoenix'. A new provider adds its
  // branch above (step 2); until then, fail safe to the Noop rather than throw, so a
  // config typo can never crash a boot (consistent with the ops-5 factory's accepted
  // fail-open deferral).
  return NoopLlmTracing;
}
