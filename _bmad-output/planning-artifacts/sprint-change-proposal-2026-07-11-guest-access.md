# Sprint Change Proposal — Guest Access for Demos

- **Date:** 2026-07-11
- **Author:** Borja (via BMAD Correct Course)
- **Mode:** Incremental
- **Scope classification:** Moderate (PO/DEV handoff)
- **MVP affected:** No

---

## 1. Issue Summary

**Problem statement.** The application's only entry path is Discord OAuth2 (Story 2.3). For an upcoming demo, we need a **guest access** on the login screen that lets a presenter enter the app **without Discord credentials**, while keeping RBAC and production security intact.

**Discovery / context.** New requirement emerged from a stakeholder need (product demo). Epic 2 (Auth & App Shell) is already implemented; this is an **additive** change, not a rework.

**Evidence.** The login design has already been updated with the guest link (`docs/context/design/Share2Brain Web.dc.html`, modified in the working tree).

**Key tension.** The architecture carries an explicit principle (ARCHITECTURE-SPINE.md, E2E harness note): *"never an auth-bypass route in production."* Guest access must be designed so it is **not** a bypass — it creates a real, RBAC-limited session and is **disabled by default**.

---

## 2. Impact Analysis

### Epic Impact
- **Epic 2 (Auth & App Shell):** completed as originally planned; guest access is additive → **one new story (Historia 2.5)**, no epic rework.
- **Epics 3–9:** **no impact.** Search, documents, chat and stats already enforce `req.allowedChannelIds`, so a guest inherits RBAC scoping automatically once assigned a role.

### Story Impact
- **New:** Historia 2.5 — Guest access (config-gated).
- **No changes** required to any existing story's implementation; the guest role reuses the existing per-request RBAC expansion (Story 2.4).

### Artifact Conflicts
| Artifact | Change |
|---|---|
| `ARCHITECTURE-SPINE.md` | AD-10 (session may carry `isGuest`), AD-12 (synthetic guest role expansion), and a clarifying note on the "never auth-bypass in production" principle. |
| `TECHNICAL-DESIGN.md` | New "Guest access (demo)" subsection + guest login sequence + startup seed of the guest `users` row. |
| `Share2Brain.config.yml` | New `access_control.guest_access` block (OFF by default). |
| `packages/shared/src/db/schema.ts` | **No schema change** — sentinel `discord_id="guest"` satisfies constraints; add a startup **seed** of the guest `users` row (gated by the flag). |
| `docs/api-spec.yml` + `packages/shared/src/schemas/` | New `POST /api/auth/guest`; `GET /api/auth/me` gains optional `isGuest`. |
| `packages/backend` (auth middleware) | `/api/auth/guest` exempt from 401 (already true for all `/api/auth/*`). |
| `packages/web` | Login guest link → guest endpoint; visible "Guest mode" indicator; logout → "Exit". |

### Technical Impact
- **AD-10 (sessions in Redis):** guest session shape `{ userId, discordRoles: [guestRole], isGuest: true }` with a short TTL. No `sessions` table (invariant preserved).
- **AD-12 (RBAC inside the vector query):** unchanged. Guest gets a synthetic role expanded against `channel_permissions`; if no channel lists that role, `allowedChannelIds = []` (deny policy).
- **Data model:** `conversations.user_id` FK is satisfied by a seeded guest `users` row, so guest chat (RAG) persists conversations normally.
- **Production safety:** `guest_access.enabled: false` by default; `POST /api/auth/guest` returns 404 `GUEST_ACCESS_DISABLED` when off, and the login link is hidden.

---

## 3. Recommended Approach

**Option 1 — Direct Adjustment (SELECTED).** Add one new story (Historia 2.5) within the existing Epic 2 structure, plus contract/config/doc updates.

- **Effort:** Medium
- **Risk:** Medium (touches auth invariants → must not weaken production security)
- **Timeline impact:** Low — no rework of completed epics; a single self-contained story.

