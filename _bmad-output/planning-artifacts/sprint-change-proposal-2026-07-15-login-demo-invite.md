# Sprint Change Proposal — Login Demo Discord Invite Link

- **Date:** 2026-07-15
- **Author:** Borja (via `bmad-correct-course`)
- **Change mode:** Incremental
- **Classification:** **Moderate** (coordinated vertical slice: `shared` → `backend` → `web` + i18n + e2e; single story)
- **Status:** Approved — routed to `bmad-create-story`

---

## 1. Issue Summary

**Problem statement.** The updated design prototype `docs/context/design/Share2Brain Web.dc.html`
adds a new affordance to the login screen: below the "Entrar como invitado" (guest) button, a small
centered row with a Discord brand icon, the prompt "¿No tienes acceso?", and a link
"Únete al servidor Discord de demo" pointing at the demo server invite.

**How discovered.** Design-first change: Borja edited the `.dc.html` prototype directly (git working
tree modification on `docs/context/design/Share2Brain Web.dc.html`). The `docs/context/design/support.js`
diff in the same working tree is unrelated editor-runtime noise, **not** part of this change.

**Evidence (design delta).** New block, inserted after the guest button:

```html
<div style="margin-top:13px; display:flex; align-items:center; gap:6px; justify-content:center; font-size:12.5px; color:var(--tx4);">
  <svg width="14" height="14" viewBox="0 0 24 24" fill="#5865F2" ...><path d="…discord…"/></svg>
  <span>¿No tienes acceso?</span>
  <a href="https://discord.gg/bf8TvtGnZd" target="_blank" rel="noopener"
     style="color:var(--accent-ink); font-weight:600; text-decoration:none;
            border-bottom:1px solid transparent; transition:border-color .15s ease, opacity .15s ease;"
     style-hover="border-bottom-color:var(--accent-ink); opacity:0.8;">Únete al servidor Discord de demo</a>
</div>
```

**Look & feel to preserve.** Link is `color: var(--accent-ink)`, `font-weight: 600`, no underline, with
a transparent `border-bottom` that on **hover** becomes `border-bottom-color: var(--accent-ink)` and
`opacity: 0.8`, transition `.15s ease`. Discord icon is brand blurple (`#5865F2`) at 14px.

---

## 2. Impact Analysis

### Epic Impact
- **Epic 2 (Acceso y Autenticación)** — thematic home. This extends the demo/guest-access affordance
  established by Story 2.5. Added as a follow-up story (Epic 2 accepts appended stories, per precedent
  with Stories 9.4 / 9.5).
- **Epic 11 (Responsive & Refresh)** — **not** the home. Its goal is scoped to responsive layout +
  palette refresh; a new content affordance (a link) is out of that goal even though it also aligns
  `web` with the updated `.dc.html`.

### Story Impact
- **New Story 2.6** — the only new work unit. No existing story is reopened.
- **Story 2.5 (guest access)** — its GET `/api/auth/guest` probe is extended (additive, backward
  compatible: `inviteUrl` optional).
- **Story 11.5 (visual e2e harness)** — login baseline gains a row in the demo+invite variant; new
  baselines required.

### Artifact Conflicts
- `epics.md` — add Story 2.6 under Epic 2 (detailed section; the roadmap "Lista de Épicos" summary is
  not amended, per the established precedent note).
- `docs/api-spec.yml` — GET `/api/auth/guest` response gains optional `inviteUrl`.
- `Share2Brain.config.yml` + `Share2Brain.config.yml.example` — new optional `auth.guest_access.invite_url`.
- No PRD/UX-spec rewrite needed beyond the FR note below.

### Technical Impact
- **Architecture invariants:** AD-3 (static SPA) intact. AD-6 respected — the API shape change lives
  in `packages/shared` Zod (`GuestAvailabilityResponseSchema`); config schema change lives in
  `packages/shared` (`config/index.ts`). Secrets/behavior split respected: the invite URL is behavior,
  so it goes in `Share2Brain.config.yml`, never `.env`.
- **Self-hosted correctness:** the demo invite is deployment-specific; delivering it via config (not a
  hardcoded constant) prevents every self-hosted fork from pointing at Borja's demo server.
- **Delivery mechanism:** the existing `GET /api/auth/guest` probe carries both `enabled` and the
  optional `inviteUrl` — one round-trip, no new endpoint. The link renders only when
  `enabled && inviteUrl` (demo active AND URL configured).
- **i18n (Epic 10):** two new keys required; literal text is not permitted.

---

## 3. Recommended Approach

**Direct Adjustment** — add one new story (2.6) within the existing plan. No rollback, no MVP change.

- **Rationale:** small, well-understood, additive vertical slice with a clear design reference. Backward
  compatible (all new fields optional). No invariant is bent.
- **Effort estimate:** ~half a day (1 story). Layers: `shared` (2 tiny schema edits) → `backend`
  (1 handler + wiring) → `web` (client + component + icon + CSS + locales) → tests + e2e baselines.
