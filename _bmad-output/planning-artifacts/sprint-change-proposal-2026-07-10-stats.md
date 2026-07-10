# Sprint Change Proposal — 2026-07-10 (Statistics)

**Project:** hivly · **Author:** Borja · **Workflow:** `bmad-correct-course` · **Mode:** Incremental
**Classification:** Moderate (additive; new PRD FRs + new endpoints + one index migration; **no AD-* invariant broken**)

> Second change of the 2026-07-10 session. The first (Epic 8 · DocsView read/unread redesign) is in
> `sprint-change-proposal-2026-07-10.md`. This one is independent.

---

## Section 1 — Issue Summary

**Requirement.** Add a **Statistics** section (3rd nav item) as specified in the updated design
`docs/context/design/KeepHive Web.dc.html` (`isStats` screen): community knowledge analytics.

**Type.** New requirement emerged (stakeholder / design iteration) — not covered by the closed
roadmap (Epics 1–7).

**Design breakdown (the `isStats` screen):**
- **4 KPI cards** — label + icon + large value + subtitle (data-driven).
- **Actividad de indexado** — 14-day bar chart of messages/resources indexed per day.
- **Mensajes por canal** — horizontal bars per channel with counts.
- **Cobertura de lectura** — donut of read % (read / total).

**Evidence.** Design `isStats` block; `api-spec.yml` has **no** stats/metrics/analytics endpoint
(only `read-status`) → greenfield. Underlying data already exists (`embeddings.indexed_at`,
`channel_id`, `user_read_status`) → **no new ingestion required**.

---

## Section 2 — Impact Analysis

### Epic Impact
- No existing epic touched. Requires a **new Épico 9: Estadísticas del Conocimiento (Analytics)**.
- Cross-epic reuse (dependencies, not changes): RBAC expansion (`req.allowedChannelIds`, Epic 2/4),
  `embeddings` (Epic 3/7), `user_read_status` (Epic 4).

### Artifact Conflicts / Additions
| Artifact | Change | Detail |
|---|---|---|
| **PRD** | ➕ Add | New FRs (FR22+) for knowledge analytics/observability. No existing FR conflicts. |
| **api-spec.yml** | ➕ Add | New `GET /api/stats` (RBAC-protected) returning KPIs + activity + channels + coverage. |
| **data-model.md + schema.ts** | ➕ Add | New index for the timeseries (`indexed_at`); **no new table** (aggregations over existing). |
| **Architecture (AD-12)** | ✅ Upholds | Aggregations filter by `allowedChannelIds` **inside the SQL** — see §3. |
| **UX / design** | ✅ Source | `KeepHive Web.dc.html` `isStats` is authoritative; nav gains a 3rd item. |
| **Other AD-***| None | AD-3 SPA preserved (client fetch); AD-6 contracts in shared; AD-5 DDL only in shared. |

### 🚩 Critical design constraint — AD-12 (RBAC inside the query)
Every aggregation (KPI counts, 14-day activity, per-channel bars, read coverage) **must carry
`WHERE channel_id = ANY(:allowedChannelIds)`** in its SQL, exactly like search/documents. A global
count would leak the existence and message volume of private channels a user cannot see.
**Ratified: RBAC-scoped** (Borja, 2026-07-10). The stats endpoint runs behind the existing RBAC
middleware and consumes `req.allowedChannelIds` (`packages/backend/src/middleware/rbac.ts`,
`rbac.expandAllowedChannelIds`). Read coverage additionally scopes to the session user's
`user_read_status`.

---

## Section 3 — Recommended Approach

**Direct Adjustment** — new Épico 9 with 3 stories, inner→outer layering (shared → backend → web → e2e).

- **9.1 · shared + backend:** `StatsResponse` Zod contract + RBAC-scoped `GET /api/stats`
  aggregation endpoint + timeseries index migration.
- **9.2 · web:** `StatsView` + 3rd nav item, consuming `StatsResponse` via `z.infer` (zero chart
  dep — design uses plain flex/grid bars + CSS-gradient donut).
- **9.3 · e2e:** extend the Playwright visual harness (Epic 4/7 pattern) to the stats view.

- **Effort:** moderate (one new endpoint + queries + one view + harness).
- **Risk:** low–medium. Main risks: (a) AD-12 leak if a query forgets the filter → mitigated by an
  RBAC integration test asserting counts exclude out-of-scope channels (mirrors `rbac.integration.test.ts`);
  (b) timeseries query performance → mitigated by the new index.
- **Sequence:** implement **after Story 8.1** (one story at a time).

---

## Section 4 — Detailed Change Proposals