**Alternatives considered:**
- *Option 2 — Rollback:* Not applicable; nothing completed needs reverting.
- *Option 3 — MVP Review:* Not needed; MVP scope (Discord auth + RBAC) is unchanged. Guest access is an optional, demo-oriented, config-gated feature.

**Design decisions (confirmed with user):**
1. **Dedicated guest role** — synthetic `guest` role mapped in `channel_permissions` to demo channels only (RBAC preserved).
2. **Full access incl. chat** — seed a guest `users` row (fixed UUID, `discord_id="guest"`) to satisfy the `conversations.user_id` FK.
3. **Flag OFF by default** — `guest_access.enabled: false`; route 404s when disabled (honors "never auth-bypass in production").

---

## 4. Detailed Change Proposals

### 4.1 — Stories

**New Historia 2.5 in `epics.md`** (inserted after Historia 2.4, before `## Épico 3`):

```markdown
### Historia 2.5: Acceso de invitado para demos (config-gated)

Como Operador que presenta una demo,
quiero un acceso de invitado en la pantalla de login que no requiera Discord,
para mostrar la aplicación sin credenciales, manteniendo RBAC y la seguridad de producción.

**Criterios de Aceptación:**

**Dado** `config.access_control.guest_access.enabled: false` (valor por defecto)
**Cuando** se llama `POST /api/auth/guest`
**Entonces** retorna HTTP 404 `{ error: "Not found", code: "GUEST_ACCESS_DISABLED" }`
**Y** la pantalla de login NO muestra el enlace de invitado

**Dado** `config.access_control.guest_access.enabled: true`
**Cuando** el Backend arranca
**Entonces** hace upsert de una fila `users` de invitado (discord_id sentinela `"guest"`, username configurable) ANTES de aceptar requests
**Y** el rol sintético `guest_access.role` está disponible para la expansión RBAC

**Dado** `guest_access.enabled: true`
**Cuando** se llama `POST /api/auth/guest`
**Entonces** crea una sesión Redis `{ userId: <guestUserId>, discordRoles: [config.guest_access.role], isGuest: true }` con TTL `guest_access.session_ttl_minutes`
**Y** establece cookie httpOnly `sid` y retorna HTTP 200

**Dado** una sesión de invitado válida
**Cuando** el middleware RBAC expande roles
**Entonces** une `[guestRole]` contra `channel_permissions` → `allowedChannelIds` = solo canales demo
**Y** toda query vectorial (search/chat/documents/stats) queda acotada a esos canales (AD-12 intacto)

**Dado** una sesión de invitado
**Cuando** la web app llama `GET /api/auth/me`
**Entonces** retorna el usuario invitado con `isGuest: true`
**Y** la UI muestra un indicador visible de "Modo invitado" y el botón de logout dice "Salir"

**Dado** que el usuario hace clic en el enlace de invitado del login
**Cuando** `POST /api/auth/guest` completa
**Entonces** la app renderiza el layout autenticado en modo invitado
```

### 4.2 — PRD

No functional PRD change required. Optional: add a one-line note in the non-functional / demo section that guest access is an **operator-enabled, RBAC-limited, demo-only** capability, off by default.

### 4.3 — Architecture (`ARCHITECTURE-SPINE.md`)

- **AD-10:** add — *"La sesión puede incluir un flag opcional `isGuest: true` para sesiones de invitado creadas vía `POST /api/auth/guest` (Historia 2.5). El resto de la forma (`{ userId, discordRoles }`) es idéntica; sigue siendo una sesión Redis real con TTL."*
- **AD-12:** add — *"El acceso de invitado NO es una excepción de RBAC: recibe un rol sintético (`guest_access.role`) expandido contra `channel_permissions` como cualquier otro rol. Sin canal que lo liste, `allowedChannelIds = []` (deny)."*
- **Anti-bypass note (E2E harness paragraph):** add — *"El acceso de invitado (Historia 2.5) no contradice este principio: no omite autenticación ni middleware — crea una sesión real, limitada por RBAC, y está OFF por defecto. `POST /api/auth/guest` responde 404 cuando el flag está desactivado."*

