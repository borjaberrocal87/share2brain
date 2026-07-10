// THROWAWAY SPIKE — Epic 3 external-integration validation (Story 3.1, discord.js Gateway).
//
// Confirms, against the REAL Discord service, before we build the ingestion pipeline:
//   1. the bot token is valid and the Gateway connects,
//   2. the required intents are sufficient — including the PRIVILEGED MessageContent
//      intent (the classic gotcha: without it, message.content is empty),
//   3. the bot is actually in the configured guild and can see the enabled channels,
//   4. a real `messageCreate` arrives with non-empty content.
//
// This is NOT production code — it validates assumptions the way the ioredis→node-redis
// surprise in Epic 2 taught us to (validate the integration before building on it).
// Delete `spike/` once both integrations are green.
//
// Run:  npx tsx --env-file=.env spike/gateway.ts
//       (then post a message in an enabled channel while it waits)

import { loadConfig } from '@share2brain/shared';
import { Client, Events, GatewayIntentBits } from 'discord.js';

const TOKEN = process.env.DISCORD_BOT_TOKEN;
if (!TOKEN || TOKEN === 'your-discord-bot-token') {
  console.error('✗ DISCORD_BOT_TOKEN is unset or still the placeholder. Put a real bot token in .env first.');
  process.exit(1);
}

// Reuse the real config path: validates Share2Brain.config.yml and interpolates ${DISCORD_GUILD_ID}.
const config = loadConfig();
const enabledChannels = config.discord.channels.filter((c) => c.enabled);
const enabledChannelIds = new Set(enabledChannels.map((c) => c.id));
console.log(
  `[spike] guild=${config.discord.guild_id} · watching ${enabledChannels.length} enabled channel(s): ` +
    enabledChannels.map((c) => `${c.name}(${c.id})`).join(', '),
);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // PRIVILEGED — must be enabled in the Developer Portal
  ],
});

const TIMEOUT_MS = 300_000;
const timer = setTimeout(() => {
  console.error(`\n✗ No messageCreate within ${TIMEOUT_MS / 1000}s. Gateway connected but no message arrived.`);
  console.error('  → Post a message in an enabled channel while this runs, and confirm the bot can see that channel.');
  void client.destroy().then(() => process.exit(1));
}, TIMEOUT_MS);

client.once(Events.ClientReady, (c) => {
  console.log(`✓ Gateway connected as ${c.user.tag} (id ${c.user.id})`);
  const guild = c.guilds.cache.get(config.discord.guild_id);
  if (!guild) {
    console.error(`✗ Bot is NOT in guild ${config.discord.guild_id}. Invite it (OAuth2 URL, bot scope) and re-run.`);
    clearTimeout(timer);
    void c.destroy().then(() => process.exit(1));
    return;
  }
  console.log(`✓ In guild "${guild.name}" · ${guild.channels.cache.size} channels visible to the bot`);
  console.log(`[spike] Now post a message in an enabled channel… (waiting up to ${TIMEOUT_MS / 1000}s)`);
});

client.on(Events.MessageCreate, (msg) => {
  if (msg.author.bot && config.discord.backfill.ignore_bots) return; // mirror the real filter
  const inScope = enabledChannelIds.has(msg.channelId);
  console.log('\n✓ messageCreate received:');
  console.log(`    channel:  ${msg.channelId} ${inScope ? '(ENABLED ✓)' : '(not in the enabled list)'}`);
  console.log(`    author:   ${msg.author.username} (${msg.author.id})${msg.author.bot ? ' [bot]' : ''}`);
  console.log(`    content:  ${msg.content ? JSON.stringify(msg.content.slice(0, 120)) : '⚠️  EMPTY'}`);

  if (!msg.content) {
    console.error('\n✗ content is EMPTY — the MessageContent PRIVILEGED intent is almost certainly OFF.');
    console.error('  → Discord Developer Portal → your app → Bot → enable "Message Content Intent", then re-run.');
    clearTimeout(timer);
    void client.destroy().then(() => process.exit(1));
    return;
  }

  console.log('\n✅ Discord Gateway integration VALIDATED (connect + intents + content + channel scope).');
  clearTimeout(timer);
  void client.destroy().then(() => process.exit(0));
});

client.on(Events.Error, (e) => console.error('[spike] client error:', e.message));

client.login(TOKEN).catch((e: unknown) => {
  console.error('✗ Login failed:', e instanceof Error ? e.message : String(e));
  console.error('  → Check DISCORD_BOT_TOKEN is a valid BOT token (not the OAuth2 client secret).');
  process.exit(1);
});
