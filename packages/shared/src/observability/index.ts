// Composition root + extension point for the shared observability module
// (Story ops-5). Services import ONLY from here (the `@share2brain/shared/observability`
// subpath) — the vendor-neutral `Observability` port + the `createObservability`
// factory. The vendor-named ops-4 surface (`initSentry`/`captureException`/
// `flushSentry`/`setSentryUser`/`setupSentryErrorHandler`/`beforeSend`/
// `beforeSendLog`) is GONE; nothing outside this module names a vendor.
//
// ADD A PROVIDER IN THREE STEPS (the point of this refactor — zero edits to
// `backend`/`bot`/`workers`/`web`):
//   1. New adapter file `observability/<provider>.ts` exporting
//      `create<Provider>Observability(opts): Observability` (mirror `sentry.ts`).
//   2. One branch in `createObservability` below + the literal in
//      `ObservabilityProvider` (observability.ts) and the `observability.provider`
//      Zod enum (config/index.ts).
//   3. Set `observability.provider: <provider>` in `Share2Brain.config.yml`.
// The empty-DSN → Noop rule (S-5) and the AD-8 boot slot are unchanged.
import { NoopObservability, type Observability, type ObservabilityProvider } from './observability.js';
import { createSentryObservability } from './sentry.js';

export type { Observability, ObservabilityProvider } from './observability.js';
export { NoopObservability } from './observability.js';

/**
 * The ONLY function services call to obtain observability (mirrors
 * `createNotifier`). Performs no network I/O beyond what the selected adapter's
 * constructor does (Sentry.init). Called once per process in `main.ts`, right
 * after `loadConfig()` and before any network I/O (AD-8).
 *
 * S-5: an empty `dsn` returns the shared `NoopObservability` — `Sentry.init` is
 * never called and every method is a safe no-op, so a service without a DSN
 * behaves exactly as before observability existed. Otherwise the adapter is
 * selected by `provider` (default `'sentry'`, fail-safe and backward compatible:
 * an existing config with no `provider` behaves exactly as today).
 */
export function createObservability(opts: {
  dsn: string;
  service: string;
  provider?: ObservabilityProvider;
}): Observability {
  if (opts.dsn === '') return NoopObservability; // S-5

  const provider = opts.provider ?? 'sentry';
  if (provider === 'sentry') {
    return createSentryObservability({ dsn: opts.dsn, service: opts.service });
  }
  // Unreachable today — the Zod enum admits only 'sentry'. A new provider adds
  // its branch above (step 2); until then, fail safe to the Noop rather than
  // throw, so a config typo can never crash a boot.
  return NoopObservability;
}
