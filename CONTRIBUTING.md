# Contributing to Share2Brain

First off — thank you! Whether it's a typo fix, a bug report, or a new feature, every contribution is welcome. This guide gets you from clone to merged PR with zero guesswork.

If anything here is unclear, open an issue and ask. Questions are contributions too.

## Dev environment in 4 steps

**Prerequisites:** Node.js 24 LTS, npm 10+, Docker + Docker Compose v2.

```bash
# 1. Clone and install (npm workspaces — one install for the whole monorepo)
git clone https://github.com/borjaberrocal87/share2brain.git
cd share2brain && npm install

# 2. Configure (secrets in .env, behavior in Share2Brain.config.yml — never mixed)
cp .env.example .env
cp Share2Brain.config.yml.example Share2Brain.config.yml

# 3. Infra in Docker, migrations applied
docker compose up -d postgres redis
npx drizzle-kit migrate

# 4. Run what you're working on, with hot reload
npm run dev -w @share2brain/backend   # API + RAG agent on :3000
npm run dev -w @share2brain/web       # SPA on :5173 (proxies /api/* to :3000)
npm run dev -w @share2brain/bot       # Discord ingestion
npm run dev -w @share2brain/workers   # Indexer + Sync consumers
```

Full detail (including e2e setup) in [`docs/development_guide.md`](docs/development_guide.md).

## The monorepo in 60 seconds

| Package | Role |
|---|---|
| `packages/shared` | Domain kernel: Drizzle schema, Zod contracts, config loader |
| `packages/bot` | Discord Bot (ingestion → Redis Streams) |
| `packages/backend` | Express API + LangGraph RAG agent (SSE) |
| `packages/workers` | Stream consumers (Indexer + Sync → pgvector) |
| `packages/web` | React + Vite SPA |

### Golden rules (architecture invariants)

These are non-negotiable — a PR that breaks one won't be merged, no matter how good the rest is. They come from [`docs/context/ARCHITECTURE-SPINE.md`](docs/context/ARCHITECTURE-SPINE.md) (AD-1…AD-13), the authority when in doubt:

1. **Code lives under `packages/<service>/src/`** — never a root `src/`.
2. **Services never import each other.** Everyone may depend on `@share2brain/shared`; nobody depends on a sibling.
3. **All DB schema (DDL) lives in `packages/shared/src/db/schema.ts`** (Drizzle). Migrations via `drizzle-kit generate` — never hand-edit generated SQL.
4. **All API request/response shapes are Zod schemas in `packages/shared/src/schemas/`.** Backend validates with `.parse()` at the edge; web infers types with `z.infer<>`. No service defines API shapes locally.
5. **RBAC lives inside the vector query** (`WHERE channel_id = ANY(:allowedChannelIds)`) — never as a post-filter.
6. **Workers are idempotent**: `XACK` only after successful processing; re-delivered events UPSERT, never duplicate.
7. **Sessions live in Redis only** — there is no `sessions` table, and there never will be.
8. **Chat streams over SSE** (`fetch` streaming, not `EventSource`, not WebSocket).
9. **No legacy LangChain** — `langchain/chains` / `langchain/memory` imports are banned (enforced by ESLint).
10. **Secrets go in `.env`; behavior goes in `Share2Brain.config.yml`.** Never mix them.

## Making a change

### 1. Branch

Never commit on `main`:

```bash
git switch -c feat/<short-topic>    # or fix/<short-topic>
```

### 2. Write tests

Vitest, co-located as `*.test.ts`. AAA pattern, behavior-driven names (`should <behavior> when <condition>`).

- **Test-first (red → green)** for domain logic, the agent graph, the indexing pipeline, and RBAC expansion.
- Adapter glue (discord.js listeners, HTTP controllers) may be tested after.
- Mock external deps (Discord, LLM, embeddings). No real network/DB in unit tests; integration tests hit real Postgres+pgvector where the value is in the SQL.
- If your change touches ingestion or retrieval, **always** cover idempotency and RBAC (queries must never return fragments outside `allowedChannelIds`).

### 3. Pass the verification gate

Every PR must be green on:

```bash
npm run lint && npm run test && npm run build
```

Touched the DB, API, or UI? Also run the relevant integration/e2e suite (`npm run test:integration` needs Postgres+Redis up — and no live app stack using the same DB; `npm run test:e2e` for the web).

### 4. Commit

[Conventional Commits](https://www.conventionalcommits.org/), English, imperative, ≤72 chars:

```
<type>(<scope>): <summary>
```

- **Types:** `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `ci`
- **Scopes:** `shared` | `bot` | `backend` | `workers` | `web` | `repo`
- One commit per meaningful slice — not a single dump commit.
- A change to the Drizzle schema or a Zod contract is scoped `shared`, even if a consumer motivated it.
- Breaking an API contract? Mark it: `feat(shared)!: ...` + a `BREAKING CHANGE:` footer.

### 5. Open the PR

- Describe **what** and **why**; link the issue it closes.
- Paste the verification gate output (or let CI speak for you).
- Keep PRs focused — one topic per PR reviews faster and merges sooner.

## Code style essentials

- TypeScript **strict**; explicit types on function params and returns. No `any` — use `unknown` or a specific type; prefer Zod-inferred types over hand-written duplicates.
- Files: `camelCase.ts` for modules, `PascalCase.tsx` for React components. Constants `UPPER_SNAKE_CASE`.
- Errors: the unified `{ error, code }` shape from `@share2brain/shared`; never leak raw Discord/LLM/DB errors to clients.
- Logging: the shared logger only; never log secrets or full message content.
- **English only** in code, comments, tests, commits, and docs.

Linting enforces most of this — `npm run lint:fix` is your friend.

## Reporting bugs & proposing features

- **Bugs:** open an issue with steps to reproduce, expected vs. actual behavior, and logs (`docker compose logs -f <service>`). Redact tokens and message content.
- **Features:** open an issue first to discuss the approach before investing in code — especially if it touches an architecture invariant.
- **Security vulnerabilities:** please do **not** open a public issue; use GitHub Security Advisories (see `SECURITY.md`).

## Where to start

Check the issues labeled **`good first issue`** — they're scoped, self-contained, and come with pointers to the relevant files. If you get stuck, comment on the issue; you'll get a response, not silence.

Happy hacking! 🧠
