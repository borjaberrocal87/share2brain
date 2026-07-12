# Share2Brain

> Turn your Discord community's buried knowledge into a searchable second brain — self-hosted, with verifiable sources.

Share2Brain is a self-hosted AI agent that curates an index of the resources (links) shared in your Discord community and answers natural-language questions **citing the original conversations**. If it can't find a source, it says so — no invented answers.

Each operator runs an independent instance serving **one Discord guild**. Your data at rest never leaves your server, and the whole stack starts with a single command: `docker compose up -d`.

## Why Share2Brain?

- 📚 **Knowledge dies in the scroll.** The best answers and resources in a Discord server get buried within days. Share2Brain indexes them automatically and makes them searchable forever.
- 🏠 **Your data stays yours.** No SaaS in the middle. Everything runs on your infrastructure; only the inference calls go to the LLM/embeddings providers *you* configure.
- 🔍 **Answers you can verify.** Every response cites the real messages it came from (channel, author, date, link). Retrieval-augmented, not hallucination-augmented.
- 🔒 **Respects Discord permissions.** Role-based access control is enforced *inside* the vector query — nobody ever gets answers based on channels they can't see.

## Features

- **Automatic indexing** — A Discord bot reads the configured channels and indexes messages containing URLs, enriching each link with an AI-generated title and description.
- **Semantic search** — Results ranked by embedding similarity (pgvector), not just keywords.
- **RAG agent chat** — Streaming responses (SSE) with cited sources. Honest "I don't know" when the knowledge base has no answer.
- **Per-channel RBAC** — Discord roles map to channel access, applied inside the vector query, never as a post-filter.
- **Read tracking** — Each member keeps their own per-fragment read state.
- **Trivial deployment** — One command brings up all 7 Docker Compose services.

## Quick start

**Prerequisites:** Docker + Docker Compose v2, Git, and a [Discord application](https://discord.com/developers/applications) with a bot token.

```bash
# 1. Clone
git clone https://github.com/borjaberrocal87/share2brain.git
cd share2brain

# 2. Configure — two files, never mixed:
cp .env.example .env                                        # secrets (tokens, API keys)
cp Share2Brain.config.yml.example Share2Brain.config.yml    # behavior (channels, models, RBAC)
# Edit both with your values (each file documents every field)

# 3. Launch
docker compose up -d
docker compose ps          # verify: postgres, redis, migrator (one-shot), bot, workers, backend, nginx
```

Open `http://localhost` — nginx is the only exposed service (ports 80/443).

You will need:

- A **Discord bot** with read permissions (token, client ID, client secret) and your server's **guild ID**
- An **LLM API key** (Anthropic, OpenAI, or a custom endpoint)
- An **embeddings API key** (OpenAI or a custom endpoint — Anthropic does not offer embeddings)

## Architecture

npm-workspaces monorepo with a shared domain kernel (hexagonal) + event-driven ingestion over Redis Streams.

```
Discord ──▶ Bot ──▶ Redis Streams ──▶ Workers ──▶ PostgreSQL + pgvector
                                                          ▲
                       Web App (SPA) ──▶ Backend (API + RAG Agent)
```

| Package | Role |
|---|---|
| `packages/shared` | Domain kernel: Drizzle schema, Zod contracts, `loadConfig()` |
| `packages/bot` | Discord Bot — message ingestion (backfill + realtime + sync) |
| `packages/backend` | Express API + RAG agent (LangGraph) with SSE streaming |
| `packages/workers` | Indexer + Sync consumers (Redis Streams → pgvector) |
| `packages/web` | React + Vite SPA (search, chat, documents, stats) |

**Key invariant:** services depend on `@share2brain/shared` but **never on each other**. The Bot publishes events to Redis Streams; Workers consume them with explicit ACK (at-least-once, idempotent). The Backend only reads the pipeline's results.

## Stack

| Layer | Technology |
|---|---|
| Backend | TypeScript, Node.js 24, Express 5 |
| AI | LangGraph 1.4 (RAG agent), Zod 4 |
| Discord | discord.js 14 |
| Database | PostgreSQL 17 + pgvector 0.8 |
| Event queue | Redis 8 (Streams) |
| ORM / migrations | Drizzle ORM 0.45 + drizzle-kit |
| Web | React 19, Vite 8 |
| Edge | nginx 1.27 (single exposed port) |
| Packaging | Docker Compose v2 (7 services) |
| Testing | Vitest (unit/integration) + Playwright (e2e) |

## Local development

Run the infrastructure in Docker and the app services locally with hot reload:

```bash
npm install                           # install all workspaces (Node.js 24 LTS, npm 10+)
docker compose up -d postgres redis   # infra only
npx drizzle-kit migrate               # apply migrations

npm run dev -w @share2brain/backend   # API + RAG agent on :3000
npm run dev -w @share2brain/web       # Vite dev server (SPA) on :5173
npm run dev -w @share2brain/bot       # Discord Bot (ingestion)
npm run dev -w @share2brain/workers   # Indexer + Sync consumers
```

In dev, Vite (`:5173`) proxies `/api/*` to the Backend (`:3000`).

### Commands

```bash
npm run lint                 # ESLint across all packages
npm run test                 # Vitest (unit)
npm run test:integration     # integration (needs Postgres + Redis)
npm run test:e2e             # Playwright (web)
npm run typecheck            # TypeScript across all workspaces
npm run build                # build all packages

npx drizzle-kit generate     # generate SQL migration from schema.ts
npx drizzle-kit migrate      # apply migrations
```

> **Warning:** don't run `npm run test:integration` against a database a live app
> stack is also using. Stop the app containers first:
> `docker compose stop bot backend workers` (keep postgres + redis).

## Updating a deployment

```bash
git pull
docker compose build
docker compose up -d
# the migrator service applies new migrations automatically
```

## Documentation

Authoritative documentation lives in `docs/`:

| File | Contents |
|---|---|
| `docs/context/PRD.md` | What is built and why |
| `docs/context/ARCHITECTURE-SPINE.md` | Architecture invariants (AD-1…AD-13) |
| `docs/context/TECHNICAL-DESIGN.md` | Concrete design (services, data, pipeline, RAG, auth, API) |
| `docs/data-model.md` | Data model and indexes |
| `docs/api-spec.yml` | REST + SSE endpoints |
| `docs/development_guide.md` | Setup, running, and testing |
| `docs/base-standards.md` | Standards and way of working |

## Contributing

Contributions are welcome — from a typo fix to a new feature. Start with [CONTRIBUTING.md](CONTRIBUTING.md): it covers the dev environment, the monorepo's golden rules, and the verification gate every PR must pass. Look for issues labeled `good first issue` if you're new here.

## License

[MIT](LICENSE) — © Borja Berrocal
