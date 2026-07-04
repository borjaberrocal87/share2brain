// @hivly/bot — Discord ingestion process (AD-1: standalone Node process).
// The Gateway connection + messageCreate listener land in Epic 3. For now this
// is a long-running placeholder: it validates config (AD-8) and stays alive so
// its container reports "running" (AC3), exiting cleanly on SIGTERM/SIGINT.
import { loadConfig } from '@hivly/shared';

function main(): void {
  loadConfig();
  console.log('[bot] started — placeholder process (Gateway listener arrives in Epic 3)');

  const shutdown = (signal: string): void => {
    console.log(`[bot] received ${signal}, shutting down`);
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Keep the event loop alive until a shutdown signal arrives.
  setInterval(() => {}, 1 << 30);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[bot] fatal: ${message}`);
  process.exit(1);
}
