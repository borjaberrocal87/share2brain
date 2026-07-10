# E2E visual-verification harness (Playwright)

Boots the **built** SPA (`vite build && vite preview`) against a **deterministic
test backend** and verifies the real visual/CSS acceptance criteria with
`getComputedStyle` — the gap jsdom can't cover (it ignores external stylesheets
and resolves no CSS custom properties). Landed with **Story 4.5**; verifies
Stories 4.3 (Búsqueda) and 4.4 (Documentos) retroactively and is the base
Stories 5.3/5.4 extend.

## Prerequisites

```bash
docker compose up -d postgres redis   # Postgres+pgvector on :5432
npx playwright install chromium        # one-time browser download (chromium only)
```

> **Redis note (this Mac):** the compose Redis publishes **no ports**, so
> `redis://127.0.0.1:6379` (the test-helpers default) is the **Homebrew** Redis —
> make sure it's running (`brew services start redis`). The integration suites use
> the same recipe; the harness inherits it. Override with `REDIS_URL` /
> `DATABASE_URL` if your setup differs. The DB must be migrated (`npx drizzle-kit
> migrate`, or let the `migrator` service run).

## Run

```bash
npm run test:e2e -w @hivly/web        # or: npm run test:e2e (root)
```

Playwright spawns two `webServer`s and tears them down at the end:

1. **Test backend** — `npm run e2e:server -w @hivly/backend`
   (`packages/backend/src/e2e/server.ts`) on `127.0.0.1:3100`. It **reset-then-seeds**
   the `e2e-`-scoped dataset on boot (idempotent, coexists with the dev DB), and
   wires `createApp` with a **fake `DiscordOAuthClient`** + a deterministic
   `queryEmbedder` (one-hot at index 0). No production code path, no auth-bypass
   route — it refuses to start under `NODE_ENV=production`.
2. **Built SPA** — `vite build && vite preview` on `localhost:4173`, with its
   `preview.proxy` pointing `/api` + `/health` at the test backend
   (`HIVLY_API_PROXY_TARGET=http://127.0.0.1:3100`). `vite preview` does **not**
   inherit `server.proxy`, hence the dedicated `preview` block in `vite.config.ts`.

`workers: 1`, chromium only, dark theme forced (tokens differ per theme). HTML
report opens with `npx playwright show-report packages/web/playwright-report`;
per-test screenshots land under `test-results/` (both gitignored).

## Session bootstrap

The SPA gates everything behind a Discord OAuth session, so headless real-Discord
login is impossible — `loginAs` (`tests/helpers/session.ts`) drives the
**fake-OAuth** flow instead:

