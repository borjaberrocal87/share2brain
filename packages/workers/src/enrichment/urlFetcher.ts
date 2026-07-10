// Fetch a resource URL behind the SSRF guard (AC-3). Never throws — every path
// resolves to a typed `FetchOutcome`, so the caller (`indexBatch`) can branch on
// `ok`/`reason` without a try/catch around a third-party network boundary.
//
// Manual redirect loop: `fetch(url, { redirect: 'manual' })` returns the REAL
// 3xx with a readable `location` header (undici diverges from the spec's
// `opaqueredirect` here — empirically verified). Every hop re-runs the scheme
// allowlist and the SSRF Layer A check — a public host redirecting to
// `http://169.254.169.254/` is the classic bypass this defends against.
import { fetch as undiciFetch, type Response } from 'undici';

import type { EnrichmentConfig } from '@share2brain/shared';

import { SsrfBlockedError, type GuardedDispatcher } from './ssrfGuard.js';

export type FetchOutcomeReason =
  | 'ssrf_blocked'
  | 'scheme_disallowed'
  | 'too_many_redirects'
  | 'timeout'
  | 'too_large'
  | 'http_error'
  | 'network_error';

export type FetchOutcome =
  | { ok: true; body: string; contentType: string; finalUrl: string }
  | { ok: false; reason: FetchOutcomeReason };

function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

/** Best-effort — cancelling an already-finished/errored body stream is a no-op. */
async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    /* best-effort */
  }
}

/**
 * Stream the response body, cancelling as soon as decoded bytes exceed
 * `maxBytes`. `Content-Length` (checked by the caller before this runs) is only
 * a cheap early reject — it can be absent or lying — so this streaming reader is
 * the real enforcement.
 */
async function readCappedBody(
  response: Response,
  maxBytes: number,
): Promise<{ text: string } | { tooLarge: true }> {
  const reader = response.body?.getReader();
  if (!reader) return { text: '' };

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await cancelBody(response);
      return { tooLarge: true };
    }
    chunks.push(value);
  }

  return { text: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf-8') };
}

export async function fetchUrl(
  url: string,
  fetchConfig: EnrichmentConfig['fetch'],
  guard: GuardedDispatcher,
  signal: AbortSignal,
): Promise<FetchOutcome> {
  const allowedSchemes = new Set(fetchConfig.allowed_schemes.map((scheme) => `${scheme}:`));
  let currentUrl = url;
  let redirectCount = 0;

  for (;;) {
    let parsed: URL;
    try {
      parsed = new URL(currentUrl);
    } catch {
      return { ok: false, reason: 'network_error' };
    }

    if (!allowedSchemes.has(parsed.protocol)) {
      return { ok: false, reason: 'scheme_disallowed' };
    }
    // Layer A (mandatory, not belt-and-braces — Layer B's connect.lookup is
    // never invoked for an IP-literal host).
    if (guard.isBlocked(parsed.hostname)) {
      return { ok: false, reason: 'ssrf_blocked' };
    }

    const hopSignal = AbortSignal.any([AbortSignal.timeout(fetchConfig.timeout_ms), signal]);

    let response: Response;
    try {
      response = await undiciFetch(currentUrl, {
        dispatcher: guard.dispatcher,
        redirect: 'manual',
        signal: hopSignal,
        headers: { 'accept-encoding': 'identity', 'user-agent': fetchConfig.user_agent },
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        return { ok: false, reason: 'timeout' };
      }
      if (err instanceof Error && err.cause instanceof SsrfBlockedError) {
        return { ok: false, reason: 'ssrf_blocked' };
      }
      // DNS/socket/TLS errors, and a shutdown-signal abort mid-fetch (no
      // dedicated outcome — indexBatch's between-URLs abort check is the real
      // safety net; the message-text-only fallback enrich call also observes
      // the same signal and fails, converging to the D1 no-ACK path).
      return { ok: false, reason: 'network_error' };
    }

    if (isRedirectStatus(response.status) && response.headers.has('location')) {
      await cancelBody(response);
      const location = response.headers.get('location') as string;
      let nextUrl: string;
      try {
        nextUrl = new URL(location, currentUrl).href;
      } catch {
        return { ok: false, reason: 'network_error' };
      }
      if (redirectCount >= fetchConfig.max_redirects) {
        return { ok: false, reason: 'too_many_redirects' };
      }
      redirectCount++;
      currentUrl = nextUrl;
      continue;
    }

    if (response.status < 200 || response.status >= 300) {
      await cancelBody(response);
      return { ok: false, reason: 'http_error' };
    }

    const contentLengthHeader = response.headers.get('content-length');
    if (contentLengthHeader !== null) {
      const declared = Number(contentLengthHeader);
      if (Number.isFinite(declared) && declared > fetchConfig.max_bytes) {
        await cancelBody(response);
        return { ok: false, reason: 'too_large' };
      }
    }

    // The body drain can reject — a mid-body stall trips `hopSignal`
    // (TimeoutError / shutdown abort) and a socket reset errors the stream. Map
    // both to a typed outcome so `fetchUrl` keeps its "never throws" contract;
    // otherwise the throw escapes to `processMessage`, which would misread a
    // transient fetch failure as a D1 enrichment failure and poison the message.
    let bodyResult: { text: string } | { tooLarge: true };
    try {
      bodyResult = await readCappedBody(response, fetchConfig.max_bytes);
    } catch (err) {
      await cancelBody(response);
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        return { ok: false, reason: 'timeout' };
      }
      return { ok: false, reason: 'network_error' };
    }
    if ('tooLarge' in bodyResult) {
      return { ok: false, reason: 'too_large' };
    }

    return {
      ok: true,
      body: bodyResult.text,
      contentType: response.headers.get('content-type') ?? '',
      finalUrl: currentUrl,
    };
  }
}