- **Risk:** low. Main risk is the e2e baseline refresh (Story 11.5 harness) — mechanical.
- **Timeline impact:** negligible; fits between epics.
- **URL source & visibility decisions (approved by Borja, 2026-07-15):**
  - URL source → **config, via the guest endpoint** (`auth.guest_access.invite_url`).
  - Visibility → **only when demo/guest is active** (inside the `showGuest` block), and only when a URL
    is configured.

---

## 4. Detailed Change Proposals

### Config
- **`Share2Brain.config.yml`** and **`Share2Brain.config.yml.example`** — under `auth.guest_access`:
  ```yaml
  invite_url: "https://discord.gg/bf8TvtGnZd"   # optional — demo server invite shown on the login screen
  ```

### `packages/shared`
- **`src/config/index.ts`** — `guest_access` object gains `invite_url: z.string().url().optional()`.
- **`src/schemas/auth.ts`** — `GuestAvailabilityResponseSchema` gains `inviteUrl: z.string().url().optional()`:
  ```ts
  export const GuestAvailabilityResponseSchema = z.object({
    enabled: z.literal(true),
    inviteUrl: z.string().url().optional(),
  });
  ```

### `packages/backend`
- **`src/presentation/controllers/authController.ts`**
  - Dep: `guestAccess?: { role: string; sessionTtlMinutes: number; userId: string; inviteUrl?: string }`.
  - `guestAvailability` handler:
    ```ts
    res.status(200).json(GuestAvailabilityResponseSchema.parse({
      enabled: true,
      ...(guestAccess.inviteUrl ? { inviteUrl: guestAccess.inviteUrl } : {}),
    }));
    ```
- **Wiring** (`main.ts` / `app.ts` / `e2e/server.ts`): thread
  `inviteUrl: config.auth.guest_access?.invite_url` into the `guestAccess` dep.

### `packages/web`
- **`src/api/auth.ts`** — `fetchGuestAvailability()` returns `{ enabled: boolean; inviteUrl?: string }`
  (any non-200 ⇒ `{ enabled: false }`). Callers in `LoginScreen` adapt the `showGuest` state and read
  `inviteUrl`.
- **`src/components/LoginScreen.tsx`** — inside the `{showGuest && …}` fragment, after the guest button,
  render the invite row **only when `inviteUrl` is set**. Brand Discord icon + i18n copy +
  `<a href={inviteUrl} target="_blank" rel="noopener" className="kh-demo-invite-link">`.
- **`src/components/icons.tsx`** — `DiscordIcon` accepts `color?: string` (default `currentColor`) for
  the `#5865F2` tint at 14px.
- **`src/styles/components.css`**
  ```css
  .kh-demo-invite-link { border-bottom: 1px solid transparent; transition: border-color .15s ease, opacity .15s ease; }
  .kh-demo-invite-link:hover { border-bottom-color: var(--accent-ink); opacity: .8; }
  ```
- **`src/locales/es.json` / `src/locales/en.json`** — under `login`:
  | key | es | en |
  |---|---|---|
  | `noAccess` | ¿No tienes acceso? | No access? |
  | `joinDemoServer` | Únete al servidor Discord de demo | Join the demo Discord server |

### Tests & e2e
- `authController` unit test: `inviteUrl` passthrough when configured; omitted when absent.
- `packages/web` `auth.ts` client test: parses `{ enabled, inviteUrl }`; degrades to `{ enabled:false }` on non-200.
- `LoginScreen` test: link renders only when `showGuest && inviteUrl`; correct `href`/`target`/`rel`.
- **Story 11.5 visual harness:** new login baselines for the demo+invite variant (mobile × light/dark, desktop).

### Docs
- `epics.md` — append Story 2.6 to Epic 2 (detailed section only).
- `docs/api-spec.yml` — GET `/api/auth/guest` response: optional `inviteUrl` (string, uri).

---

## 5. Implementation Handoff

- **Scope classification:** **Moderate** (multi-layer, backward-compatible; single story).
- **Recipient:** `bmad-create-story` → author **Story 2.6 · web/backend — Enlace de invitación al
  Discord de demo en el login** (Epic 2), then `bmad-dev-story` for implementation, then
  `bmad-code-review` → `bmad-checkpoint-preview`.
- **FR note:** no new FR; extends the existing guest-access requirement. (If the team prefers explicit
  tracking, mint FR28 at story-creation time — optional.)

### Success criteria
1. With `guest_access.enabled: true` **and** `invite_url` set, the login screen shows the invite row
   with the exact hover behavior from the prototype (`border-bottom` in `--accent-ink` + `opacity .8`).
2. With `invite_url` **absent** (or guest access off), no invite row renders and no regression to the
   Discord/guest paths.
3. Copy is i18n-driven (es/en); no literal strings.
4. `npm run lint && npm run test && npm run build` green; e2e visual suite green with refreshed login
   baselines.
5. Invariants intact: AD-3 (static SPA), AD-6 (contracts/schema only in `shared`), secrets/behavior split.

---

_Approved by Borja on 2026-07-15. Next step: `bmad-create-story` for Story 2.6._