### 4.1 PRD — add FRs (FR22+)
- **FR22:** The web app SHALL present a Statistics view with knowledge KPIs, indexing activity over
  time, per-channel volume, and personal read coverage.
- **FR23:** All statistics SHALL be scoped to the requesting user's accessible channels (AD-12); no
  metric exposes data from channels the user cannot read.

### 4.2 api-spec.yml — new endpoint
```yaml
GET /api/stats            # RBAC-protected (session + allowedChannelIds)
  200: StatsResponse:
    kpis: [{ key, label, value, sub }]           # 4 cards
    activity: [{ date, count }]                   # last 14 days, scoped
    channels: [{ channelId, channelName, count }] # scoped, desc by count
    coverage: { readCount, totalCount, readPct }  # session user, scoped
```

### 4.3 Épico 9 — stories & Acceptance Criteria (Gherkin)

**Historia 9.1 · shared + backend — contrato + endpoint de agregación RBAC-scoped**
```gherkin
AC1  Given contracts, Then StatsResponse Zod schema lives in packages/shared/src/schemas/stats.ts
     And GET /api/stats validates its output with .parse() at the edge.
AC2  Given an authenticated request, Then GET /api/stats runs behind the RBAC middleware
     And every aggregation query carries WHERE channel_id = ANY(:allowedChannelIds) (AD-12).
AC3  Given a user without access to channel X, Then no KPI/activity/channel/coverage figure
     includes rows from channel X (RBAC integration test asserts exclusion).
AC4  Given the activity series, Then it returns exactly the last 14 days (date + count), zero-filled,
     backed by a new index on embeddings(indexed_at) [or composite (channel_id, indexed_at)].
AC5  Given coverage, Then readCount/totalCount/readPct reflect the session user's user_read_status
     over the scoped embeddings only.
AC6  Gate: lint + unit + integration (real Postgres) + build green; migration generated & applied.
```

**Historia 9.2 · web — StatsView + 3ª entrada de nav**
```gherkin
AC1  Given the sidebar, Then a 3rd nav item "Estadísticas" appears and routes to StatsView
     (no router — same AppLayout branch pattern as Búsqueda/Documentos, UX-DR5).
AC2  Given StatsView, Then it renders 4 KPI cards, the 14-day activity bar chart, per-channel bars,
     and the read-coverage donut per KeepHive Web.dc.html (isStats).
AC3  Given types, Then all shapes come from z.infer<StatsResponse> — no shape redefined in web (AD-6).
AC4  Given rendering, Then bars/donut use plain flex/grid + CSS gradients (no new chart dependency).
AC5  Given theme, Then the view is correct in light and dark.
AC6  Gate: lint + web unit + build green.
```

**Historia 9.3 · e2e — extender harness visual**
```gherkin
AC1  Given the Playwright harness (Epic 4/7 pattern), Then a stats.spec.ts drives the seeded
     stats view (fake-OAuth) and asserts KPI values, activity bars, channel bars, coverage donut.
AC2  Given the seed, Then stats figures are deterministic and RBAC-consistent with the seeded
     channels; a screenshot is captured.
AC3  Gate: e2e chromium green.
```

### 4.4 KPI definitions (RATIFIED 2026-07-10)
The 4 cards are **Recursos indexados · Canales · Autores · Tus consultas al agente**:
- **Recursos indexados** — `count(embeddings)`, scoped to `allowedChannelIds` (AD-12).
- **Canales** — `distinct channel_id`, scoped.
- **Autores** — `distinct author`, scoped (participation).
- **Tus consultas al agente** — count of role=`user` messages across the session user's own
  `conversations`/`messages` (Epic 5). **Per-user metric**, no `channel_id` → the channel filter
  does not apply and there is no leak. Aligns with the design's "cuánto se consulta al agente"
  while keeping RBAC honest.

Read coverage is covered by the **donut**, not duplicated as a KPI.

---

## Section 5 — Implementation Handoff

- **Scope:** **Moderate** — artifact edits (PRD, api-spec, data-model, epics, sprint-status) then
  per-story implementation.
- **Recipients & order:**
  1. Apply artifact edits: epics.md (Épico 9 + 9.1–9.3) + sprint-status.yaml now; PRD/api-spec/
     data-model at story-creation time (or now — Borja's call).
  2. Finish **Story 8.1** first (one story at a time).
  3. `bmad-create-story` 9.1 → `bmad-dev-story` (branch `feat/9-1-stats-endpoint`) →
     `bmad-code-review` → `bmad-checkpoint-preview`; repeat 9.2, 9.3.
- **Success criteria:** Statistics view matches the design; every figure RBAC-scoped (AD-12) with an
  integration test proving exclusion; no new chart dependency; lint+test+build+e2e green.
