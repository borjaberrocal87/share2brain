# Share2Brain

> Turn your Discord community's buried knowledge into a searchable second brain — self-hosted, with verifiable sources.

Share2Brain indexes the resources shared in your Discord server and answers natural-language questions **citing the original messages**. Self-hosted, one guild per instance, `docker compose up -d` and you're running. If it can't find a source, it says so — no invented answers.

## Where to go

| I want to… | Go to |
|---|---|
| **See what it does & why** | [Why Share2Brain?](#why-share2brain) |
| **Run it on my server** | [Quick start](#quick-start) → full guide in [docs/self-hosting.md](docs/self-hosting.md) |
| **Understand the design** | [Architecture](#architecture) → invariants in [ARCHITECTURE-SPINE.md](docs/context/ARCHITECTURE-SPINE.md) |
| **Develop / contribute** | [Local development](#local-development) → rules in [CONTRIBUTING.md](CONTRIBUTING.md) |
| **Read the deep docs** | [Documentation](#documentation) |

## Why Share2Brain?

- 📚 **Knowledge dies in the scroll.** The best resources in a Discord server get buried within days. Share2Brain indexes them automatically and keeps them searchable.
- 🔍 **Answers you can verify.** Every response cites the real messages it came from (channel, author, date, link). Retrieval-augmented, not hallucination-augmented.
- 🏠 **Your data stays yours.** No SaaS in the middle — only the inference calls go to the LLM/embeddings providers *you* configure.
- 🔒 **Respects Discord permissions.** Role-based access control is enforced *inside* the vector query, so nobody gets answers from channels they can't see.

## Quick start

**Prerequisites:** Docker + Docker Compose v2, Git, a [Discord application](https://discord.com/developers/applications) with a bot token, and API keys for an LLM + embeddings provider.

```bash
git clone https://github.com/borjaberrocal87/share2brain.git
cd share2brain

cp .env.example .env                                        # secrets (tokens, API keys)
cp Share2Brain.config.yml.example Share2Brain.config.yml    # behavior (channels, models, RBAC)
# Edit both — each file documents every field

docker compose up -d
```

Every variable is documented inline in each file; for what to put where, see **[Environment variables & config](docs/self-hosting.md#environment-variables-and-config)** in the self-hosting guide.

Open `http://localhost` (nginx is the single public entry point). For Discord app setup, first startup, HTTPS, providers, RBAC, and operations, follow **[docs/self-hosting.md](docs/self-hosting.md)**.

## Architecture

npm-workspaces monorepo: a shared domain kernel (hexagonal) + event-driven ingestion over Redis Streams.

```
Discord ──▶ Bot ──▶ Redis Streams ──▶ Workers ──▶ PostgreSQL + pgvector
                                                          ▲
                       Web App (SPA) ──▶ Backend (API + RAG Agent)
```

**Key invariant:** services depend on `@share2brain/shared` but **never on each other**. Full invariants (AD-1…AD-13) live in [ARCHITECTURE-SPINE.md](docs/context/ARCHITECTURE-SPINE.md).

<details>
<summary>Packages & stack</summary>

| Package | Role |
|---|---|
| `packages/shared` | Domain kernel: Drizzle schema, Zod contracts, `loadConfig()` |
| `packages/bot` | Discord Bot — message ingestion (backfill + realtime + sync) |
| `packages/backend` | Express API + RAG agent (LangGraph) with SSE streaming |
| `packages/workers` | Indexer + Sync consumers (Redis Streams → pgvector) |
| `packages/web` | React + Vite SPA (search, chat, documents, stats) |

| Layer | Technology |
|---|---|
| Backend | TypeScript, Node.js 24, Express 5 |
| AI | LangGraph 1.4 (RAG agent), Zod 4 |
| Discord | discord.js 14 |
| Database | PostgreSQL 17 + pgvector 0.8 |
| Event queue | Redis 8 (Streams) |
| ORM / migrations | Drizzle ORM 0.45 + drizzle-kit |
| Web | React 19, Vite 8 |
| Edge | nginx 1.27 (single public entry point) |
| Packaging | Docker Compose v2 (7 services) |
| Testing | Vitest (unit/integration) + Playwright (e2e) |

</details>

## Local development

<details>
<summary>Run infra in Docker, app services locally with hot reload</summary>

```bash
npm install                           # install all workspaces (Node.js 24 LTS, npm 10+)
docker compose up -d postgres redis   # infra only
npx drizzle-kit migrate               # apply migrations

npm run dev -w @share2brain/backend   # API + RAG agent on :3000
npm run dev -w @share2brain/web       # Vite dev server (SPA) on :5173, proxies /api/* to :3000
npm run dev -w @share2brain/bot       # Discord Bot (ingestion)
npm run dev -w @share2brain/workers   # Indexer + Sync consumers
```

```bash
npm run lint                 # ESLint across all packages
npm run test                 # Vitest (unit)
npm run test:integration     # integration (needs Postgres + Redis)
npm run test:e2e             # Playwright (web)
npm run typecheck            # TypeScript across all workspaces
npm run build                # build all packages
```

> **Warning:** don't run `npm run test:integration` against a database a live app stack is also using. Stop the app containers first: `docker compose stop bot backend workers` (keep postgres + redis).

</details>

Full setup and testing details: [docs/development_guide.md](docs/development_guide.md).

## Documentation

Authoritative docs live in `docs/` — go straight to what you need:

| File | Contents |
|---|---|
| [PRD.md](docs/context/PRD.md) | What is built and why |
| [ARCHITECTURE-SPINE.md](docs/context/ARCHITECTURE-SPINE.md) | Architecture invariants (AD-1…AD-13) |
| [TECHNICAL-DESIGN.md](docs/context/TECHNICAL-DESIGN.md) | Concrete design (services, data, pipeline, RAG, auth, API) |
| [data-model.md](docs/data-model.md) | Data model and indexes |
| [api-spec.yml](docs/api-spec.yml) | REST + SSE endpoints |
| [development_guide.md](docs/development_guide.md) | Setup, running, and testing |
| [self-hosting.md](docs/self-hosting.md) | Deployment and operations guide |
| [base-standards.md](docs/base-standards.md) | Standards and way of working |

## Contributing

Contributions are welcome — from a typo fix to a new feature. Start with [CONTRIBUTING.md](CONTRIBUTING.md): dev environment, the monorepo's golden rules, and the verification gate every PR must pass. Look for issues labeled `good first issue` if you're new here.

## License

[MIT](LICENSE) — © Borja Berrocal
