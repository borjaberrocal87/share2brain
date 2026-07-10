// SSRF guard for the outbound resource-enrichment fetch (AC-2). Two independent
// layers, both gated on `config.enrichment.fetch.block_private_ips`:
//
// - Layer A (pre-check, per redirect hop): when the hop's hostname is an IP
//   literal, check it against the BlockList directly. MANDATORY, not
//   belt-and-braces — undici's `connect.lookup` is never invoked for IP-literal
//   hosts (empirically verified), so Layer B alone is bypassable with a literal
//   like `http://127.0.0.1/`. `new URL()` already normalizes decimal/hex/octal
//   encodings (`http://2130706433/` → `127.0.0.1`), so this catches those too.
// - Layer B (connect-time): an undici `Agent({ connect: { lookup } })` whose
//   custom lookup resolves via `dns.lookup(hostname, { all: true, verbatim: true
//   })` and rejects if ANY resolved address is blocked — undici then connects to
//   exactly the validated addresses (defeats DNS rebinding / TOCTOU).
//
// No module-level singleton `Agent` (AC-6) — `main.ts` builds one
// `createGuardedDispatcher` result at boot and injects it through the pipeline.
import { lookup as dnsLookup, type LookupAddress, type LookupAllOptions } from 'node:dns';
import { BlockList, isIP } from 'node:net';

import { Agent, type Dispatcher } from 'undici';

import type { EnrichmentConfig } from '@share2brain/shared';

/** Raised by the Layer B custom lookup when a resolved address is blocked —
 *  distinguishable from a generic DNS/network failure by `fetchUrl`'s caller. */
export class SsrfBlockedError extends Error {}

/**
 * The static range set (AC-2). IPv4: unspecified, RFC1918 private ranges,
 * CGNAT, loopback, link-local (incl. cloud metadata), documentation/benchmark
 * ranges, multicast, reserved. IPv6: loopback, unspecified, ULA, link-local,
 * multicast, documentation, NAT64.
 */
export function createDefaultBlockList(): BlockList {
  const blockList = new BlockList();

  const ipv4Subnets: [string, number][] = [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10], // CGNAT
    ['127.0.0.0', 8],
    ['169.254.0.0', 16], // link-local + cloud metadata
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ];
  for (const [net, prefix] of ipv4Subnets) blockList.addSubnet(net, prefix, 'ipv4');

  blockList.addAddress('::1', 'ipv6');
  blockList.addAddress('::', 'ipv6');
  const ipv6Subnets: [string, number][] = [
    ['fc00::', 7], // ULA
    ['fe80::', 10], // link-local
    ['ff00::', 8], // multicast
    ['2001:db8::', 32], // documentation
    ['64:ff9b::', 96], // NAT64
  ];
  for (const [net, prefix] of ipv6Subnets) blockList.addSubnet(net, prefix, 'ipv6');

  return blockList;
}

/**
 * Layer A: check a URL hostname that is an IP literal against `blockList`.
 * Returns `false` for a non-literal (regular DNS) hostname — Layer B owns that
 * case. IPv6 literals arrive bracketed from `URL#hostname` (e.g. `[::1]`) —
 * `net.isIP` does not recognize the brackets, so strip them first.
 */
export function isIpLiteralBlocked(hostname: string, blockList: BlockList): boolean {
  const stripped =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  const version = isIP(stripped);
  if (version === 0) return false;
  return blockList.check(stripped, version === 6 ? 'ipv6' : 'ipv4');
}

/** Structurally matches Node's `net` connect `lookup` option — undici forwards
 *  it verbatim to `net.connect`/`tls.connect`. Not imported by name: Node's own
 *  `LookupFunction` type is internal to the `node:net` ambient module. */
type ConnectLookupFunction = (
  hostname: string,
  options: unknown,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void,
) => void;

function createLookup(blockList: BlockList): ConnectLookupFunction {
  return (hostname, _options, callback) => {
    const options: LookupAllOptions = { all: true, verbatim: true };
    dnsLookup(hostname, options, (err, addresses) => {
      if (err) {
        callback(err, '');
        return;
      }
      const blocked = addresses.find((a) =>
        blockList.check(a.address, a.family === 6 ? 'ipv6' : 'ipv4'),
      );
      if (blocked) {
        callback(
          new SsrfBlockedError(
            `SSRF guard: resolved address ${blocked.address} for host "${hostname}" is blocked`,
          ),
          '',
        );
        return;
      }
      callback(null, addresses);
    });
  };
}

export interface GuardedDispatcher {
  /** Mirrors `fetchConfig.block_private_ips` — both layers are inert when false. */
  enabled: boolean;
  /** Pass through to `fetch(url, { dispatcher })`; `undefined` when disabled, so
   *  callers omit it and undici falls back to the default (unguarded) dispatcher —
   *  the documented dev-only escape hatch. */
  dispatcher: Dispatcher | undefined;
  /** Layer A check bound to this guard's BlockList; always `false` when disabled. */
  isBlocked(hostname: string): boolean;
}

/**
 * Build the guarded dispatcher once at boot (`main.ts`) and inject it through
 * the pipeline — never a module-level singleton `Agent` (AC-6). `blockList` is
 * injectable so tests can exercise the per-hop redirect re-check (AC-8) with a
 * narrower range set than the shipped default.
 */
export function createGuardedDispatcher(
  fetchConfig: EnrichmentConfig['fetch'],
  blockList: BlockList = createDefaultBlockList(),
): GuardedDispatcher {
  if (!fetchConfig.block_private_ips) {
    return { enabled: false, dispatcher: undefined, isBlocked: () => false };
  }

  const dispatcher = new Agent({ connect: { lookup: createLookup(blockList) } });
  return {
    enabled: true,
    dispatcher,
    isBlocked: (hostname: string) => isIpLiteralBlocked(hostname, blockList),
  };
}
