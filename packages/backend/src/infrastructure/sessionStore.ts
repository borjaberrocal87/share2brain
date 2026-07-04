// Infrastructure: the express-session middleware backed by Redis (AD-10). Sessions
// live only in Redis via connect-redis — there is no `sessions` table. The httpOnly
// cookie carries only the session id; revocation is `req.session.destroy()`, which
// deletes the Redis key. connect-redis@9 is bound to the shared node-redis client.
import { RedisStore } from 'connect-redis';
import type { RequestHandler } from 'express';
import session from 'express-session';

import type { RedisClient } from './redis.js';

// The ONLY place the session payload is typed. `userId`/`discordRoles` are set on
// a successful OAuth callback; `oauthState` is the transient CSRF nonce.
declare module 'express-session' {
  interface SessionData {
    userId: string;
    discordRoles: string[];
    oauthState?: string;
  }
}

export function createSessionMiddleware(
  redis: RedisClient,
  opts: { secret: string; ttlDays: number; cookieSecure: boolean },
): RequestHandler {
  const store = new RedisStore({
    client: redis,
    prefix: 'sess:',
    ttl: opts.ttlDays * 86_400, // seconds
  });

  return session({
    name: 'sid', // AC3/AC6: the cookie is `sid`, not the express-session default `connect.sid`.
    secret: opts.secret,
    store,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: opts.cookieSecure, // true behind nginx TLS in prod; false over http in dev
      sameSite: 'lax',
      maxAge: opts.ttlDays * 86_400_000, // ms
    },
  });
}
