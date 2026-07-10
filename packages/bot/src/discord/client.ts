// Discord Gateway client factory (AC-1, AC-5). Creates a discord.js Client with
// exactly the three intents Share2Brain needs and binds the ClientReady log.
//
//   Guilds         → guild lifecycle (required for any guild event)
//   GuildMessages  → receive messageCreate/messageUpdate/messageDelete in guild channels
//   MessageContent → read message.content (PRIVILEGED — must be enabled in the
//                    Discord Developer Portal; validated ON by the Epic 3 spike)
//
// `partials` (Story 6.1) is mandatory for messageUpdate/messageDelete on a
// message discord.js never cached (e.g. after a restart): without it those
// events are silently dropped for anything not in the in-memory cache.
//
// Creating the client opens no connection; login() dials the Gateway.
import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';

import type { Logger } from '../logger.js';

/** Create the Gateway client with Share2Brain's intents and a ClientReady → info log. */
export function createDiscordClient(logger: Logger, guildId: string): Client {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Message, Partials.Channel],
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
