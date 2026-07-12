// Boot-time UI language resolver (Story 10.2, D2). Talks to the unauthenticated
// GET /api/ui-config (Story 10.1). NEVER throws: any failure (network reject,
// non-200, malformed body, timeout) degrades to 'es' so a broken backend still
// yields a working Spanish login screen — main.tsx stays branch-free.
import { UiConfigResponseSchema } from '@share2brain/shared/schemas';

/** Resolve the deployment's configured UI language. Never rejects. */
export async function fetchUiLanguage(): Promise<'es' | 'en'> {
  try {
    const res = await fetch('/api/ui-config', { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return 'es';
    return UiConfigResponseSchema.parse(await res.json()).language;
  } catch {
    return 'es';
  }
}
