// Discord Gateway client factory (AC-1). Creates a discord.js Client with exactly
// the three intents Hivly needs and binds the ClientReady log.
//
//   Guilds         → guild lifecycle (required for any guild event)
//   GuildMessages  → receive messageCreate in guild channels
//   MessageContent → read message.content (PRIVILEGED — must be enabled in the
//                    Discord Developer Portal; validated ON by the Epic 3 spike)
//
// Creating the client opens no connection; login() dials the Gateway.
import { Client, Events, GatewayIntentBits } from 'discord.js';

import type { Logger } from '../logger.js';

/** Create the Gateway client with Hivly's intents and a ClientReady → info log. */
export function createDiscordClient(logger: Logger, guildId: string): Client {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  // Log every ready event (not just the first) so the operator sees a logged
  // confirmation when discord.js reconnects after a transient Gateway drop.
  client.on(Events.ClientReady, (ready) => {
    logger.info('Connected to Discord Gateway', { botId: ready.user.id, guildId });
  });

  return client;
}

/** Log in to the Gateway. Resolves once the token is accepted; rejects on an invalid token. */
export function login(client: Client, token: string): Promise<string> {
  return client.login(token);
}
