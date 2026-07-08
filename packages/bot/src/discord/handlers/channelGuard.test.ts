import { describe, expect, it } from 'vitest';

import { isChannelEnabled } from './channelGuard.js';

const channels = [
  { id: 'chan-enabled', name: 'general', enabled: true },
  { id: 'chan-disabled', name: 'archive', enabled: false },
];

describe('isChannelEnabled', () => {
  it('returns true for a configured, enabled channel', () => {
    expect(isChannelEnabled(channels, 'chan-enabled')).toBe(true);
  });

  it('returns false for a configured, disabled channel', () => {
    expect(isChannelEnabled(channels, 'chan-disabled')).toBe(false);
  });

  it('returns false for an unconfigured channel', () => {
    expect(isChannelEnabled(channels, 'chan-unknown')).toBe(false);
  });
});