### 4.4 — Technical Design (`TECHNICAL-DESIGN.md`)

- New **"Acceso de invitado (demo)"** subsection in the auth section: endpoint, user seed, flow, and gating.
- Extend the login sequence with the guest variant (login → `POST /api/auth/guest` → Redis session with `isGuest` → RBAC via `guest` role).
- Document the startup seed of the guest `users` row alongside the `channel_permissions` upsert, conditioned on `guest_access.enabled`.

### 4.5 — Config (`Share2Brain.config.yml`)

```yaml
access_control:
  enabled: true
  default_policy: "deny"
  role_cache_ttl: 300
  # NEW — guest access for demos. OFF by default (never auth-bypass in prod).
  guest_access:
    enabled: false            # operator sets true only for the demo
    role: "guest"             # synthetic role; add it to allowed_roles of demo channels
    username: "Invitado"      # display name in the UI
    session_ttl_minutes: 120  # short-lived demo session
  channel_permissions:
    - channel_id: "1498305410942369908"
      name: "general"
      allowed_roles: ["1498305407159107735", "1498308214410969286", "guest"]  # + guest for demo
    - channel_id: "1498779601030086707"
      name: "modelos"
      allowed_roles: ["1498305407159107735", "1498308214410969286"]
```

### 4.6 — Data model (`schema.ts` + `docs/data-model.md`)

- **No schema change.** `users.discord_id` (NOT NULL, unique) accepts sentinel `"guest"`; `conversations.user_id` FK satisfied by the seeded row.
- Backend startup **seed**: upsert the guest `users` row with a fixed UUID, only when `guest_access.enabled`. Document in `docs/data-model.md`.

### 4.7 — API + Contracts (`docs/api-spec.yml`, `packages/shared/src/schemas/`)

- New `POST /api/auth/guest` — 200 (set-cookie `sid`); 404 `GUEST_ACCESS_DISABLED` when disabled.
- `GET /api/auth/me` response gains optional `isGuest: boolean` (default false).
- Auth middleware: `/api/auth/guest` exempt from the 401 gate (already covered by `/api/auth/*`).

### 4.8 — Web (`packages/web`)

- Login screen: "Entrar como invitado" link (already in design) → `POST /api/auth/guest` → reload authenticated layout. Hide the link when guest access is disabled.
- Visible **"Modo invitado"** indicator (header/badge); logout button → "Salir".
- Consume `isGuest` via `z.infer<>` of the shared schema — no locally redefined types.

---

## 5. Implementation Handoff

**Scope: Moderate → Product Owner / Developer.**

**Backlog action (PO):**
- Add Historia 2.5 to `epics.md` (Epic 2) and to `sprint-status.yaml` with status `backlog`.

**Implementation action (DEV — `bmad-dev-story`, one story):**
Build inner-first per project convention: `shared` (Zod session/auth schemas + config schema for `guest_access`) → backend (guest endpoint, user seed, RBAC role wiring) → api-spec → web (login link + guest-mode UI). Update `docs/context/` docs (AD-10, AD-12, TECHNICAL-DESIGN, data-model) before code, per "docs are the source of truth."

**Success criteria:**
- With `guest_access.enabled: false`: `POST /api/auth/guest` → 404; login link hidden.
- With `guest_access.enabled: true`: guest login creates an `isGuest` Redis session; guest sees only channels whose `allowed_roles` include `guest`; RBAC leaks nothing outside those channels (RBAC test); guest chat persists a conversation under the seeded guest user.
- Verification gate green: `npm run lint && npm run test && npm run build`, plus E2E exercising the guest login path.

**Non-negotiables preserved:** AD-2 (no cross-service imports), AD-5/AD-6 (schema & contracts only in `shared`), AD-10 (no `sessions` table), AD-12 (RBAC inside the vector query), "never auth-bypass in production" (flag OFF by default).
