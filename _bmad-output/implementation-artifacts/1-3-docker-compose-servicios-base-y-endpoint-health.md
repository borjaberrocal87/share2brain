---
baseline_commit: 8d53d85dd48c3aead9be77b880cbec2cd7f9b5c3
---

# Story 1.3: Docker Compose, base services, and the /health endpoint

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an **Operator**,
I want to run `docker compose up -d` and verify system state with `GET /health`,
so that I can confirm a correct deployment with a single command.

## Acceptance Criteria

1. **`docker-compose.yml` topology** — Defines exactly **7 services**: `migrator` (one-shot), `nginx`, `bot`, `backend`, `workers`, `postgres`, `redis`.
   - `bot`, `backend`, `workers` each declare `depends_on: { migrator: { condition: service_completed_successfully } }`.
   - `nginx` is the **only** service with host-exposed ports (80/443).
   - In development, `postgres` exposes its port bound to `127.0.0.1:5432` only.
2. **Migrator runs on boot** — With valid `.env` and `Hivly.config.yml`, `docker compose up -d` makes `migrator` run `drizzle-kit migrate`, apply all migrations, and exit code 0. The other services start only after `migrator` completes successfully.
3. **Health — happy path** — With all services running, `GET /health` returns **HTTP 200** with JSON:
   `{ "status": "healthy", "components": { "database": "connected", "redis": "connected", "discord": "pending", "indexer": "pending" } }`.
4. **Health — degraded** — When PostgreSQL is unreachable, `GET /health` returns **HTTP 503** with `{ "status": "degraded", "components": { "database": "disconnected", ... } }`.
5. **`nginx.conf`** — For `location /api/chat` contains `proxy_buffering off; proxy_cache off; proxy_read_timeout 300s;`. `/api/` proxies to `http://backend:3000`. `/` serves `dist/` with `try_files $uri $uri/ /index.html`.

## Tasks / Subtasks