`GET /api/auth/login` (→ 302, extract `state` from the `Location` header) →
`GET /api/auth/callback?code=<identity>&state=<state>` (→ 302, sets the regenerated
`sid` cookie). `page.request` shares the browser context's cookie jar, so the
cookie lands in the browser automatically; requests go through the preview proxy,
so it's scoped to the SPA origin. `loginAs` also forces `localStorage['hivly-theme']
= 'dark'` before the first navigation.

## Seed identities & dataset

Mapped by the OAuth `code` (`packages/backend/src/e2e/seed.ts`):

| Code (`loginAs`) | Sees | Data |
|---|---|---|
| `e2e-member` (default) | `e2e-ch-general` (3), `e2e-ch-random` (2) | 5 embeddings, similarity spread 1.0/0.8/0.6/0.5/0.3; 2 pre-read → mixed read/unread + sidebar badge; `/api/stats` → kpis 5/2/2/1, coverage 2/5/40%, topUsers Ada Lovelace(3)/Linus Torvalds(2) |
| `e2e-empty` | `e2e-ch-void` (0) | no embeddings → reaches the search / all-read empty states; `/api/stats` returns all-zero figures |

There is also an **invisible** RBAC canary trio (Story 9.3 D3), held by
`e2e-role-none` — no fake-OAuth identity ever carries that role: channel
`e2e-ch-secreto`, message `e2e-msg-s1` (author `Eve Intrusa`, dated "today" at
seed-boot), and its embedding. Neither identity above can ever see it; the
member's `/api/stats` figures pinned above ARE the leak canaries (a regression
would flip resources 5→6, channels 2→3, authors 2→3, and add a 3rd `topUsers`
row). Only the LATEST message of `e2e-author-ada`/`e2e-author-linus`
(`e2e-msg-r2`/`e2e-msg-r1`) carries `author_name` — the rest resolve via the
`author_id` COALESCE fallback (mirrors the post-9.4 no-backfill production
shape; `search.spec.ts`'s `'E2'`-initials assert on `e2e-msg-g1` depends on
this).

RBAC is enforced inside the query (AD-12); the `e2e-role-member` / `e2e-role-empty`
/ `e2e-role-none` role names keep the e2e scope from leaking into the
integration suites and vice versa. Search has **no similarity threshold** (any
query returns the whole scope, LIMIT 5), so the empty state is only reachable
via the empty-scope identity.

## Spec discovery order (invariant)

Playwright discovers spec files **alphabetically** and runs with `workers: 1`, so
they execute in name order: `analytics.spec.ts` → `chat.spec.ts` →
`docs.spec.ts` → `interactions.spec.ts` → `search.spec.ts`.

`analytics.spec.ts` (Story 9.3) sorts **first** on purpose: its assertions bind
to seed-fresh per-user figures (`queries: 1`, `coverage: 2/5/40%`) that
**mutating** specs would otherwise have already perturbed — `chat.spec.ts`'s
Story 5.4 streaming test adds a user message (`queries` KPI), and
`docs.spec.ts`'s "mark all read" test flips coverage to 5/5/100%. Every test in
`analytics.spec.ts` is non-mutating (logins + reads only), so no spec after it
is affected; a fresh backend boot/reseed still makes the whole suite reorder-
independent — a run that only executes `analytics.spec.ts` sees the identical
seed-fresh figures. Keep this in mind before pointing `loginAs` at a mutating
flow inside `analytics.spec.ts`: it would make cross-run and standalone-run
results diverge (same failure mode `chat.spec.ts`'s `toHaveCount(1)` already
guards against with its own ordering).

`chat.spec.ts` is **no longer read-only**: its Story 5.4 **streaming** test
persists a new conversation, so it is ordered **last** in the file (after the
Story 5.3 `toHaveCount(1)` history test and the 5.4 composer/history-load tests,
which must run before any conversation mutation). No chat test asserts an exact
conversation count after that mutation. The conversation rows it writes don't
touch the `documents` / `user_read_status` tables `docs.spec.ts` asserts on, so
`docs.spec.ts`'s "mark all read" (the cross-spec mutating test) still runs last
and stays isolated; Playwright also reseeds on each backend boot. Keep this
invariant in mind when naming new specs: a new mutating spec must sort **after**
any spec whose assertions depend on the seeded read/unread mix, or reseed
explicitly.

## Adding a spec (Stories 5.3 / 5.4)

1. `import { loginAs } from './helpers/session'` and `await loginAs(page)`.
2. Add `<view>.spec.ts` under `tests/`; assert **computed values** (rgb/px) with the
   real token names (`--text-primary` / `--text-muted` / `--text-subtle`), never the
   mockup's `--tx*`.
3. If you need new data, extend `seed.ts` (keep every id `e2e-`-prefixed and never
   widen a cleanup predicate beyond that prefix).
4. Prefer `data-testid` where a computed-style locator would otherwise chain
   fragile `nth()` hops; keep additions minimal and semantic.

> **Fonts** load from Google Fonts (network). Computed `font-family` returns the
> *specified* stack regardless of load, so the assertions are network-independent;
> screenshots may render fallback faces offline.
