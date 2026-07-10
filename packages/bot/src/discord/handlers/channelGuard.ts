// Shared channel-enabled guard (AC-1, AC-2, AC-3). Extracted from messageCreate.ts
// (Story 3.1) so messageCreate, messageUpdate, and messageDelete all apply the
// exact same "configured AND enabled" rule.
import type { Share2BrainConfig } from '@share2brain/shared';

/** True when the message's channel is configured AND enabled. */
export function isChannelEnabled(
  channels: Share2BrainConfig['discord']['channels'],
  channelId: string,
): boolean {
  const channel = channels.find((c) => c.id === channelId);
  return channel?.enabled === true;
}