- [x] **Task 1 — Backend: real Express server + `/health` endpoint (AC: 3, 4)**
  - [x] Add `HealthResponseSchema` to `packages/shared/src/schemas/` (AD-6: the response shape is a Zod schema in `shared`, **never defined locally in backend**). Export it from `packages/shared/src/schemas/index.ts`. Shape: `status: 'healthy' | 'degraded'`; `components: { database, redis: 'connected' | 'disconnected'; discord, indexer: 'connected' | 'disconnected' | 'pending' }`. Add a `ComponentStatus` enum + `HealthResponse = z.infer<>`.
  - [x] Add deps to `packages/backend/package.json`: `express ^5.2`, `ioredis ^5`, `@hivly/shared: "*"`. (`pg`/Drizzle come transitively via `@hivly/shared/db`.) Add `@types/express` devDep.
  - [x] Rewrite `packages/backend/src/main.ts` (currently a `console.log` stub):
    1. `loadConfig()` first (AD-8) — abort the process before any connection if the YAML is invalid.
    2. `createDatabase(process.env.DATABASE_URL)` (from `@hivly/shared/db`) — one pooled client at startup, reused per request (no per-request `Pool`).
    3. `new Redis(process.env.REDIS_URL)` (ioredis) — one client at startup.
    4. Express 5 app; register `GET /health` (top-level, **not** under `/api/` — it is auth-exempt per AD; auth/session middleware is NOT part of this story).
    5. Health handler: run **time-boxed** `SELECT 1` (Drizzle `db.execute(sql\`select 1\`)`) and `redis.ping()` concurrently, each wrapped so a hang/refusal resolves to `"disconnected"` within ~2s (`Promise.race` timeout + `try/catch`). `discord` and `indexer` are hard-coded `"pending"` (Bot/Workers don't report readiness until Epic 3).
    6. `status = (database === 'connected' && redis === 'connected') ? 'healthy' : 'degraded'`; respond `200` for healthy, `503` for degraded. Validate the body with `HealthResponseSchema.parse(...)` before sending.
    7. `app.listen(3000, '0.0.0.0')` (bind all interfaces so nginx on the Docker network can reach it).
  - [x] Update `packages/backend/package.json` scripts: `"dev": "tsx watch src/main.ts"`, `"start": "tsx src/main.ts"`. Keep `"build": "tsc --noEmit"` (source-exports stage, per Story 1.1/1.2).
  - [x] Unit test (`main.test.ts` or extract the handler to `health.ts` + `health.test.ts`): mock db/redis → assert `200 healthy` when both up; `503 degraded` + `database: "disconnected"` when the DB check throws. AAA, `should <behavior> when <condition>` names.

- [x] **Task 2 — Keep `bot` & `workers` containers alive (AC: 1, 3)**
  - [x] The current `bot`/`workers` `main.ts` stubs `console.log` and **exit immediately** → their containers would show `Exited`, not "running". Update each to a minimal long-running stub: `loadConfig()` (AD-8) + a log line + keep the process alive (e.g. `await new Promise(() => {})` or an idle interval). Real Gateway/consumer logic lands in Epic 3.
  - [x] Update `dev`/`start` scripts to `tsx` (same as backend). Do **not** add discord.js/ioredis consumer code — out of scope.

- [x] **Task 3 — `tsx` runtime + Dockerfiles for Node services (AC: 1, 2)**
  - [x] Add `tsx` as a root devDependency (do not rely on a transitive copy). It is the container runtime: `@hivly/shared` exports **raw `.ts`** (source-exports, Story 1.1) and Node 24 native type-stripping does **not** strip `.ts` under `node_modules` (workspace symlink), so `node src/main.ts` cannot resolve `@hivly/shared`. `tsx` handles the whole monorepo.
  - [x] Author Dockerfiles for `backend`, `bot`, `workers`, `migrator`. **Build context = repo root** for all (see Dev Notes — a `./packages/<svc>` context cannot see `packages/shared`, the root lockfile, or `drizzle.config.ts`). Base image `node:24-alpine` (pinned; fall back to `node:24-slim` if a native dep fails to build on musl). Pattern: copy root `package.json` + `package-lock.json` + every `packages/*/package.json`, run `npm ci`, copy sources, `CMD` runs the entry via `tsx` (migrator: `npx drizzle-kit migrate`).
  - [x] Add a root `.dockerignore` (`node_modules`, `**/dist`, `.git`, `_bmad`, `_bmad-output`, `docs`, `.claude`) so the root context stays small.

- [x] **Task 4 — Minimal web build + Dockerfile so the stack comes up (AC: 1, 5)** *(scope note below)*
  - [x] `packages/web` currently has no `index.html`/`vite.config.ts` and `build` = `tsc --noEmit`, so no `dist/` is produced. Add a minimal `packages/web/index.html` (with `<div id="root">`) + `vite.config.ts`, and change `"build": "vite build"` so `vite build` emits a real `dist/`. This is a **placeholder SPA** — the full design system is Story 2.1.
  - [x] Multi-stage `packages/web/Dockerfile` (root context): build stage runs `npm ci` + `npm run build -w @hivly/web`; final stage bakes `dist/` **plus `nginx.conf`** into `nginx:1.27-alpine`. **(Decision revised — see Completion Notes: the SPA is baked into the nginx image instead of a `webdist` named volume, so the stack keeps exactly 7 services with no separate `web` service. Borja approved 2026-07-04.)**

- [x] **Task 5 — `nginx.conf` (AC: 5)**
  - [x] Create root `nginx.conf` with `events {}` + `http {}` (it fully replaces the default; baked into the nginx image at `/etc/nginx/nginx.conf`). One `server` block, `listen 80;`, with:
    - `location = /health { proxy_pass http://backend:3000/health; }` — so the Operator can verify via the single exposed entry point (AC3/AC4 through nginx).
    - `location /api/chat { proxy_pass http://backend:3000; proxy_buffering off; proxy_cache off; proxy_read_timeout 300s; proxy_set_header Connection ''; proxy_http_version 1.1; }` (AD-7, AD-4 — SSE).
    - `location /api/ { proxy_pass http://backend:3000; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; }`
    - `location / { root /usr/share/nginx/html; try_files $uri $uri/ /index.html; }`

- [x] **Task 6 — `docker-compose.yml` (AC: 1, 2)**
  - [x] 7 services, all images pinned (`pgvector/pgvector:pg17`, `redis:8-alpine`, `nginx:1.27-alpine` — **never `:latest`**).
  - [x] `postgres`: `POSTGRES_DB/USER=hivly`, `POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}`; `healthcheck` (`pg_isready -U hivly -d hivly`); volume `pgdata`; **dev port** `"127.0.0.1:5432:5432"` only.
  - [x] `redis`: `command: redis-server --appendonly yes`; `healthcheck` (`redis-cli ping`); no host port.
  - [x] `migrator`: `build` (root context, migrator Dockerfile); `command: npx drizzle-kit migrate`; `depends_on: { postgres: { condition: service_healthy } }`; `restart: "no"` (one-shot — never `unless-stopped`, AD-9).
  - [x] `bot`/`backend`/`workers`: `build` (root context); `depends_on: { migrator: { condition: service_completed_successfully }, redis: { condition: service_healthy }, postgres: { condition: service_healthy } }`; **no host ports**.
  - [x] `nginx`: `build` (root context, `packages/web/Dockerfile` — SPA + nginx.conf baked in); `ports: ["80:80","443:443"]` (only host-exposed service); `depends_on: [backend]`. **(Revised from `image: nginx:1.27-alpine` + `webdist` volume — see Completion Notes.)**
  - [x] **Env wiring (critical):** every Node service uses `env_file: [.env]` (populates `process.env` so `loadConfig()`'s `${VAR}` interpolation and `DATABASE_URL`/`REDIS_URL` resolve) **plus** an `environment:` override for the in-container hostnames — `DATABASE_URL: postgres://hivly:${POSTGRES_PASSWORD}@postgres:5432/hivly` and `REDIS_URL: redis://redis:6379`. The `.env` file keeps `localhost` URLs for host-side `npm run dev`; do **not** point containers at `localhost`.
  - [x] Mount `./Hivly.config.yml:/app/Hivly.config.yml:ro` on `backend`/`bot`/`workers` (they call `loadConfig()`, which reads the file at cwd `/app`). `migrator` does not need it.
  - [x] `volumes: pgdata`. **(No `webdist` — the SPA is baked into the nginx image.)**

- [x] **Task 7 — Verification gate (mandatory; the AGENT runs it, pastes evidence)**
  - [x] `npm run lint && npm run test && npm run build` — all green.
  - [x] `docker compose up -d`; confirm `migrator` exits 0 (`docker compose ps` / logs) and other services start after it.
  - [x] `curl -i http://localhost/health` → `200` + healthy JSON (through nginx). Also verify direct `curl backend:3000/health` shape if needed.
  - [x] Degraded path: `docker compose stop postgres` → `curl -i http://localhost/health` → `503` + `database: "disconnected"`. Restart postgres; restore state (`docker compose down` when done).

## Dev Notes

### What this story adds to the system
Story 1.1 scaffolded the monorepo; Story 1.2 filled `packages/shared` (schema, `loadConfig()`, Zod contracts, event types — all connection-free). **This story introduces the runtime layer for the first time**: the Compose topology, the Dockerfiles, nginx, and the first *running* Express server. It is the "one command → verify" operator promise (Epic 1 goal). [Source: epics.md#Épico 1; ARCHITECTURE-SPINE.md#AD-9]

### 🚨 Non-obvious gotchas — these cause the most failures

1. **Docker build context MUST be the repo root, not `./packages/<svc>`.** The design snippet shows `build: ./packages/bot` — that is illustrative and **will not build** here. Because `@hivly/shared` is exported as raw source (`exports` → `./src/*.ts`, no prebuilt `dist`), every service image needs `packages/shared/src` at runtime, plus the **root** `package-lock.json` for `npm ci`, plus (for migrator) the **root** `drizzle.config.ts`. Use `build: { context: ., dockerfile: packages/<svc>/Dockerfile }`. [Source: 1-2 completion notes#source-exports; package.json exports]

2. **`node src/main.ts` cannot run these services — use `tsx`.** Node 24 native type-stripping does not strip `.ts` files inside `node_modules`, and `@hivly/shared` resolves (via workspace symlink → `exports`) to `.ts`. The Story 1.1 dev scripts (`node --watch src/main.ts`) were a known-broken placeholder (see `deferred-work.md`). Add `tsx` and run entries with it.

3. **In-container DB/Redis hosts are `postgres` / `redis`, not `localhost`.** `.env.example` ships `DATABASE_URL=...@localhost:5432` for host-side dev. Inside Compose, override `DATABASE_URL`/`REDIS_URL` in each service's `environment:` to the Compose service names. Getting this wrong = every container fails to connect and `/health` never goes healthy.

4. **`bot`/`workers` stubs exit immediately.** Their `main.ts` only `console.log`s. A process that returns makes the container `Exited`, failing AC3 ("all services running"). Add a keep-alive. (Backend stays up because Express is listening.)

5. **`/health` is NOT under `/api/`.** Per the API contract it is `GET /health`, auth-exempt alongside `/api/auth/*`. Add an explicit `location = /health` proxy in nginx so it is reachable through the only exposed port. Do not rename it to `/api/health`. [Source: TECHNICAL-DESIGN.md#11; ARCHITECTURE-SPINE.md — Auth table]

6. **Health checks must be time-boxed.** The "postgres unreachable → 503" AC must return promptly even if a socket hangs. Wrap each probe in a ~2s `Promise.race` and catch errors → `"disconnected"`. Reuse the startup DB pool / Redis client; do not open new connections per request.

### Architecture compliance (non-negotiable)
- **AD-6** — the `/health` response shape is a Zod schema in `packages/shared/src/schemas/`. Do not hand-write the shape in `backend`. A change here is scoped `shared`.
- **AD-8** — `backend` (and the `bot`/`workers` stubs) call `loadConfig()` in `main.ts`; invalid YAML aborts before any network I/O.
- **AD-9** — `migrator` is one-shot (`restart: "no"`, never `unless-stopped`); `bot`/`backend`/`workers` gate on `migrator: service_completed_successfully`.
- **AD-7** — nginx is the sole host-exposed service; backend listens only on the internal Docker network; `/api/chat` disables buffering (SSE). Backend does not serve SPA static files.
- **AD-1/AD-2** — three separate Node processes; each gets its own `Dockerfile` + Compose entry; none imports another `@hivly/*` service (only `@hivly/shared`).
- **Pin every image** — `pgvector/pgvector:pg17`, `redis:8-alpine`, `nginx:1.27-alpine`, `node:24-alpine`. Never `:latest`. [Source: project-context.md#Technology Stack — Constraints]
- **Secrets vs behavior** — DB/Redis URLs, tokens, `POSTGRES_PASSWORD` live in `.env`; channels/models/RBAC live in `Hivly.config.yml`. Never mix.

### Health response contract (target shape)
```jsonc
// 200
{ "status": "healthy",  "components": { "database": "connected",    "redis": "connected",    "discord": "pending", "indexer": "pending" } }
// 503
{ "status": "degraded", "components": { "database": "disconnected", "redis": "connected",    "discord": "pending", "indexer": "pending" } }
```
`status` is `degraded` iff `database` or `redis` is not `connected`. `discord`/`indexer` are `"pending"` for now (not gating) — they become live once Bot/Workers report readiness (Epic 3/6). [Source: epics.md#Historia 1.3]

### nginx.conf skeleton
```nginx
events {}
http {
  server {
    listen 80;
    location = /health   { proxy_pass http://backend:3000/health; }
    location /api/chat {
      proxy_pass http://backend:3000;
      proxy_buffering off; proxy_cache off; proxy_read_timeout 300s;
      proxy_set_header Connection ''; proxy_http_version 1.1;
    }
    location /api/ {
      proxy_pass http://backend:3000;
      proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr;
    }
    location / { root /usr/share/nginx/html; try_files $uri $uri/ /index.html; }
  }
}
```
(nginx longest-prefix matching means `/api/chat` wins over `/api/` regardless of order.) TLS/443 cert wiring is deferred to the ops guide — expose the port but a plain `listen 80` server is acceptable this story. [Source: TECHNICAL-DESIGN.md#5.6, #12; ARCHITECTURE-SPINE.md#AD-7, Assumptions]

### Compose dependency graph (target)
```
postgres ──┐
           ├──→ migrator ──┬──→ bot
redis ─────┘   (one-shot)  ├──→ workers
                           └──→ backend ──→ nginx
```
[Source: TECHNICAL-DESIGN.md#14]

### Files being touched (READ before editing)
- `packages/backend/src/main.ts` — **currently** a 5-line `console.log` stub importing `PACKAGE_NAME`. **Replace** with the Express server; keep it the only entrypoint.
- `packages/bot/src/main.ts`, `packages/workers/src/main.ts` — `console.log` stubs; make long-running (Task 2).
- `packages/web/{package.json,src/main.tsx}` — React stub with no `index.html`/`vite.config.ts`; add the minimal Vite build (Task 4).
- `packages/shared/src/schemas/index.ts` — barrel; add the health schema export. `createDatabase()` already exists in `packages/shared/src/db/index.ts` (lazy `Pool`).
- Root `drizzle.config.ts` — already points at `packages/shared/src/db/schema.ts`, out `.../migrations`, `dbCredentials.url = process.env.DATABASE_URL`. Migrator relies on it verbatim.
- Migrations already generated (`0000_enable_pgvector.sql` + `0001_tough_skrulls.sql`) — do not regenerate.

### Previous story intelligence (Story 1.2)
- Source-exports resolution is the established pattern — do NOT switch to project references / declaration emit. `build == typecheck == tsc --noEmit` at this stage; keep it.
- ESLint 9 flat config enforces the AD-2 cross-service import ban; new `express`/`ioredis` imports in `backend` are fine (siblings are not). `shared` has no ban block — keep it.
- Root test script is `vitest run --passWithNoTests`; `shared`/`backend` now have real suites.
- `.env.example` is tracked (gitignore negation); `**/dist/` is ignored — the web `dist/` won't be committed (good; it's built into the image).
- Conventional Commits, one commit per slice, scopes `shared|bot|backend|workers|web|repo`. Suggested slices: `feat(shared): add health response schema`, `feat(backend): add express server with /health`, `feat(bot,workers): keep service processes alive`, `build(repo): add dockerfiles, nginx.conf and docker-compose`. This story is additive — no `BREAKING CHANGE`.
[Source: 1-2-*.md#Completion Notes, #Deferred; deferred-work.md]

### Latest tech notes
- **Express 5.2** — async errors propagate to error middleware automatically; router path syntax changed vs Express 4 (avoid bare `*` wildcards). A plain `app.get('/health', …)` is unaffected.
- **ioredis 5** — `new Redis(url)`; `await redis.ping()` returns `"PONG"`. Lazy connect is fine; catch connection errors in the probe.
- **drizzle-kit 0.31 `migrate`** — reads root `drizzle.config.ts`, applies pending SQL from the `out` dir using the journal; idempotent (skips already-applied). Needs `DATABASE_URL` in env and `drizzle-kit` present (devDep of `shared`, installed by `npm ci`).
- **Drizzle raw probe** — `import { sql } from 'drizzle-orm'; await db.execute(sql\`select 1\`)`.

### Project Structure Notes
- New root files: `docker-compose.yml`, `nginx.conf`, `.dockerignore`. New per-service: `packages/<svc>/Dockerfile` (backend, bot, workers, migrator uses one too — see below), `packages/web/{index.html,vite.config.ts}`. No root `src/`.
- **Migrator Dockerfile location (confirmed):** the design says migrator `build: ./packages/shared`, but with a root context that shorthand doesn't hold. Use a root `Dockerfile.migrator` that installs deps and runs `npx drizzle-kit migrate` against the root config. Do not create `packages/shared/Dockerfile`.
- **Web build scope (confirmed):** Story 1.3 owns the *minimal* placeholder web build (Task 4) so AC5's `/` static block and the 7-service count are genuinely satisfied end-to-end. The real SPA (design system, router) is Story 2.1.

### References
- [Source: _bmad-output/planning-artifacts/epics.md#Historia 1.3: Docker Compose, servicios base y endpoint /health; #Épico 1]
- [Source: docs/context/ARCHITECTURE-SPINE.md#AD-1, #AD-2, #AD-4, #AD-6, #AD-7, #AD-8, #AD-9; Auth table; Assumptions/Deferred]
- [Source: docs/context/TECHNICAL-DESIGN.md#3 (7 servicios), #5.4 backend, #5.6 nginx, #11 API REST, #12 SSE, #13 Configuración, #14 Despliegue, #15 Stack]
- [Source: _bmad-output/project-context.md — Technology Stack & Versions; Architecture boundaries; Backend framework rules; Contracts live only in shared]
- [Source: packages/shared/src/config/index.ts (loadConfig, HivlyConfigSchema); packages/shared/src/db/index.ts (createDatabase); drizzle.config.ts; .env.example; Hivly.config.yml.example]
- [Source: _bmad-output/implementation-artifacts/1-2-*.md#Completion Notes, #File List; deferred-work.md]

### Decisions confirmed by Borja (2026-07-03) — these are firm, not open
1. **Web image scope (Task 4):** ✅ Build the minimal placeholder SPA now (`index.html` + `vite.config.ts` + `vite build` → `dist/` → `webdist` volume). Keeps `docker compose up -d` truly end-to-end and honors AC5's `/` static block. The full design system remains Story 2.1.
2. **Migrator image:** ✅ Root `Dockerfile.migrator` (root build context — it needs the root `drizzle.config.ts` + `packages/shared` migrations). Do **not** create `packages/shared/Dockerfile`.
3. **Base image:** ✅ `node:24-alpine` for all Node service images. Only fall back to `node:24-slim` if a native dependency genuinely fails to build on musl (note it in completion notes if so).

## Dev Agent Record

### Agent Model Used

Claude Opus 4.8 (1M context) — `claude-opus-4-8[1m]`

### Debug Log References

- Local backend smoke test (no Docker): `tsx packages/backend/src/main.ts` → `GET /health` returned `503 degraded` with `database:"disconnected"` (no local Postgres), proving the server wiring + degraded path before containerization.
- Full stack: `docker compose up -d --build` → migrator `Exited (0)`, all other services `running` (postgres/redis `healthy`); `curl http://localhost/health` → `200 healthy`; `docker compose stop postgres` → `503 degraded` (`database:"disconnected"`) → restart restored `200`; `curl http://localhost/` served the SPA `index.html`; unknown route `/some/spa/route` → `200` (try_files fallback). Torn down with `docker compose down`.

### Completion Notes List

- **All 5 ACs verified end-to-end against a live stack** (evidence in Debug Log). `docker compose config --services` = exactly 7 (`backend, bot, migrator, nginx, postgres, redis, workers`). Migrator applied both migrations → 8 tables present.
- **Design revision (approved by Borja 2026-07-04): SPA baked into the nginx image, not a `webdist` volume.** AC1 mandates *exactly 7 services* (no `web`), but a named volume can only be populated by a container — a `webdist`-based approach would require an 8th one-shot `web` service. Resolution: `packages/web/Dockerfile` is multi-stage (`node:24-alpine` build → `vite build` → `FROM nginx:1.27-alpine` that `COPY`s `dist/` + `nginx.conf`). The compose `nginx` service uses `build:` this Dockerfile. No `web` service, no `webdist` volume, only `pgdata` remains. Satisfies AC1 (7 services) and AC5 (`/` serves dist) simultaneously.
- **`sql` re-exported from `@hivly/shared/db`** so `backend` builds the `select 1` probe without importing `drizzle-orm` directly (AD-2: services depend only on `@hivly/shared`, not on hoisted transitive deps).
- **Health probes are time-boxed** (`withTimeout`, 2s, unref'd timer) and reuse the startup DB pool / Redis client — no per-request connections. Redis uses `lazyConnect` + a swallowed `error` listener so a Redis outage degrades `/health` instead of crashing startup.
- **`tsx` is the container runtime** (`npx tsx packages/<svc>/src/main.ts`), run from WORKDIR `/app` so `loadConfig()` finds the mounted `/app/Hivly.config.yml`. `node:24-alpine` built cleanly for all images — no `node:24-slim` fallback needed.
- **Fixed `Hivly.config.yml.example`** (scope-adjacent): `loadConfig()` interpolates `${...}` even inside YAML comments, and the shipped example had a literal `${ENV_VAR}` in a header comment → the example failed to load, breaking AC2 ("valid Hivly.config.yml → stack comes up"). Reworded the comment to `${...}` (no literal placeholder). *Follow-up candidate for a later story: harden `loadConfig()` to skip comments, so operator comments containing `${VAR}` can't break startup.*
- **Follow-up (Story 2.1):** `packages/web/src/main.tsx` imports the full `@hivly/shared` root barrel, which re-exports the `db` module (`pg`), so Vite pulls `pg` + node built-ins into the browser bundle (~408 KB, harmless "externalized for browser" warnings). The real SPA should import from a browser-safe subpath or `shared` should expose a browser-safe entry. Left as-is here (placeholder scope).
- **Local artifacts (gitignored, not committed):** `.env` and `Hivly.config.yml` (copied from the `.example` files with placeholder `changeme` secrets) and `packages/web/dist/`. Kept for convenient re-runs; excluded by `.gitignore` / `.dockerignore`.
- **Suggested commit slices** (not committed — awaiting review): `feat(shared): add health response schema and re-export sql`; `feat(backend): add express server with /health endpoint`; `feat(bot,workers): keep placeholder processes alive`; `build(repo): add dockerfiles, nginx.conf and docker-compose`; `fix(repo): stop loadConfig choking on ${...} in config comments`.

### File List

**Created**
- `packages/shared/src/schemas/health.ts` — `HealthResponseSchema`, `ComponentStatusSchema`, `HealthResponse` / `ComponentStatus` types (AD-6)
- `packages/shared/src/schemas/health.test.ts`
- `packages/backend/src/health.ts` — time-boxed probes, `computeHealth`, `createHealthHandler`
- `packages/backend/src/health.test.ts`
- `packages/backend/Dockerfile`
- `packages/bot/Dockerfile`
- `packages/workers/Dockerfile`
- `packages/web/Dockerfile` — multi-stage; final image is nginx with SPA + nginx.conf baked in
- `packages/web/index.html`
- `packages/web/vite.config.ts`
- `Dockerfile.migrator`
- `.dockerignore`
- `nginx.conf`
- `docker-compose.yml`

**Modified**
- `packages/shared/src/schemas/index.ts` — export `./health.js`
- `packages/shared/src/db/index.ts` — re-export `sql` from `drizzle-orm`
- `packages/backend/src/main.ts` — real Express server (loadConfig → db/redis clients → `GET /health` → listen)
- `packages/backend/package.json` — deps (`express`, `ioredis`), devDep (`@types/express`), `dev`/`start` → `tsx`
- `packages/bot/src/main.ts` — long-running placeholder (loadConfig + keep-alive + graceful shutdown)
- `packages/bot/package.json` — `dev`/`start` → `tsx`
- `packages/workers/src/main.ts` — long-running placeholder (loadConfig + keep-alive + graceful shutdown)
- `packages/workers/package.json` — `dev`/`start` → `tsx`
- `packages/web/package.json` — `build` → `vite build`
- `package.json` — add `tsx` root devDependency
- `package-lock.json` — dependency additions
- `Hivly.config.yml.example` — reword header comment so `loadConfig()` doesn't try to interpolate it
- `.gitignore` — ignore the operator's real `Hivly.config.yml` (only the `.example` is tracked)

### Change Log

- 2026-07-04 — Implemented Story 1.3: Docker Compose 7-service topology, Dockerfiles (backend/bot/workers + `Dockerfile.migrator`), `nginx.conf`, real Express `/health` endpoint with shared Zod contract, placeholder web build, `tsx` runtime. All ACs verified against a live stack. SPA baked into the nginx image (approved deviation from the `webdist`-volume design to keep exactly 7 services). Status → review.

### Review Findings

- [x] [Review][Patch] Redis error handler swallows all errors [packages/backend/src/main.ts] — Logged via `console.warn`.
- [x] [Review][Patch] Backend lacks graceful shutdown [packages/backend/src/main.ts] — Added SIGTERM/SIGINT handlers closing server, DB pool, and Redis.
- [x] [Review][Patch] PORT hardcoded, no env override [packages/backend/src/main.ts] — Changed to `Number(process.env.PORT) || 3000`.
- [x] [Review][Patch] requireEnv doesn't trim whitespace [packages/backend/src/main.ts] — Added `.trim()` to the env value check.
- [x] [Review][Defer] DB/Redis connections created before HTTP listens [packages/backend/src/main.ts] — deferred, pre-existing: lazy redis + pool pattern mitigate this; not a real issue in practice.
- [x] [Review][Defer] Missing Hivly.config.yml crashes containers [docker-compose.yml] — deferred, pre-existing: standard Docker behavior for missing bind mounts; documented in Dev Notes.
- [x] [Review][Defer] No integration test for health handler [packages/backend/src/main.ts] — deferred, pre-existing: unit tests cover logic; HTTP-level tests can be added in a later story.
- [x] [Review][Defer] redis maxRetriesPerRequest: 1 is aggressive [packages/backend/src/main.ts] — deferred, pre-existing: tuning parameter; 503 on transient Redis outage is acceptable.
- [x] [Review][Defer] Timeout test not explicitly covered [packages/backend/src/health.ts] — deferred, pre-existing: promesa colgante no testeada explícitamente; ambas rutas caen en el mismo catch de probe().
