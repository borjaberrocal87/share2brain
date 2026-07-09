import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { BlockList } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createGuardedDispatcher } from './ssrfGuard.js';
import { fetchUrl } from './urlFetcher.js';

const FETCH_CONFIG = {
  timeout_ms: 300,
  max_bytes: 500_000,
  max_redirects: 3,
  user_agent: 'HivlyTest/1.0',
  allowed_schemes: ['http', 'https'] as ('http' | 'https')[],
  block_private_ips: false,
};

function neverAbortedSignal(): AbortSignal {
  return new AbortController().signal;
}

describe('fetchUrl', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      switch (url.pathname) {
        case '/ok':
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('hello world');
          break;
        case '/redirect-once':
          res.writeHead(301, { Location: '/ok' });
          res.end();
          break;
        case '/redirect-loop':
          res.writeHead(301, { Location: '/redirect-loop' });
          res.end();
          break;
        case '/declared-too-large':
          res.writeHead(200, { 'Content-Length': '10000000' });
          res.end('short');
          break;
        case '/actually-too-large': {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          const chunk = 'x'.repeat(100_000);
          for (let i = 0; i < 10; i++) res.write(chunk);
          res.end();
          break;
        }
        case '/slow':
          setTimeout(() => {
            res.writeHead(200);
            res.end('late');
          }, 2000);
          break;
        case '/not-found':
          res.writeHead(404);
          res.end('nope');
          break;
        case '/redirect-to-blocked':
          res.writeHead(301, { Location: 'http://169.254.169.254/' });
          res.end();
          break;
        default:
          res.writeHead(404);
          res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const unguarded = createGuardedDispatcher(FETCH_CONFIG); // block_private_ips: false

  it('should return the decoded body for a 2xx response', async () => {
    const outcome = await fetchUrl(`${baseUrl}/ok`, FETCH_CONFIG, unguarded, neverAbortedSignal());
    expect(outcome).toEqual({
      ok: true,
      body: 'hello world',
      contentType: 'text/plain',
      finalUrl: `${baseUrl}/ok`,
    });
  });

  it('should follow a redirect chain within the cap and report the final URL', async () => {
    const outcome = await fetchUrl(
      `${baseUrl}/redirect-once`,
      FETCH_CONFIG,
      unguarded,
      neverAbortedSignal(),
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.body).toBe('hello world');
      expect(outcome.finalUrl).toBe(`${baseUrl}/ok`);
    }
  });

  it('should fail with too_many_redirects past the configured cap', async () => {
    const outcome = await fetchUrl(
      `${baseUrl}/redirect-loop`,
      FETCH_CONFIG,
      unguarded,
      neverAbortedSignal(),
    );
    expect(outcome).toEqual({ ok: false, reason: 'too_many_redirects' });
  });

  it('should reject early on a declared Content-Length above max_bytes', async () => {
    const outcome = await fetchUrl(
      `${baseUrl}/declared-too-large`,
      FETCH_CONFIG,
      unguarded,
      neverAbortedSignal(),
    );
    expect(outcome).toEqual({ ok: false, reason: 'too_large' });
  });

  it('should abort streaming past max_bytes when Content-Length is absent (chunked)', async () => {
    const outcome = await fetchUrl(
      `${baseUrl}/actually-too-large`,
      FETCH_CONFIG,
      unguarded,
      neverAbortedSignal(),
    );
    expect(outcome).toEqual({ ok: false, reason: 'too_large' });
  });

  it('should time out on a slow response', async () => {
    const outcome = await fetchUrl(`${baseUrl}/slow`, FETCH_CONFIG, unguarded, neverAbortedSignal());
    expect(outcome).toEqual({ ok: false, reason: 'timeout' });
  });

  it('should map a non-2xx final response to http_error', async () => {
    const outcome = await fetchUrl(
      `${baseUrl}/not-found`,
      FETCH_CONFIG,
      unguarded,
      neverAbortedSignal(),
    );
    expect(outcome).toEqual({ ok: false, reason: 'http_error' });
  });

  it('should map a connection-refused error to network_error', async () => {
    const outcome = await fetchUrl(
      'http://127.0.0.1:1/',
      FETCH_CONFIG,
      unguarded,
      neverAbortedSignal(),
    );
    expect(outcome).toEqual({ ok: false, reason: 'network_error' });
  });

  it('should map a disallowed scheme to scheme_disallowed without connecting', async () => {
    const restricted = { ...FETCH_CONFIG, allowed_schemes: ['https'] as ('http' | 'https')[] };
    const outcome = await fetchUrl(`${baseUrl}/ok`, restricted, unguarded, neverAbortedSignal());
    expect(outcome).toEqual({ ok: false, reason: 'scheme_disallowed' });
  });

  it('should block a direct IP-literal request with the default blocklist (Layer A)', async () => {
    const guardedConfig = { ...FETCH_CONFIG, block_private_ips: true };
    const guarded = createGuardedDispatcher(guardedConfig);
    const outcome = await fetchUrl(`${baseUrl}/ok`, guardedConfig, guarded, neverAbortedSignal());
    expect(outcome).toEqual({ ok: false, reason: 'ssrf_blocked' });
  });

  it('should re-check SSRF on the redirect hop, not just the first hop', async () => {
    // The default blocklist would reject 127.0.0.1 on the FIRST hop, false-passing
    // this test without ever reaching the redirect logic — use a narrower custom
    // BlockList that blocks 169.254.0.0/16 but NOT 127.0.0.1 (AC-8).
    const customBlockList = new BlockList();
    customBlockList.addSubnet('169.254.0.0', 16, 'ipv4');
    const guardedConfig = { ...FETCH_CONFIG, block_private_ips: true };
    const guarded = createGuardedDispatcher(guardedConfig, customBlockList);
    const outcome = await fetchUrl(
      `${baseUrl}/redirect-to-blocked`,
      guardedConfig,
      guarded,
      neverAbortedSignal(),
    );
    expect(outcome).toEqual({ ok: false, reason: 'ssrf_blocked' });
  });
});
