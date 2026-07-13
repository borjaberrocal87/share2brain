// Barrel for the shared observability module (Story ops-4). Re-exports the
// Sentry integration surface consumed by the three services via the
// `@share2brain/shared/observability` subpath (mirrors the `./notifier` barrel).
export {
  beforeSend,
  beforeSendLog,
  captureException,
  flushSentry,
  initSentry,
  setSentryUser,
  setupSentryErrorHandler,
} from './sentry.js';
