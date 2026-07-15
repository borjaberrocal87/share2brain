---
baseline_commit: ed04d131459de92000da4b7137dd13501b49e7b4
---

# Story 2.6: Demo Discord invite link on the login screen (web/backend)

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an Operator presenting a demo,
I want a "Join the demo Discord server" link under the guest button on the login screen,
so that a visitor who has no access can request an invite to the demo server without leaving the login.

Epic 2 (Auth & App Shell) was completed on 2026-07-05; this story is **additive**, created via
bmad-correct-course (`sprint-change-proposal-2026-07-15-login-demo-invite.md`, approved by Borja on
2026-07-15). It extends the demo/guest-access affordance shipped by Story 2.5 (which itself re-opened
epic-2 additively). No existing story is reworked. Every new field is **optional and backward
compatible** — a deployment that does not configure the invite URL renders exactly as today.

## Acceptance Criteria

1. **Config-driven URL (behavior, not code).** Given `access_control.guest_access.enabled: true`
   AND `access_control.guest_access.invite_url` set to a valid URL, when the SPA probes
   `GET /api/auth/guest`, the 200 body carries `inviteUrl` with that value. The URL lives in
   `Share2Brain.config.yml` (behavior), NEVER in `.env` (secrets) — so a self-hosted fork never points
   at Borja's demo server (AD-6, secrets/behavior split). Note the correct config path is
   **`access_control.guest_access.invite_url`** (NOT `auth.guest_access` — see Dev Notes: the SCP text
   used `auth.` as shorthand; the real block is under `access_control`).
2. **Link renders only when demo active AND URL configured.** Given the login screen with
   `showGuest === true` AND a non-empty `inviteUrl`, when it renders, it shows — inside the existing
   `{showGuest && …}` fragment, after the guest button — a centered row: a brand-blurple Discord icon
   (`#5865F2`, 14px), the i18n prompt `login.noAccess`, and an `<a>` with the i18n label
   `login.joinDemoServer` pointing at `inviteUrl`, opened with `target="_blank" rel="noopener"`.
3. **No link when URL absent (backward compatible).** Given `invite_url` is absent (or guest access is
   off), when the login screen renders, NO invite row appears and there is NO regression to the
   Discord-login or guest-login paths. The guest button, the "o para la demo" divider, and the probe
   all behave exactly as in Story 2.5.
4. **Exact prototype look & feel.** The link is `color: var(--accent-ink)`, `font-weight: 600`, no
   underline, with a transparent `border-bottom` that on **hover** becomes
   `border-bottom-color: var(--accent-ink)` and `opacity: 0.8`, transition `.15s ease`. These live in a
   `.kh-demo-invite-link` CSS class in `components.css` (cascade parity with `.kh-guest-btn`), not inline.
5. **i18n only (no literal strings).** Both copy keys (`login.noAccess`, `login.joinDemoServer`) exist in
   `es.json` AND `en.json` under `login`; the component renders them via `t(...)`. No hardcoded Spanish
   or English text in the TSX (Epic 10 rule, enforced).
6. **Contract lives in shared (AD-6).** The API shape change is a single optional field
   `inviteUrl: z.string().url().optional()` added to `GuestAvailabilityResponseSchema` in
   `packages/shared/src/schemas/auth.ts`. The config schema change (`invite_url`) is in
   `packages/shared/src/config/index.ts`. No service defines the shape locally; the web client infers it.
7. **Verification gate green.** `npm run lint && npm run test && npm run build` all pass; the e2e suite
   passes with the invite-row assertions added (see Task 8). Invariants intact: AD-3 (static SPA), AD-6
   (contracts/schema only in shared), secrets/behavior split.

## Tasks / Subtasks

