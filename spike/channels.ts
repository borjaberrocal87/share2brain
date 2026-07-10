// THROWAWAY helper — lists the text channels the bot can see in the configured guild,
// so the real IDs can be copied into Share2Brain.config.yml → discord.channels.
// Run:  npx tsx --env-file=.env spike/channels.ts
import { loadConfig } from '@share2brain/shared';
import { ChannelType, Client, Events, GatewayIntentBits } from 'discord.js';

const TOKEN = process.env.DISCORD_BOT_TOKEN;
if (!TOKEN || TOKEN === 'your-discord-bot-token') {
  console.error('✗ DISCORD_BOT_TOKEN unset/placeholder.');
  process.exit(1);
}
const config = loadConfig();
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, (c) => {
  const guild = c.guilds.cache.get(config.discord.guild_id);
  if (!guild) {
    console.error(`✗ Bot not in guild ${config.discord.guild_id}.`);
    void c.destroy().then(() => process.exit(1));
    return;
  }
  console.log(`Guild "${guild.name}" (${guild.id}) — text-capable channels:\n`);
  for (const ch of guild.channels.cache.values()) {
    if (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement) {
      console.log(`  id: "${ch.id}"   name: "${ch.name}"`);
    }
  }
  console.log('\nCopy the ones you want into Share2Brain.config.yml → discord.channels (id + name, enabled: true).');
  void c.destroy().then(() => process.exit(0));
});

client.login(TOKEN).catch((e: unknown) => {
  console.error('✗ Login failed:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
