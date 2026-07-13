import { BlockList } from 'node:net';

import { describe, expect, it, vi } from 'vitest';

import type { Logger } from '@share2brain/shared/logger';

import {
  createDefaultBlockList,
  createGuardedDispatcher,
  isIpLiteralBlocked,
} from './ssrfGuard.js';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const FETCH_CONFIG_GUARDED = {
  timeout_ms: 5000,
  max_bytes: 2_000_000,
  max_redirects: 3,
  user_agent: 'Share2BrainBot/1.0',
  allowed_schemes: ['https'] as ('http' | 'https')[],
  block_private_ips: true,
};

const FETCH_CONFIG_UNGUARDED = { ...FETCH_CONFIG_GUARDED, block_private_ips: false };

describe('createDefaultBlockList', () => {
  const blockList = createDefaultBlockList();

  it('should block loopback (127.0.0.1)', () => {
    expect(isIpLiteralBlocked('127.0.0.1', blockList)).toBe(true);
  });

  it('should block a private 10.x address', () => {
    expect(isIpLiteralBlocked('10.0.0.5', blockList)).toBe(true);
  });

  it('should block the cloud metadata address (169.254.169.254)', () => {
    expect(isIpLiteralBlocked('169.254.169.254', blockList)).toBe(true);
  });

  it('should block IPv6 loopback (::1)', () => {
    expect(isIpLiteralBlocked('::1', blockList)).toBe(true);
  });

  it('should block an IPv6 ULA address (fc00::1)', () => {
    expect(isIpLiteralBlocked('fc00::1', blockList)).toBe(true);
  });

  it('should block an IPv4-mapped IPv6 metadata address (::ffff:169.254.169.254)', () => {
    expect(isIpLiteralBlocked('::ffff:169.254.169.254', blockList)).toBe(true);
  });

  it('should NOT block a public IPv4 address', () => {
    expect(isIpLiteralBlocked('8.8.8.8', blockList)).toBe(false);
  });

  it('should NOT block a public IPv6 address', () => {
    expect(isIpLiteralBlocked('2001:4860:4860::8888', blockList)).toBe(false);
  });

  it('should catch decimal-encoded loopback normalized by the URL object', () => {
    const hostname = new URL('http://2130706433/').hostname;
    expect(hostname).toBe('127.0.0.1');
    expect(isIpLiteralBlocked(hostname, blockList)).toBe(true);
  });

  it('should catch hex-encoded loopback normalized by the URL object', () => {
    const hostname = new URL('http://0x7f.1/').hostname;
    expect(hostname).toBe('127.0.0.1');
    expect(isIpLiteralBlocked(hostname, blockList)).toBe(true);
  });

  it('should catch octal-encoded loopback normalized by the URL object', () => {
    const hostname = new URL('http://017700000001/').hostname;
    expect(hostname).toBe('127.0.0.1');
    expect(isIpLiteralBlocked(hostname, blockList)).toBe(true);
  });

  it('should strip IPv6 brackets from a URL hostname before checking', () => {
    const hostname = new URL('http://[::1]/').hostname;
    expect(hostname).toBe('[::1]');
    expect(isIpLiteralBlocked(hostname, blockList)).toBe(true);
  });
});

describe('isIpLiteralBlocked', () => {
  it('should return false for a non-IP hostname (Layer B handles it)', () => {
    expect(isIpLiteralBlocked('example.com', createDefaultBlockList())).toBe(false);
  });
});

describe('createGuardedDispatcher', () => {
  it('should report enabled and provide a dispatcher when block_private_ips is true', () => {
    const guard = createGuardedDispatcher(FETCH_CONFIG_GUARDED);
    expect(guard.enabled).toBe(true);
    expect(guard.dispatcher).toBeDefined();
  });

  it('should report disabled and omit the dispatcher when block_private_ips is false', () => {
    const guard = createGuardedDispatcher(FETCH_CONFIG_UNGUARDED);
    expect(guard.enabled).toBe(false);
    expect(guard.dispatcher).toBeUndefined();
  });

  it('should always report not-blocked when disabled (dev-only escape hatch)', () => {
    const guard = createGuardedDispatcher(FETCH_CONFIG_UNGUARDED);
    expect(guard.isBlocked('127.0.0.1')).toBe(false);
  });

  it('should block a literal IP host when enabled', () => {
    const guard = createGuardedDispatcher(FETCH_CONFIG_GUARDED);
    expect(guard.isBlocked('127.0.0.1')).toBe(true);
  });

  it('should accept an injected custom BlockList (AC-8 redirect re-check case)', () => {
    const customBlockList = new BlockList();
    customBlockList.addSubnet('169.254.0.0', 16, 'ipv4');
    const guard = createGuardedDispatcher(FETCH_CONFIG_GUARDED, customBlockList);
    expect(guard.isBlocked('169.254.169.254')).toBe(true);
    expect(guard.isBlocked('127.0.0.1')).toBe(false);
  });

  it('should warn loudly when the guard is disabled (never silent)', () => {
    const logger = makeLogger();
    createGuardedDispatcher(FETCH_CONFIG_UNGUARDED, undefined, logger);
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(vi.mocked(logger.warn).mock.calls[0][0]).toMatch(/SSRF guard DISABLED/);
  });

  it('should NOT warn when the guard is enabled', () => {
    const logger = makeLogger();
    createGuardedDispatcher(FETCH_CONFIG_GUARDED, undefined, logger);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

// L-8: destination-port allowlist — allow only 443, plus 80 when http is a
// configured scheme. The SSRF layers never checked the port before this.
describe('GuardedDispatcher.isPortAllowed', () => {
  it('should allow 443 (default https port)', () => {
    const guard = createGuardedDispatcher(FETCH_CONFIG_GUARDED); // https only
    expect(guard.isPortAllowed(new URL('https://example.com/'))).toBe(true);
    expect(guard.isPortAllowed(new URL('https://example.com:443/'))).toBe(true);
  });

  it('should reject a non-allowlisted port', () => {
    const guard = createGuardedDispatcher(FETCH_CONFIG_GUARDED);
    expect(guard.isPortAllowed(new URL('https://example.com:8080/'))).toBe(false);
    expect(guard.isPortAllowed(new URL('https://example.com:22/'))).toBe(false);
  });

  it('should reject port 80 when http is not a configured scheme', () => {
    const guard = createGuardedDispatcher(FETCH_CONFIG_GUARDED); // https only
    expect(guard.isPortAllowed(new URL('http://example.com/'))).toBe(false); // default 80
    expect(guard.isPortAllowed(new URL('https://example.com:80/'))).toBe(false);
  });

  it('should allow port 80 only when http is a configured scheme', () => {
    const httpConfig = {
      ...FETCH_CONFIG_GUARDED,
      allowed_schemes: ['http', 'https'] as ('http' | 'https')[],
    };
    const guard = createGuardedDispatcher(httpConfig);
    expect(guard.isPortAllowed(new URL('http://example.com/'))).toBe(true); // default 80
    expect(guard.isPortAllowed(new URL('http://example.com:80/'))).toBe(true);
    expect(guard.isPortAllowed(new URL('https://example.com/'))).toBe(true); // 443 still allowed
    expect(guard.isPortAllowed(new URL('http://example.com:8080/'))).toBe(false);
  });

  it('should allow any port when the guard is disabled (dev-only escape hatch)', () => {
    const guard = createGuardedDispatcher(FETCH_CONFIG_UNGUARDED);
    expect(guard.isPortAllowed(new URL('http://example.com:12345/'))).toBe(true);
  });
});