- [x] **Task 1 — Docs first (docs are the source of truth)** (AC: 1, 6) — update BEFORE code
  - [x] `docs/api-spec.yml`: `GET /api/auth/guest` 200 schema (~L94–98) gains an optional
        `inviteUrl: { type: string, format: uri, example: "https://discord.gg/…" }`; add a one-line note
        that it is present only when configured. Do NOT change the 404 branch or the `POST` verb.
  - [x] `Share2Brain.config.yml.example` (~L107–111, under `access_control.guest_access`): add
        `invite_url: "https://discord.gg/xxxxxxxx"   # optional — demo server invite shown on the login screen`
        (use a placeholder invite, NOT Borja's real code, in the example file).
  - [x] `Share2Brain.config.yml` (~L100–104): add `invite_url: "https://discord.gg/bf8TvtGnZd"` (the real
        demo invite belongs in the operator's live config, which is git-ignored/local).
  - [x] If a `guest_access` block is documented in `docs/context/TECHNICAL-DESIGN.md` §13 config example,
        add the `invite_url` line there too for parity (grep for `guest_access:` first; skip if absent).
- [x] **Task 2 — `packages/shared`: extend the two contracts** (AC: 1, 6)
  - [x] `src/schemas/auth.ts`: `GuestAvailabilityResponseSchema` (L27–29) gains
        `inviteUrl: z.string().url().optional()`. Keep `enabled: z.literal(true)` — the disabled path is
        still a 404, never `{ enabled: false }`. Update the doc comment (L20–26) to mention the optional field.
  - [x] `src/config/index.ts`: the `guest_access` object (L117–122) gains
        `invite_url: z.string().url().optional()`. Keep the block itself optional and the NO-`.default()`
        convention (D4) — the backend resolves absence to "no URL".
- [x] **Task 3 — `packages/backend`: thread `inviteUrl` end-to-end** (AC: 1)
  - [x] `src/infrastructure/guestAccess.ts`: add `inviteUrl?: string` to `ResolvedGuestAccess` (L24–29)
        and resolve `inviteUrl: block?.invite_url` in `resolveGuestAccessConfig` (L40–45). No default — an
        unset URL stays `undefined`.
  - [x] `src/main.ts`: widen the `guestAccess` local type (L114) to include `inviteUrl?: string`; when
        `guest.enabled`, set `inviteUrl: guest.inviteUrl` on the object (L117). The spread at L153 already
        omits the whole key when disabled — no change there.
  - [x] `src/app.ts`: widen the `guestAccess?` type in `AppOptions` (L121) and pass `inviteUrl` through in
        the `createAuthController` call (L217 region — it already forwards `opts.guestAccess`, so widening
        the type is sufficient; verify the object is passed whole).
  - [x] `src/presentation/controllers/authController.ts`: widen the `guestAccess?` dep type (L37) to add
        `inviteUrl?: string`; in `guestAvailability` (L178–186) build the 200 body as
        `GuestAvailabilityResponseSchema.parse({ enabled: true, ...(guestAccess.inviteUrl ? { inviteUrl: guestAccess.inviteUrl } : {}) })`.
        Leave the 404 branch untouched.
  - [x] `src/e2e/server.ts` (L80): add `inviteUrl: 'https://discord.gg/e2e-demo'` to the harness
        `guestAccess` object so the e2e login screen renders the invite row (needed for Task 8).
- [x] **Task 4 — `packages/web` client: widen the probe return** (AC: 2, 3)
  - [x] `src/api/auth.ts`: change `fetchGuestAvailability()` (L42–46) to return
        `{ enabled: boolean; inviteUrl?: string }`. On non-200 → `{ enabled: false }`. On 200 → parse with
        `GuestAvailabilityResponseSchema` and return `{ enabled: parsed.enabled, inviteUrl: parsed.inviteUrl }`.
        Update the doc comment.
- [x] **Task 5 — `packages/web` icon: colorable Discord glyph** (AC: 2, 4)
  - [x] `src/components/icons.tsx`: `DiscordIcon` (L13–19) accepts an optional `color?: string`
        (default `'currentColor'`) and sets `fill={color}`. Do NOT change the shared `IconProps` interface
        for the other icons — add a local prop just for `DiscordIcon` (e.g. `{ size, color = 'currentColor' }:
        IconProps & { color?: string }`). Verify the existing call `<DiscordIcon size={22} />` inside the
        white login button still renders white (default `currentColor` inherits the button's `#fff`).
- [x] **Task 6 — `packages/web` component: render the invite row** (AC: 2, 3, 4, 5)
  - [x] `src/components/LoginScreen.tsx`: change the `showGuest` state to also hold the URL. Simplest:
        keep `showGuest: boolean` and add `const [inviteUrl, setInviteUrl] = useState<string | undefined>()`;
        in the `useEffect` (L63–75) change the `.then((enabled) => …)` callback to
        `.then(({ enabled, inviteUrl }) => { if (active) { setShowGuest(enabled); setInviteUrl(inviteUrl); } })`.
  - [x] Inside the `{showGuest && (…)}` fragment (L167–217), after the guest button (L215), render the
        invite row **only when `inviteUrl`**: `{inviteUrl && (<div …>< DiscordIcon size={14} color="#5865F2" />
        <span>{t('login.noAccess')}</span><a href={inviteUrl} target="_blank" rel="noopener"
        className="kh-demo-invite-link">{t('login.joinDemoServer')}</a></div>)}`. Row layout from the
        prototype: `marginTop: 13, display: flex, alignItems: center, gap: 6, justifyContent: center,
        fontSize: 12.5, color: var(--tx4)`. Add a `data-testid="demo-invite-link"` on the `<a>` for the e2e.
- [x] **Task 7 — `packages/web` styles + locales** (AC: 4, 5)
  - [x] `src/styles/components.css` (after the `.kh-guest-btn` block ~L44): add
        `.kh-demo-invite-link { color: var(--accent-ink); font-weight: 600; text-decoration: none;
        border-bottom: 1px solid transparent; transition: border-color .15s ease, opacity .15s ease; }`
        and `.kh-demo-invite-link:hover { border-bottom-color: var(--accent-ink); opacity: .8; }`.
  - [x] `src/locales/es.json` `login` block: `"noAccess": "¿No tienes acceso?"`,
        `"joinDemoServer": "Únete al servidor Discord de demo"`.
  - [x] `src/locales/en.json` `login` block: `"noAccess": "No access?"`,
        `"joinDemoServer": "Join the demo Discord server"`.
- [x] **Task 8 — Tests + e2e** (AC: 1, 2, 3, 5, 7)
  - [x] Backend unit (`src/presentation/controllers/authController.guest.test.ts`): add cases —
        `guestAvailability` includes `inviteUrl` in the 200 body when `guestAccess.inviteUrl` is set; omits
        it when absent. Reuse the existing `buildController`/`fakeRes` doubles; widen the local `guestAccess`
        param type to accept `inviteUrl`.
  - [x] Web client unit (`src/api/auth.test.ts` — create if absent, mirror an existing `*.test.ts`):
        `fetchGuestAvailability` returns `{ enabled: true, inviteUrl }` on a 200 body with the field;
        `{ enabled: true, inviteUrl: undefined }` when absent; `{ enabled: false }` on a non-200. Mock
        `fetch`.
  - [x] Web component unit (`src/components/LoginScreen.test.tsx` — mirror `SearchView.test.tsx`): with the
        probe mocked to `{ enabled: true, inviteUrl: 'https://discord.gg/x' }`, the link renders with the
        right `href`, `target="_blank"`, `rel="noopener"`, and i18n copy; with `{ enabled: true }` (no URL)
        the link is absent; with `{ enabled: false }` neither the guest button nor the link render.
  - [x] E2E (`packages/web/tests/auth-guest.spec.ts`): extend the first test (or add one) to assert the
        invite row is visible (`getByTestId('demo-invite-link')`), has the configured `href`, opens in a new
        tab (`target=_blank`), and shows the `login.noAccess` copy. NOTE: the "visual harness" is
        assertion-based (`toHaveCSS`/DOM), NOT pixel screenshots — there are no PNG baselines to refresh
        (see Dev Notes). Optionally assert `.kh-demo-invite-link` base `border-bottom-color` is transparent.
- [x] **Task 9 — Verification gate (the AGENT runs it, never the user)** (AC: 7)
  - [x] `npm run lint && npm run test && npm run build` — paste the output. Then run the web e2e suite and
        paste the result. Never mark an AC satisfied without evidence.

## Review Findings

_bmad-code-review 2026-07-15 (3 adversarial layers @ Opus 4.8: Blind Hunter / Edge Case Hunter /
Acceptance Auditor). R1 triage: 1 decision-needed / 1 patch / 0 defer / 3 dismissed. Acceptance Auditor:
all 7 ACs SATISFIED, File List truthful, no material deviation. Both R1 patches applied (below)._

_R2 re-review (after applying the patches): **CONVERGED — 0 actionable, 3 dismissed.** All 3 layers
confirm the fixes are correct with no regression (verified against zod 4.4.3: `invite_url` key stays
optional; `.transform().optional()` does not break the "full block" `toEqual` test; consumers type-check;
nodenext import paths correct). Dismissed: (a) reject-test matcher `/invite_url|guest_access/` — follows
the file's established convention, cannot false-negative; (b) inline refine message vs shared
`LINK_REFINE_MESSAGE` — cosmetic; (c) `api-spec.yml` `format: uri` looser than runtime http(s) — doc-only,
`uri` is a reasonable OpenAPI descriptor. Note: the Dev Notes' claim that `z.string().url()` matched the
`sentry_dsn`/`base_url` idiom is factually wrong (those use `URL.canParse`/regex); `isHttpUrl` aligns the
field with the real convention. No code change in R2 → gate not re-run. Status stays `done`._

- [x] [Review][Patch] Tolerate a blank `invite_url: ""` as "no URL" instead of aborting backend boot — `z.string().url()` rejects the empty string (verified against zod v4), so an operator who blanks the optional field (the natural "turn it off" gesture, vs deleting the line) currently triggers a `ConfigError` in `loadConfig`. Resolution (decision by Borja, 2026-07-15, option 1): coerce `""` → `undefined` so a blank value gracefully hides the invite row. FIXED: `invite_url` now `z.string().refine(v => v === '' || isHttpUrl(v)).transform(v => v === '' ? undefined : v).optional()`. [packages/shared/src/config/index.ts] (edge, was decision-needed)
- [x] [Review][Patch] Restrict `invite_url` / `inviteUrl` to http(s) schemes — `z.string().url()` accepts `javascript:` and `data:` URLs (verified against zod v4); the value flowed unmodified through config → probe body → `<a href={inviteUrl}>` on the login screen. FIXED: both shared schemas now validate the scheme with the project's canonical `isHttpUrl` helper (`schemas/linkRefine.ts`, URL.canParse convention — replacing the deprecated `z.string().url()`), rejecting `javascript:`/`data:`. [packages/shared/src/config/index.ts, packages/shared/src/schemas/auth.ts] (blind+edge)

## Dev Notes

### CRITICAL corrections to the Sprint Change Proposal

The SCP (`sprint-change-proposal-2026-07-15-login-demo-invite.md`) is an accurate design but contains two
naming/framing inaccuracies verified against the actual code — follow the code, not the SCP text:

1. **Config path.** The SCP repeatedly writes `config.auth.guest_access.invite_url` and
   `auth.guest_access`. There is **no `auth` config block**. Guest access lives under
   **`access_control.guest_access`** (`packages/shared/src/config/index.ts:105–123`,
   `resolveGuestAccessConfig` reads `accessControl.guest_access`). Add `invite_url` there and thread
   `config.access_control.guest_access?.invite_url`.
2. **"E2E baseline refresh."** The SCP frames the e2e work as "new login baselines (mobile × light/dark,
   desktop)". There are **no pixel screenshots** anywhere in `packages/web/tests` (grep for
   `toHaveScreenshot` returns nothing; the suite uses `toHaveCSS`/DOM assertions — see
   `tests/auth-guest.spec.ts`). So there is nothing to "refresh"; the real work is adding assertions for
   the invite row and enabling `inviteUrl` in the e2e server so the row renders.

The SCP is correct that the probe is `GET /api/auth/guest` (`fetchGuestAvailability` uses GET;
`loginAsGuest` uses POST on the same path — both handled by the same controller).

### Current state of the files this story touches (read before editing)

- `packages/shared/src/schemas/auth.ts:27–29` — `GuestAvailabilityResponseSchema = z.object({ enabled: z.literal(true) })`.
  The `z.literal(true)` is intentional (disabled = 404, never `{ enabled: false }`); PRESERVE it, only add
  the optional `inviteUrl`. Web imports it from `@share2brain/shared/schemas` (never the root barrel — pulls
  `pg` into the bundle, AD-3, ESLint-enforced).
- `packages/shared/src/config/index.ts:117–122` — `guest_access` is an optional object with `enabled`
  (required when present) + optional `role`/`username`/`session_ttl_minutes`, NO `.default()` anywhere.
  Add `invite_url` as optional. `z.string().url()` matches the existing URL-validation idiom used for
  `sentry_dsn`/`base_url`.
- `packages/backend/src/infrastructure/guestAccess.ts:24–46` — `ResolvedGuestAccess` +
  `resolveGuestAccessConfig` fill per-field defaults here (not in the schema, D4). `inviteUrl` gets NO
  default (a missing URL just hides the link).
- `packages/backend/src/main.ts:113–119, 130–158` — `guestAccess` local is built only when `guest.enabled`
  and spread into `createApp` options (`...(guestAccess ? { guestAccess } : {})`, L153) so the key is
  genuinely absent when off. The type is declared inline at L114 — widen it.
- `packages/backend/src/app.ts:121, 217` — `AppOptions.guestAccess?` type + it is forwarded whole to
  `createAuthController`. Widening the type is enough; verify the object is passed, not destructured.
- `packages/backend/src/presentation/controllers/authController.ts:37, 178–186` — `guestAvailability`
  currently emits `{ enabled: true }`. Presence of the `guestAccess` dep = enabled; the 404 branch (no
  dep) is the "disabled/hidden" signal and MUST stay byte-for-byte.
- `packages/backend/src/e2e/server.ts:80` — the harness enables guest access with a fixed `guestAccess`
  object; add `inviteUrl` so the e2e login renders the row. `e2e-role-guest` maps to `e2e-ch-general` only
  (RBAC seed) — irrelevant to this story but do not touch it.
- `packages/web/src/api/auth.ts:42–46` — `fetchGuestAvailability(): Promise<boolean>` today. Widening the
  return is the one behavioral change on the client; the only caller is `LoginScreen`'s `useEffect`.
- `packages/web/src/components/LoginScreen.tsx:58–75, 167–217` — the probe runs inside the component
  (views own their data-fetching); `showGuest` defaults false so the link never flashes. The invite row
  goes inside the existing `{showGuest && …}` fragment, gated additionally on `inviteUrl`.
- `packages/web/src/components/icons.tsx:12–19` — `DiscordIcon` hardcodes `fill="currentColor"`. Add a
  `color` prop (default `currentColor`) so the login button (white) is unaffected while the invite row can
  request `#5865F2`. The shared `IconProps` interface (L7–10) has only `size`; extend just for this icon.
- `packages/web/src/styles/components.css:32–44` — `.kh-guest-btn` uses `var(--accent-ink)` for its hover
  accent; the invite link reuses the same token. `--accent-ink` is a defined design token.
- `packages/web/src/locales/{es,en}.json` `login` block — existing keys: `tagline`, `description`,
  `continueWithDiscord`, `membersOnly`, `orForDemo`, `guestLogin`. Add `noAccess` + `joinDemoServer`.

### Architecture & standards constraints

- **AD-6 (contracts in shared):** the API shape change is a Zod edit in `packages/shared/src/schemas/`;
  the config shape change is Zod in `packages/shared/src/config/`. No local shapes. Web infers via
  `z.infer<>` / parses with the shared schema. [Source: docs/context/ARCHITECTURE-SPINE.md; project-context.md §Contracts]
- **Secrets/behavior split:** the invite URL is behavior → `Share2Brain.config.yml`, never `.env`. The
  example file gets a placeholder invite, not the real code. [Source: CLAUDE.md §Non-negotiables]
- **AD-3 (static SPA):** no server code in web; the link is a plain `<a target="_blank" rel="noopener">`.
  `rel="noopener"` is required on `target="_blank"` (tab-nabbing) — matches the prototype.
- **Language rule:** all identifiers/comments/tests/commits in English; user-facing copy is i18n-driven
  (es/en), never literal in TSX. [Source: project-context.md §Code quality; Epic 10]
- **One story, inner-layers-first:** shared → backend → web client → component → styles/locales → tests.
  [Source: project-context.md §Development workflow]

### Testing standards

- Vitest, co-located `*.test.ts(x)`, AAA, behavior-driven names (`should <behavior> when <condition>`).
- Backend unit doubles pattern is established in `authController.guest.test.ts` (fake req/res, no DB/Redis).
- Web has Vitest component tests (`App.test.tsx`, `SearchView.test.tsx`, `DocsView.test.tsx`, …) — a
  `LoginScreen.test.tsx` is consistent with the package. Mock `fetch` for the auth-client test and mock
  `../api/auth` for the component test.
- E2E (Playwright) lives in `packages/web/tests/`; guest access is enabled only in the e2e harness. The
  guest specs are ordering-sensitive and non-mutating — `auth-guest.spec.ts` is the right home for a
  read-only invite-row assertion (adding a URL assertion mutates nothing).

### Project Structure Notes

- All paths align with the monorepo layout (`packages/<service>/src/`). No new files except the two web
  test files (`src/api/auth.test.ts`, `src/components/LoginScreen.test.tsx`). No new endpoint, no schema
  table, no migration. Fully additive and backward compatible.
- No conflicts detected. The only cross-layer type-widening chain is
  `guestAccess` (main → app → controller); miss one link and TypeScript `strict` fails the build (that is
  the safety net).

### References

- [Source: _bmad-output/planning-artifacts/sprint-change-proposal-2026-07-15-login-demo-invite.md] — the approved design (note the two corrections above).
- [Source: packages/shared/src/schemas/auth.ts#GuestAvailabilityResponseSchema]
- [Source: packages/shared/src/config/index.ts#Share2BrainConfigSchema (access_control.guest_access)]
- [Source: packages/backend/src/infrastructure/guestAccess.ts#resolveGuestAccessConfig]
- [Source: packages/backend/src/presentation/controllers/authController.ts#guestAvailability]
- [Source: packages/web/src/api/auth.ts#fetchGuestAvailability]
- [Source: packages/web/src/components/LoginScreen.tsx (showGuest fragment)]
- [Source: packages/web/tests/auth-guest.spec.ts] — e2e pattern (assertion-based, no screenshots).
- [Source: docs/api-spec.yml#/api/auth/guest]
- [Source: _bmad-output/implementation-artifacts/2-5-acceso-de-invitado-para-demos.md] — the guest-access story this extends.

## Dev Agent Record

### Agent Model Used

claude-opus-4-8 (bmad-dev-story)

### Debug Log References

- Verification gate (branch `feat/2-6-login-demo-invite`):
  - `npm run lint` → clean (eslint, 0 errors).
  - `npm run test` → **1106 passed, 1 skipped** (108 files). First run surfaced 3 `App.test.tsx`
    failures because the widened `fetchGuestAvailability` return (`boolean` → `{ enabled, inviteUrl? }`)
    made the old `mockResolvedValue(true/false)` doubles resolve to a value the component destructures
    to `enabled: undefined`. Fixed the 5 mocks in `App.test.tsx` to the object shape; re-run green.
  - `npm run build` → clean (tsc `--noEmit` on shared/backend/bot/workers + `vite build` on web, 168 modules).
  - E2E: `DATABASE_URL=… REDIS_URL=redis://127.0.0.1:6379 npm run test:e2e -w @share2brain/web` →
    **38 passed** (chromium, 1 worker). `auth-guest.spec.ts:19` now asserts the invite row (visible,
    href `https://discord.gg/e2e-demo`, `target=_blank`, `rel=noopener`, `login.noAccess` copy,
    transparent base `border-bottom-color`). The `Share2Brain.config.yml` ENOENT log is a pre-existing,
    non-fatal harness warning (embedding-dims fallback to 1536), unrelated to this story.

### Completion Notes List

- **Inner-layers-first, fully additive.** shared (Zod contracts) → backend (resolve + thread + probe body)
  → web client (widen probe) → icon (colorable) → component (invite row) → styles/locales → tests. Every
  new field is optional; a deployment without `invite_url` renders exactly as Story 2.5 (verified by the
  "enabled without inviteUrl" component test + the untouched 404 branch).
- **Config path corrected per Dev Notes:** used `access_control.guest_access.invite_url` (NOT the SCP's
  `auth.guest_access` shorthand). `GuestAvailabilityResponseSchema` keeps `enabled: z.literal(true)`
  (disabled = 404, never `{ enabled: false }`); `inviteUrl` added as `z.string().url().optional()`.
- **Secrets/behavior split honored:** the real demo invite (`discord.gg/bf8TvtGnZd`) lives only in the
  local `Share2Brain.config.yml`; the `.example` and TECHNICAL-DESIGN §13 examples use a placeholder.
- **Type-widening chain (main → app → controller) done in lockstep** — TS `strict` build is the safety net
  and passed. Controller builds the 200 body via a conditional spread so `inviteUrl` is omitted (not
  `undefined`) when absent.
- **AD-3 intact:** the link is a plain `<a target="_blank" rel="noopener">`; `DiscordIcon` gained a local
  `color` prop (default `currentColor`) so the white Discord login button is unaffected.
- **i18n only:** `login.noAccess` + `login.joinDemoServer` added to both `es.json` and `en.json`
  (parity.test.ts passes); the TSX renders via `t(...)` with no literal strings.

### File List

**Docs / config**
- `docs/api-spec.yml` — GET /api/auth/guest 200 schema gains optional `inviteUrl` (uri).
- `Share2Brain.config.yml.example` — placeholder `invite_url` under `access_control.guest_access`.
- `Share2Brain.config.yml` — real demo `invite_url` (local operator config).
- `docs/context/TECHNICAL-DESIGN.md` — §13 config example gains the `invite_url` line (parity).

**packages/shared**
- `src/schemas/auth.ts` — `GuestAvailabilityResponseSchema.inviteUrl` optional URL + doc comment.
- `src/config/index.ts` — `guest_access.invite_url` optional URL (no `.default()`).

**packages/backend**
- `src/infrastructure/guestAccess.ts` — `ResolvedGuestAccess.inviteUrl?` + resolve `block?.invite_url`.
- `src/main.ts` — widen `guestAccess` local type + set `inviteUrl` when enabled.
- `src/app.ts` — widen `AppOptions.guestAccess?` type.
- `src/presentation/controllers/authController.ts` — widen dep type + emit `inviteUrl` in the 200 body.
- `src/e2e/server.ts` — harness `guestAccess.inviteUrl` so the e2e login renders the row.
- `src/presentation/controllers/authController.guest.test.ts` — probe inviteUrl present/absent + resolver cases.

**packages/web**
- `src/api/auth.ts` — `fetchGuestAvailability()` returns `{ enabled, inviteUrl? }`.
- `src/components/icons.tsx` — `DiscordIcon` accepts optional `color`.
- `src/components/LoginScreen.tsx` — `inviteUrl` state + invite row inside the guest fragment.
- `src/styles/components.css` — `.kh-demo-invite-link` (+ `:hover`).
- `src/locales/es.json`, `src/locales/en.json` — `login.noAccess` + `login.joinDemoServer`.
- `src/api/auth.test.ts` — **new**: probe return-shape unit tests.
- `src/components/LoginScreen.test.tsx` — **new**: invite-row component tests.
- `src/App.test.tsx` — fix 5 `fetchGuestAvailability` mocks to the new return shape.
- `tests/auth-guest.spec.ts` — extend the login-screen e2e test with invite-row assertions.

## Change Log

| Date | Change |
|---|---|
| 2026-07-15 | Implemented Story 2.6 — config-driven demo Discord invite link on the login screen. Additive, backward-compatible (optional `inviteUrl` end-to-end). Verification gate green (lint 0 / 1106 unit+web / build 5 pkgs / 38 e2e). Status → review. |
| 2026-07-15 | bmad-code-review (3 layers @ Opus 4.8): all 7 ACs SATISFIED. 2 patches applied to `packages/shared` — (1) blank `invite_url: ""` coerces to undefined (no boot abort); (2) `invite_url`/`inviteUrl` scheme pinned to http(s) via canonical `isHttpUrl` (rejects `javascript:`/`data:`), replacing deprecated `z.string().url()`. +5 tests (2 auth schema, 3 config). Re-gate green (lint 0 / 1111 unit+web / build 5 pkgs). Status → done. |
