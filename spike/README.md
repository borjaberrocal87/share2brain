# Epic 3 external-integration validation spikes (THROWAWAY)

Decided in the Epic 2 retrospective (`_bmad-output/implementation-artifacts/epic-2-retro-2026-07-05.md`,
Action Item #1): validate Epic 3's two **new external integrations against the real services
BEFORE** building Stories 3.1/3.3 on top of them. This directly addresses the ioredis→node-redis
class of risk from Epic 2 (integration assumptions that only surfaced at implementation time).

These scripts are **throwaway** — delete this folder once both are green.

## Prerequisites (real credentials in `.env`)

The `.env` currently holds placeholders. Fill these with real values first:

| Var | Needed by | Notes |
|---|---|---|
| `DISCORD_BOT_TOKEN` | `gateway.ts` | Bot token from the Discord Developer Portal (NOT the OAuth2 client secret). |
| `DISCORD_GUILD_ID` | `gateway.ts` | The target guild snowflake. The bot must be **invited to that guild**. |
| `OPENAI_API_KEY` | `embeddings.ts` | A real embeddings key. |

**Discord Developer Portal setup for `gateway.ts`:**
- Bot → enable the **Message Content Intent** (privileged). Without it `message.content` is empty — the spike detects and reports this explicitly.
- Invite the bot to the guild with the `bot` scope and read permissions on the channels listed in `Share2Brain.config.yml → discord.channels` (`enabled: true`).

## Run

```bash
npx tsx --env-file=.env spike/embeddings.ts   # instant — one API call
npx tsx --env-file=.env spike/gateway.ts      # connects, then waits; post a message in an enabled channel
```

Each prints `✅ … VALIDATED` on success (exit 0) or a `✗` diagnostic on failure (exit 1).

## What each validates

- **`gateway.ts`** — token valid, Gateway connects, intents sufficient (incl. privileged MessageContent), bot in guild, enabled channels visible, real `messageCreate` with non-empty content.
- **`embeddings.ts`** — key valid, configured model returns a **1536-dim** vector (matches the `vector(1536)` pgvector column), plus latency.
