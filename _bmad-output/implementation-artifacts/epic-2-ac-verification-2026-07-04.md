# Epic 2 AC Verification Pass — 2026-07-04

Epic 1 retrospective action item #2: confirm Epic 2 story ACs are consistent with the
current state (schema, config, compose topology) before creating Stories 2.x.

**Verdict: consistent. No epic re-plan required.** Two minor notes for story creation.

## Cross-check

| Epic 2 AC dependency | Current state | Status |
|---|---|---|
| 2.3 — upsert `users(discord_id, username, avatar)` | `users`: `discord_id` (notNull, unique idx), `username` (notNull), `avatar` (nullable) | ✅ |
| 2.3 — `GET /api/auth/me` → `{ id, discordId, username, avatar }` | `users` columns `id`/`discordId`/`username`/`avatar` | ✅ |
| 2.3 — session `{ userId, discordRoles }` in Redis, no sessions table (AD-10) | `schema.ts` has **no** `sessions` table | ✅ |
| 2.4 — upsert `channel_permissions` from `config.access_control.channel_permissions` | `channel_permissions`: `channel_id` (PK), `name`, `allowed_roles` (text[]), `category_id` (nullable) | ✅ |
| 2.4 — RBAC join `WHERE allowed_roles && discordRoles` (PG array overlap) | `allowed_roles` is `text[]` — supports `&&` | ✅ |
| 2.4 — `default_policy: "deny"` | `HivlyConfigSchema.access_control.default_policy: enum('deny','allow')` | ✅ |
| 2.4 — role cache TTL | `access_control.role_cache_ttl` (config) + `user_roles_cache` table (TTL columns) | ✅ |
| 2.4 — community name from `config.discord.guild_id` | `HivlyConfigSchema.discord.guild_id` | ✅ |
| 2.3/2.4 — nginx proxies `/api/` → `backend:3000`, `/health` auth-exempt | `nginx.conf` (Story 1.3) + top-level `/health` route | ✅ |
| Data model correction (7→8 tables) | `schema.ts` defines 8 tables incl. `user_roles_cache` | ✅ |

## Notes for story creation

1. **OAuth2 secrets live in `.env`, not YAML** (secrets/behavior split). `DISCORD_CLIENT_ID`,
   `DISCORD_CLIENT_SECRET`, `DISCORD_REDIRECT_URI`, and `SESSION_TTL_DAYS` are `.env` values,
   correctly absent from `HivlyConfigSchema`. When creating Story 2.3, verify `.env.example`
   lists them.
2. **`channel_permissions.category_id`** (DB, nullable) has no counterpart in the config
   `ChannelPermissionSchema` — it will be `NULL` on the config-driven upsert (2.4). Expected;
   populated later (or left null) — not a divergence.

## Web/bundle prerequisite (action item #3) — resolved

`packages/web` now imports only browser-safe `@hivly/shared/schemas`; an ESLint guard bans the
root barrel / `/db` / `/config` in `packages/web/**`. Web bundle dropped 408 KB → 252 KB with no
`pg`/Node built-ins. Story 2.1 can build the design system without dragging server deps.
