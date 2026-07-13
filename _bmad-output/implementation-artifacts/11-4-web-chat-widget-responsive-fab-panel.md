---
baseline_commit: ab0b527c9d892a849ec19f2b4e9f98f994b5280b
---

# Story 11.4: web — Chat widget responsive (FAB + panel)

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **user of the Share2Brain web SPA on a phone or narrow window**,
I want **the floating chat widget to reposition on mobile — the FAB lifted above the fixed bottom navigation bar instead of sitting on top of it, and the open panel constrained to the viewport (never wider than the screen, never taller than it)**,
so that **I can open and use the chat agent on a phone without the FAB overlapping the bottom-nav and without the panel bleeding off-screen (today the FAB is hard-pinned at `bottom:24` / `right:24` on every viewport, so on mobile it lands directly on the 62px bottom-nav)**.

## Story Context

**Fourth story in Épico 11 (Responsive & Visual Refresh)**, binding sequence `11.1 (done) → 11.2 (done) → 11.3 (done) ∥ **11.4** → 11.5`. It makes the **floating chat widget** responsive on top of the shell that 11.2 delivered. 11.2 built the `useIsMobile` hook + the `AppLayout` sidebar↔bottom-nav switch + `Header` collapse, and **explicitly deferred the chat FAB reposition to this story** (App.tsx:46-47 carries the verbatim note: *"NOT passed to ChatWidget — the chat FAB reposition is Story 11.4"*). This story consumes the same `isMobile` boolean, drilling it one level to a NEW consumer — `App → ChatWidget` — mirroring exactly how 11.3 drilled it into the three content views.

**This story CLOSES the 11.2 interim gap for chat.** A code-review defer was filed against 11.2 pointing here: on mobile the FAB (`bottom:24`) sits on top of the 62px fixed bottom-nav. Lifting the FAB to `bottom:78` (clears the 62px bar + a 16px gap) is the primary deliverable, and repositioning `right` to `16` on mobile matches the tighter mobile gutter.

**Scope boundary (read this — it decides what you do NOT touch):**
- **11.4 (this story):** drill `isMobile` into `ChatWidget`; compute `chatBottom` / `chatRight` off `isMobile` and apply them to BOTH the closed-state FAB button and the open-state panel `div`; verify the panel's existing viewport constraints (`maxWidth: calc(100vw - 32px)`, `maxHeight: calc(100vh - 48px)`) and `kh-pop` animation already match the design and need no change.
- **11.3 (DONE, do NOT re-touch):** the three content views (`SearchView`/`DocsView`/`StatsView`) `contentPad` + DocsView table. Leave them. This story does not touch any view.
- **11.5 (NOT here):** the mobile + light-theme E2E harness and new baselines. This story adds **no** new E2E specs and creates **no** new baselines; the existing desktop-dark harness must stay green with **zero baseline churn**.
- **Shell (11.2, DONE — do NOT re-touch):** `AppLayout`, `Header`, `BottomNav`, `useIsMobile`, `App.tsx`'s single `const isMobile = useIsMobile()`. You only ADD the one `isMobile={isMobile}` prop to the `<ChatWidget>` render call in `App.tsx` (and update the stale comment on App.tsx:46-47).
- **Chat behavior (Stories 5.3 + 5.4, DONE — do NOT re-touch):** all of ChatWidget's state, streaming, focus-trap, history overlay, composer, bubbles, citations. This story changes **only** four number literals (`bottom`/`right` on the FAB and on the panel) — nothing else in `ChatWidget.tsx` moves.

**The mechanism is copied verbatim from the design.** `docs/context/design/Share2Brain Web.dc.html` binds the FAB (L460) and the panel (L470) to `bottom:{{ chatBottom }}; right:{{ chatRight }}`, where `chatBottom: s.isMobile ? '78px' : '24px'` and `chatRight: s.isMobile ? '16px' : '24px'` (L1098-1099). The panel's `max-width:calc(100vw - 32px)` / `max-height:calc(100vh - 48px)` / `animation:kh-pop 0.2s ease both` (L470) are **static** in the design (not bound to `isMobile`) and are **already implemented verbatim** in `ChatWidget.tsx` (lines 487, 489, 498) from Story 5.3 — the "responsive panel" is inherited, not re-authored here. Your job is the FAB/panel *reposition* (four literals) + prop drilling, not a rebuild.

## Acceptance Criteria

```gherkin
AC1 — FAB repositions above the bottom-nav on mobile (primary deliverable)
  Given ChatWidget renders its closed-state FAB button (ChatWidget.tsx:387-439) with a hard-coded
        position: fixed; bottom: 24; right: 24
  When ChatWidget receives isMobile and renders the FAB
  Then on desktop (isMobile false) the FAB is bottom: 24, right: 24 (byte-identical to today)
   And on mobile (isMobile true) the FAB is bottom: 78, right: 16 — verbatim design (Web.dc.html L460 +
       L1098-1099): 78 clears the 62px fixed bottom-nav (BottomNav.tsx: height 62, bottom 0) plus a 16px
       gap, so the FAB no longer overlaps the bottom navigation bar (closes the 11.2 chat-FAB defer)
   And nothing else in the FAB style changes (z-index 60, width/height 60, the amber hexagon, the
       launcher dot) — only `bottom` and `right` are driven off isMobile.

AC2 — Panel repositions to match the FAB on mobile
  Given ChatWidget renders its open-state panel div (ChatWidget.tsx:443-499) with a hard-coded
        position: fixed; bottom: 24; right: 24
  When ChatWidget receives isMobile and the panel is open
  Then on desktop the panel is bottom: 24, right: 24 (byte-identical to today)
   And on mobile the panel is bottom: 78, right: 16 — the SAME chatBottom/chatRight values as the FAB
       (Web.dc.html L470), so the panel anchors to the same corner the FAB launched from
   And the panel's existing width: 404, maxWidth: 'calc(100vw - 32px)', height: 642,
       maxHeight: 'calc(100vh - 48px)', borderRadius 18, box-shadow, overflow:hidden and
       animation: 'kh-pop 0.2s ease both' are UNCHANGED — these already match the design (5.3) and are
       NOT recomputed off isMobile.

AC3 — isMobile is drilled App → ChatWidget (optional prop, desktop default)
  Given App.tsx already computes `const isMobile = useIsMobile()` (Story 11.2) and drills it to AppLayout
  When App.tsx renders <ChatWidget> (App.tsx:161, the floating sibling after <AppLayout>)
  Then it passes isMobile={isMobile} to <ChatWidget>
   And ChatWidget declares `isMobile?: boolean` defaulting to false (NOT a required prop), so every
       existing ChatWidget test — which renders `render(<ChatWidget user={USER} />)` without isMobile
       (the renderWidget() helper at ChatWidget.test.tsx:66) — stays green UNTOUCHED
   And ChatWidget does NOT call useIsMobile() itself; the single hook instance in App.tsx is the source
       of truth (mirrors 11.3's App → AppLayout → views drilling — one hook, prop-testable both ways)
   And the stale App.tsx comment (lines 46-47: "NOT passed to ChatWidget — the chat FAB reposition is
       Story 11.4") is updated to reflect that isMobile now IS passed to ChatWidget.

AC4 — Panel fits the viewport at 360px width and does not widen the body
  Given the panel open at 360px viewport width in BOTH themes (data-kh dark + light)
  When the panel renders
  Then its effective width is calc(100vw - 32px) ≈ 328px (the 404 fixed width is capped by the smaller
       maxWidth), so the panel sits inside the viewport with a 16px gutter each side and the body never
       scrolls horizontally
   And the FAB (mobile: right 16, width 60) and panel (mobile: right 16) both clear the right edge with
       no horizontal body scroll.

AC5 — No desktop regression; existing unit + e2e stay green UNTOUCHED
  Given the whole existing ChatWidget unit suite (ChatWidget.test.tsx) and the Playwright desktop chat
        harness (tests/chat.spec.ts) run WITHOUT stubbing matchMedia in test-setup.ts
  When they run after the change
  Then every existing assertion passes UNCHANGED, because jsdom has no window.matchMedia → useIsMobile
       returns false → isMobile flows as false → ChatWidget renders the FAB and panel at bottom:24/right:24
       exactly as today
   And the Playwright 'chromium' project uses devices['Desktop Chrome'] (1280px > 760px) so the existing
       e2e run desktop and every chat baseline snapshot is byte-identical (zero churn)
   And any new/changed unit test is limited to focused responsive assertions in ChatWidget.test.tsx
       (FAB + panel bottom/right differ mobile vs desktop); no existing assertion is edited.

AC6 — Verification gate green; frontend-only; invariants intact
  Given the mandatory gate
  When "npm run lint && npm run test && npm run build" runs (agent runs it, pastes output)
  Then all pass with no red, and the E2E desktop harness passes with zero baseline churn
   And the diff touches packages/web ONLY (ChatWidget.tsx, ChatWidget.test.tsx, App.tsx) — zero change to
       shared, backend, workers, bot, the Drizzle schema, any Zod contract, or any API/SSE shape
       (AD-3 + AD-6 intact)
   And NO new runtime dependency is added, and no @media layout breakpoint is introduced (layout stays
       JS-driven via the existing useIsMobile hook — consistent with 11.2/11.3 and the design), and no new
       @keyframes is added (kh-pop already exists in global.css:51).
```

## Tasks / Subtasks

- [x] **Task 1 — Drill `isMobile` from `App` into `ChatWidget` (AC3)**
  - [x] In `App.tsx`, add `isMobile={isMobile}` to the `<ChatWidget user={userIdentity} isGuest={…} />` render call (App.tsx:161). `App` already computes `const isMobile = useIsMobile()` (App.tsx:48) and passes it to `AppLayout` — no new hook call, no new state.
  - [x] Update the stale comment at App.tsx:46-47 — it currently says the responsive shell is *"NOT passed to ChatWidget — the chat FAB reposition is Story 11.4"*. Change it to note `isMobile` is now also drilled to `ChatWidget` for the FAB/panel reposition (Story 11.4). English only.
  - [x] Do **not** call `useIsMobile()` inside `ChatWidget`. One hook instance in `App.tsx` remains the single source of truth.

- [x] **Task 2 — `ChatWidget` accepts `isMobile` and computes `chatBottom`/`chatRight` (AC1, AC2, AC3)**
  - [x] Add `isMobile?: boolean` to `ChatWidgetProps` (ChatWidget.tsx:53-62), default `false`. Destructure it in the component signature alongside `user` and `isGuest`: `export function ChatWidget({ user, isGuest = false, isMobile = false }: ChatWidgetProps)` (ChatWidget.tsx:107).
  - [x] Inside the component (near `launcherActive`, ChatWidget.tsx:119) compute the two shared values once:
        `const chatBottom = isMobile ? 78 : 24;` and `const chatRight = isMobile ? 16 : 24;`
        Keep them **numbers** (not `'78px'` strings) so React renders `24` → `24px` exactly as today → desktop output byte-identical → zero e2e churn.
  - [x] FAB (closed state, ChatWidget.tsx:394-407): replace `bottom: 24` with `bottom: chatBottom` and `right: 24` with `right: chatRight` in the FAB button `style`. Change nothing else in that style object.
  - [x] Panel (open state, ChatWidget.tsx:481-499): replace `bottom: 24` with `bottom: chatBottom` and `right: 24` with `right: chatRight` in the panel div `style`. Change nothing else — `width: 404`, `maxWidth: 'calc(100vw - 32px)'`, `height: 642`, `maxHeight: 'calc(100vh - 48px)'`, `borderRadius: 18`, `boxShadow`, `overflow: 'hidden'`, `animation: 'kh-pop 0.2s ease both'` all stay verbatim (AC2).

- [x] **Task 3 — VERIFY the panel's viewport constraints + animation are already correct (AC2, AC4)**
  - [x] Confirm (no code change) the panel already declares `maxWidth: 'calc(100vw - 32px)'` (now ChatWidget.tsx:500), `maxHeight: 'calc(100vh - 48px)'` (:502), and `animation: 'kh-pop 0.2s ease both'` (:511) — all matching the design (Web.dc.html L470). These are inherited from Story 5.3; NOT recomputed off `isMobile`, NOT changed. (Line numbers shifted +13 from the +6-line `chatBottom`/`chatRight` comment+consts and +7-line prop doc; values byte-identical.)
  - [x] Confirm `kh-pop` and `kh-pulse` keyframes exist in `global.css` (lines 51-52). No new `@keyframes` added.

- [x] **Task 4 — Tests (AC1, AC2, AC3, AC5)**
  - [x] Add focused responsive assertions to the EXISTING `ChatWidget.test.tsx` (new `describe('ChatWidget — responsive corner (11.4)')` block appended; no new spec file, no existing assertion edited):
    - Render with `isMobile` true → open the panel → assert the FAB (before open) and the panel `bottom`/`right` are the mobile values (`bottom: 78px`, `right: 16px`).
    - Render with `isMobile` false (omitted → default) → assert the desktop values (`bottom: 24px`, `right: 24px`).
    - Assert the panel `maxWidth`/`maxHeight` are unchanged (`calc(100vw - 32px)` / `calc(100vh - 48px)`) in both modes — proves AC2's "not recomputed off isMobile".
  - [x] Query by the existing test-ids: `chat-fab` (closed FAB) and `chat-panel` (open panel), opening via `fireEvent.click(screen.getByTestId('chat-fab'))`.
  - [x] Assert style via the element's inline style (`(el as HTMLElement).style.bottom` etc.); jsdom serializes numeric px props to `'78px'` strings.
  - [x] Keep the default path proven: `renderWidget()` (no `isMobile`) still produces desktop `bottom:24px`/`right:24px` — every existing test stays green (32/32 in the file).
  - [x] No `matchMedia` stub added to `test-setup.ts`. No existing assertion edited.

- [x] **Task 5 — Verification gate + docs sync (AC5, AC6)**
  - [x] Ran `npm run lint && npm run test && npm run build` (repo-wide): lint 0 / **1094 unit+web (+3), 1 skipped** / build clean (5 pkgs). Output pasted in Debug Log.
  - [x] Ran the E2E desktop harness (`test:e2e`, Chromium 1280px): **28 passed, zero baseline churn**. `chat.spec.ts` AC1/AC2 (FAB + panel geometry) stayed green → desktop 24/24 byte-identical, no snapshot diff.
  - [x] Confirmed `git diff --name-only ab0b527 -- packages/` is `web` only, three files: `App.tsx`, `ChatWidget.tsx`, `ChatWidget.test.tsx`.
  - [x] No `TECHNICAL-DESIGN.md` / `frontend-standards.md` change needed — both were updated when Épico 11 was planned (frontend-standards.md 760px responsive rule; TECHNICAL-DESIGN §5.5 responsive paragraph, which already names the chat-FAB reposition). Leave them.

### Review Findings

- [x] [Review][Defer] Panel top-clip on small portrait mobile viewports (e.g. iPhone SE 375×667) [`ChatWidget.tsx:496-502`] — deferred to 11.5 (design-verbatim per D4; clip only affects small portrait viewports <690px height, outside 11.5's 390×844 target — resolve with the mobile Playwright harness in 11.5). Detail: With `bottom: 78` on mobile and the static `maxHeight: calc(100vh - 48px)` (`ChatWidget.tsx:496-502`), the panel's top edge is clipped: the fixed stack `bottom 78 + height 642 = 720` exceeds the viewport whenever height < 720px (R2-corrected onset threshold; 0–30px clip), settling to a constant −30px once `maxHeight` engages (< 690px). Header (close/history/new-conversation controls) pushed off the top. Flagged independently by Blind Hunter + Edge Case Hunter across both rounds (both High). R2 aggravator: `100vh` overstates visible height under a mobile URL bar (`viewport-fit=cover`), so 11.5 should weigh `dvh`/`svh`. The spec (D4 + "Edge case to VERIFY" Dev Note) already analyzed this and ratified implementing the design verbatim, framing the clip as "landscape phone or very short window"; review found it ALSO bites **iPhone SE / mini-class devices in portrait** (375 wide → isMobile true; 667 tall → maxHeight engages), which is a more common case than the spec anticipated. Landscape phones do NOT clip (width > 760px → desktop path, bottom:24). Decision: keep design-verbatim static `maxHeight` and defer small-device handling to 11.5 (matches D4), OR make `maxHeight` mobile-aware now (`isMobile ? 'calc(100vh - 94px)' : 'calc(100vh - 48px)'`, where 94 = 78 bottom + 16 top gap) to eliminate the clip. Note: the new test `should NOT recompute the panel viewport constraints off isMobile` (`ChatWidget.test.tsx`) asserts `maxHeight` unchanged in both modes and would need updating if the mobile-aware option is chosen.

## Dev Notes

### The one job of `isMobile` in ChatWidget is the corner offset (AC1, AC2)

Unlike the shell (11.2, which switches whole components) and even the views (11.3, which changed padding + one table), ChatWidget needs `isMobile` for exactly **two number pairs**: the FAB corner and the panel corner, and they share the same two values. The panel's *sizing* responsiveness (`maxWidth: calc(100vw - 32px)`, `maxHeight: calc(100vh - 48px)`) was already shipped in Story 5.3 and matches the design verbatim — it is **not** part of this change. So the responsive surface here is the smallest in the epic: drill the prop, compute `chatBottom`/`chatRight`, swap four literals. Resist scope creep — do NOT resize the panel per-device, add mobile font sizes, change the header/composer, or touch any chat behavior. The design does none of that; it only moves the corner.

[Source: docs/context/design/Share2Brain Web.dc.html L460 (FAB `bottom:{{chatBottom}}; right:{{chatRight}}`), L470 (panel same + static `max-width`/`max-height`/`kh-pop`), L1098-1099 (`chatBottom`/`chatRight` definitions); packages/web/src/components/ChatWidget.tsx:394-407,481-499]

### Why 78 / 16 (the exact mobile values)

- `chatBottom = 78` = the bottom-nav `height: 62` (BottomNav.tsx:30, `bottom: 0`) + a 16px gap, so the FAB floats clearly above the bar. The bottom-nav already reserves `env(safe-area-inset-bottom)` via its own `padding-bottom` (BottomNav.tsx:31), so `78` is measured from the bar's *layout box*; do NOT add or subtract the safe-area inset in ChatWidget (same principle as 11.3's D5 `104px` `contentPad` — the bar owns the inset).
- `chatRight = 16` = the tighter mobile gutter (matches the mobile content padding's `16px` horizontal from 11.3's `'22px 16px 104px'`). Desktop stays `24`.

[Source: packages/web/src/components/BottomNav.tsx:24,30-31; Web.dc.html L1098-1099; 11-3…md#D5 (safe-area is owned by the bar, used verbatim not computed)]

### Why `isMobile?` is OPTIONAL with a `false` default (D1) — the AC5 linchpin

The existing `ChatWidget.test.tsx` renders the widget via a `renderWidget()` helper (`render(<ChatWidget user={USER} />)`, ChatWidget.test.tsx:66) and directly (`render(<ChatWidget user={USER} isGuest />)`, line 146) — **none pass `isMobile`**. If `isMobile` were a **required** prop, every one of those render calls would break (TS compile error + runtime). Making the prop **optional, default `false`** (desktop) keeps all existing ChatWidget tests green **untouched**, matches the jsdom desktop default, and still lets the new focused tests pass `isMobile` explicitly to exercise both paths. This is the identical decision 11.3 made for the three views (D1 there); reuse it for consistency. Reversible (make it required + edit the tests if a stricter contract is ever wanted).

[Source: packages/web/src/components/ChatWidget.test.tsx:64-66,146; 11-3…md#Why-isMobile?-is-OPTIONAL (the AC7 linchpin)]

### The jsdom `matchMedia` guard (inherited from 11.2) still protects everything

`test-setup.ts` does **not** stub `matchMedia`; jsdom has none; `useIsMobile` returns `false` under jsdom (11.2's guard). Under jsdom the ChatWidget tests render the widget directly (not through `App`), so `isMobile` is simply the prop default `false` unless a test passes it — the desktop FAB/panel offsets render and every existing assertion holds. The new tests pass `isMobile` explicitly (the prop is drilled → trivially testable both ways), so they do not depend on `matchMedia` at all. Do NOT add a `matchMedia` stub to `test-setup.ts` — it would only matter for `App`-level tests and could flip the desktop default and churn the suite.

[Source: _bmad-output/implementation-artifacts/11-2-web-useismobile-shell-responsive-applayout-header.md#THE-critical-guardrail; packages/web/src/test-setup.ts (no matchMedia stub — confirmed empty)]

### Keep `chatBottom`/`chatRight` NUMERIC to guarantee zero e2e churn

Today's FAB/panel use numeric literals (`bottom: 24`), which React serializes to `24px`. The design template shows string values (`'24px'`), but if you emit the desktop value as a string you risk a serialization difference. Emit **numbers** (`isMobile ? 78 : 24`) so the desktop rendered output is byte-identical to the current DOM → the desktop chat baselines cannot churn. (jsdom's inline-style read-back returns `'24px'` either way, so tests are unaffected.)

[Source: packages/web/src/components/ChatWidget.tsx:396-397,483-484 (current numeric literals)]

### Closing the 11.2 chat-FAB defer

11.2 shipped the bottom-nav but left ChatWidget's FAB at the desktop `bottom:24`, so on mobile the FAB lands on top of the 62px bar. The 11.2 review deferred the fix here by name (the App.tsx:46-47 comment is the in-code marker). Lifting the FAB to `bottom:78` (AC1) is the primary deliverable and resolves that defer.

[Source: packages/web/src/App.tsx:46-47 (verbatim defer marker); 11-2…md#Review-Findings]

### Edge case to VERIFY (not fix): panel top-clip on very short viewports (potential defer)

With `bottom: 78` and the static `maxHeight: calc(100vh - 48px)`, when the panel reaches its max height (viewport height < ~690px, e.g. a phone in landscape or a very short window) the panel's top would extend ~30px above the viewport top: `top = 100vh − 78 − (100vh − 48) = −30`. On the epic's primary mobile target (390×844, Story 11.5's viewport) the panel's natural `height: 642` is well under `maxHeight (796)`, so `maxHeight` never engages and there is **no clip** (top ≈ 124px). On desktop (`bottom: 24`) the same math gives a clean `top = 24px` (symmetric 24/24 margins). Because this only bites below ~690px height and the design specifies `maxHeight: calc(100vh − 48px)` as a static value (NOT bound to `isMobile`), implement the design **verbatim** and record this as a VERIFY: check the panel at 390×844 (no clip expected) and note the short-viewport behavior in Completion Notes. If a real clip is observed at the tested mobile viewport, do NOT invent a fix — flag it as a defer to `deferred-work.md` (matching how 11.3 handled its StatsView-overflow defer). Do not compute a per-device `maxHeight`; that diverges from the design.

[Source: Web.dc.html L470 (static `max-height:calc(100vh - 48px)`, `bottom:{{chatBottom}}`); packages/web/src/components/ChatWidget.tsx:483-489; 11-3…md#Review-Findings (defer precedent)]

### Current ChatWidget state (what you are modifying) — exact state today

- **`ChatWidget.tsx`** (1087 lines): `ChatWidgetProps { user; isGuest? }` (lines 53-62); component signature `ChatWidget({ user, isGuest = false })` (line 107). Two render branches:
  - **Closed → FAB** (lines 385-441): `<button className="kh-chat-fab" data-testid="chat-fab">` with `style={{ position:'fixed', bottom: 24, right: 24, zIndex: 60, width: 60, height: 60, … }}` (bottom/right at lines 396-397). Contains the amber hexagon `<span>` and the conditional launcher dot.
  - **Open → panel** (lines 443-833): `<div role="dialog" data-testid="chat-panel">` with `style={{ position:'fixed', bottom: 24, right: 24, zIndex: 60, width: 404, maxWidth:'calc(100vw - 32px)', height: 642, maxHeight:'calc(100vh - 48px)', …, animation:'kh-pop 0.2s ease both' }}` (bottom/right at lines 483-484; the maxWidth/maxHeight/animation you must NOT touch at 487/489/498).
- **`App.tsx`** (197 lines): `const isMobile = useIsMobile()` (line 48, already used for `AppLayout`); `<ChatWidget user={userIdentity} isGuest={user.isGuest === true} />` (line 161). The stale comment sits at lines 46-47.
- **`ChatWidget.test.tsx`**: `renderWidget()` helper (line 64-66) renders `<ChatWidget user={USER} />` without `isMobile`; test-ids `chat-fab` / `chat-panel` are used throughout; existing tests explicitly note jsdom applies no positioning (header comment lines 3-5).

[Source: packages/web/src/components/ChatWidget.tsx; App.tsx:46-48,161; ChatWidget.test.tsx:1-6,64-66]

### Decisions (ratified defaults — flag at PR)

- **D1 — `isMobile?: boolean` OPTIONAL, default `false`** (not required). Keeps every existing `ChatWidget.test.tsx` render call green untouched, matches the jsdom desktop default, stays prop-testable both ways. Identical to 11.3's D1. Reversible.
- **D2 — `chatBottom`/`chatRight` computed once as component-local consts** off `isMobile` (`isMobile ? 78 : 24` / `isMobile ? 16 : 24`), applied to BOTH the FAB and the panel. Mirrors 11.3's D2 (dynamic value at the render site). Reversible.
- **D3 — Values kept NUMERIC** (not `'78px'` strings) so desktop rendered output is byte-identical → zero e2e churn. Reversible.
- **D4 — Panel `maxWidth`/`maxHeight`/`kh-pop` LEFT AS-IS (verify-only)** — already shipped in 5.3 and matching the design; NOT recomputed off `isMobile`. Any change requires a measured-overflow justification in Completion Notes.
- **D5 — `78`/`16` used verbatim from the design, not computed from the bottom-nav height or safe-area inset.** The bar owns `env(safe-area-inset-bottom)`; `78` is the design's headroom above the bar's layout box (same principle as 11.3 D5's `104px`).

### Architecture & guardrails

- **Frontend-only, `packages/web` exclusively.** AD-3 (static SPA — responsiveness is pure client CSS/JS, no server, no per-device build) and AD-6 (no contract touched) stay intact. No Drizzle/Zod/API/SSE change. **No new dependency** (reuses the 11.2 `useIsMobile`). No DDL, no migration. [Source: epics.md#Épico-11; sprint-change-proposal-2026-07-13-responsive-refresh.md#2]
- **No `@media` layout breakpoint and no new `@keyframes`.** Layout stays JS-driven via `useIsMobile` (the house pattern from 11.2/11.3, consistent with the design's `isMobile`-in-state). The only `@media` in the package remains `prefers-reduced-motion`; `kh-pop`/`kh-pulse` already exist in `global.css`. [Source: components.css; global.css:47-52]
- **Do NOT break the cascade rule (Epic 4 AI#4 / ChatWidget header comment lines 19-24).** This story touches only `position`/`bottom`/`right` inline layout values — none is a `:hover`/`:focus` pseudo-class property, so inline is safe (same reasoning ChatWidget already documents for its send-button state). Do not move any `:hover` state inline. [Source: ChatWidget.tsx:19-24]
- **No raw hex introduced.** This diff changes only numeric offsets — introduce no new colors. The pre-existing sanctioned hexes in ChatWidget (`#F5A623`, `#5865F2`, `#3BA55D`, `#fff`) stay as they are. [Source: global.css allowlist; 11-3…md#Task-5]
- **English only** in all code/comments/tests/commits. [Source: project-context.md#Code quality]
- **One story at a time; branch first.** `git switch -c feat/11-4-chat-widget-responsive` off HEAD (`ab0b527`); never commit on `main`. Conventional Commits, scope `web`. [Source: project-context.md#Development workflow]

### Project Structure Notes

- Components live in `packages/web/src/components/` (there is **no** `views/` or `widgets/` dir). Files touched: `ChatWidget.tsx` (prop + 2 consts + 4 literal swaps), `App.tsx` (1 prop + 1 comment), `ChatWidget.test.tsx` (focused responsive assertions). **No new files.**
- Layout values live **inline** in each component's `CSSProperties`; only interactive `:hover`/`:focus` states live in `components.css`. This story adds JS-driven responsive offsets (consistent with 11.2/11.3). Do not introduce `@media` layout rules.
- `data-kh` (theme) is orthogonal to layout — the widget themes automatically via tokens in both light and dark; AC4 requires verifying both, but no theme-specific code.

### Testing

- **Unit (Vitest + RTL):** focused responsive assertions added to the existing `ChatWidget.test.tsx` (FAB + panel `bottom`/`right` mobile vs desktop; panel `maxWidth`/`maxHeight` unchanged both ways). All other unit tests stay green because the default-false prop + jsdom matchMedia guard preserve the desktop path. Do not create new spec files; do not edit existing assertions. [Source: 11-3…md#Testing; project-context.md#Testing]
- **E2E visual (Playwright, existing dark-desktop harness):** `chromium` = `devices['Desktop Chrome']` (1280px > 760px) → desktop path → existing count passed, **zero baseline churn**. `tests/chat.spec.ts` exercises the widget at desktop → FAB/panel stay at 24/24 → chat baselines byte-identical. Any snapshot diff means a desktop value moved by accident — stop and audit. Mobile + light-theme baselines are **11.5's** job, deferred by name. [Source: playwright.config.ts; tests/chat.spec.ts; epics.md#Historia-11.5]
- **No integration run needed** (web-only, no shared/backend touch) — mirrors 9.2/10.2/11.1/11.2/11.3.
- **E2E boot note (from 11.1/11.2/11.3):** `e2e:server` needs `DATABASE_URL` + `REDIS_URL` (no default). Local: `DATABASE_URL` → Docker Postgres :5432, `REDIS_URL=redis://127.0.0.1:6379` (tests/README.md).

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Épico-11 · Historia-11.4] — story scope ("FAB reposicionado sobre la barra inferior en móvil `chatBottom:78px`/`chatRight:16px` vs `24/24` desktop; panel `max-width:calc(100vw-32px)`, `max-height:calc(100vh-48px)`, animación `kh-pop`; el FAB no tapa la bottom-nav"), binding sequence (11.4 ∥ 11.3 after 11.2), FR27.
- [Source: _bmad-output/planning-artifacts/sprint-change-proposal-2026-07-13-responsive-refresh.md] — Moderate, AD-3/AD-6 intact, frontend-only, no new dependency, risk Low; §4 success criteria; L212 (the FAB reposition named explicitly).
- [Source: docs/context/design/Share2Brain Web.dc.html] — L460 (FAB `bottom:{{chatBottom}}; right:{{chatRight}}`, width/height 60, amber hexagon, launcher dot), L470 (panel `bottom:{{chatBottom}}; right:{{chatRight}}` + static `width:404px; max-width:calc(100vw - 32px); height:642px; max-height:calc(100vh - 48px); animation:kh-pop 0.2s ease both`), L1098-1099 (`chatBottom: isMobile ? '78px' : '24px'`, `chatRight: isMobile ? '16px' : '24px'`), L50 (`kh-pop` keyframe).
- [Source: _bmad-output/implementation-artifacts/11-2-web-useismobile-shell-responsive-applayout-header.md] — the shell this builds on: `useIsMobile`, `AppLayout` switch, the jsdom matchMedia guardrail, the deferred chat-FAB reposition.
- [Source: _bmad-output/implementation-artifacts/11-3-web-adaptacion-responsive-vistas-search-docs-stats.md] — the immediately-preceding sibling: D1 (optional default-false prop), D2 (dynamic value at render site), D5 (safe-area owned by the bar, verbatim not computed), the matchMedia guard, the defer-to-deferred-work precedent.
- [Source: packages/web/src/components/ChatWidget.tsx + ChatWidget.test.tsx; App.tsx; hooks/useIsMobile.ts; components/BottomNav.tsx; styles/global.css; test-setup.ts; playwright.config.ts; tests/chat.spec.ts] — current widget state, wiring, tests, config, bottom-nav height (62), keyframes.
- [Source: docs/frontend-standards.md#UI/UX-Standards] — 760px breakpoint, no body h-scroll, mobile+light E2E rule.
- [Source: docs/context/TECHNICAL-DESIGN.md §5.5] — Responsive (Épico 11) paragraph (names the chat-FAB reposition).
- [Source: docs/context/ARCHITECTURE-SPINE.md] — AD-3 (static SPA), AD-6 (contracts in shared).

## Dev Agent Record

### Agent Model Used

claude-opus-4-8 (Claude Code, bmad-dev-story)

### Debug Log References

- **Gate — `npm run lint`**: `eslint .` → 0 errors/warnings.
- **Gate — `npm run test`** (`vitest run --project unit --project web`): `Test Files 105 passed | 1 skipped (106)`, `Tests 1094 passed | 1 skipped (1095)`. Baseline pre-11.4 was 1091 unit+web (11.3 note); +3 from the new responsive-corner `describe` block. The 1 skip is pre-existing.
- **Gate — `npm run build`**: `tsc --noEmit` clean for shared/backend/bot/workers; `vite build` for web OK (168 modules, `dist/assets/index-*.js 390.44 kB`). 5 packages clean.
- **Focused unit run** (`vitest run packages/web/src/components/ChatWidget.test.tsx`): `32 passed` (29 pre-existing + 3 new).
- **E2E desktop** (`npm run test:e2e`, Playwright chromium = Desktop Chrome 1280px, `DATABASE_URL`=dev DB, `REDIS_URL`=redis://127.0.0.1:6379): **28 passed (29.1s), zero baseline churn**. `chat.spec.ts` AC1 (FAB geometry) + AC2 (panel dimensions) stayed green → desktop path unchanged, confirming numeric `24` serialized byte-identically.

### Completion Notes List

- **All 6 ACs satisfied.** The change is exactly the planned surface: drill `isMobile?: boolean` (optional, default `false`) `App → ChatWidget`, compute `chatBottom = isMobile ? 78 : 24` / `chatRight = isMobile ? 16 : 24` once, apply to BOTH the closed FAB and the open panel. Four literals moved; nothing else in either style object changed.
- **D1–D5 honored verbatim.** D1 optional/default-false prop → every existing `ChatWidget.test.tsx` render (`renderWidget()`, `render(<ChatWidget user={USER} isGuest />)`) stays green untouched. D3 values kept NUMERIC → desktop DOM byte-identical → zero e2e churn (28 e2e green, no chat snapshot diff). D4 panel `maxWidth`/`maxHeight`/`kh-pop` left as-is (verify-only) and asserted unchanged in both modes by a new test. D5 `78`/`16` used verbatim from the design (not computed from bottom-nav height / safe-area).
- **11.2 chat-FAB defer CLOSED.** The stale App.tsx:46-47 comment marker is updated; the FAB now lifts to `bottom:78` on mobile, clearing the 62px bottom-nav + 16px gap.
- **VERIFY — panel top-clip edge case (no defer needed at the primary target).** With `bottom:78` and static `maxHeight: calc(100vh - 48px)`: at the epic's primary mobile target 390×844, the panel's natural `height:642` < `maxHeight` (796), so `maxHeight` never engages and `top = 844 − 78 − 642 = 124px` → **no clip**. The clip only appears below ~690px viewport height (e.g. landscape phone), where `top = 100vh − 78 − (100vh − 48) = −30px`. Per the design, `maxHeight` is a STATIC value (not bound to `isMobile`) — implemented verbatim; no per-device `maxHeight` invented. No clip observed at the tested target, so nothing added to `deferred-work.md`. Mobile visual capture is 11.5's job. (jsdom applies no layout, so this is a geometric/design-math verification, not an e2e assertion here.)
- **Scope discipline.** No chat behavior, header, composer, bubbles, citations, focus-trap, or history touched. No panel resize, no mobile font sizes. Frontend-only, `packages/web` exclusively (3 files). AD-3 + AD-6 intact: no shared/backend/workers/bot change, no Drizzle/Zod/API/SSE touch. No new dependency, no `@media` layout breakpoint, no new `@keyframes` (`kh-pop`/`kh-pulse` already in global.css:51-52).

### File List

- `packages/web/src/App.tsx` (modified) — drill `isMobile={isMobile}` into `<ChatWidget>`; update the stale 11.2 comment marker.
- `packages/web/src/components/ChatWidget.tsx` (modified) — add optional `isMobile?: boolean` prop (default false); compute `chatBottom`/`chatRight`; apply to the FAB and panel `bottom`/`right` (4 literals).
- `packages/web/src/components/ChatWidget.test.tsx` (modified) — new `describe('ChatWidget — responsive corner (11.4)')` block (3 tests: desktop default, mobile lift, panel constraints unchanged both modes). No existing assertion edited.

## Change Log

| Date       | Change                                                                                          |
|------------|-------------------------------------------------------------------------------------------------|
| 2026-07-13 | Implemented Story 11.4: responsive FAB/panel corner. Drilled optional `isMobile` App→ChatWidget; `chatBottom`/`chatRight` (78/16 mobile, 24/24 desktop) applied to FAB + panel; 3 new unit tests. Gate green (lint 0 / 1094 unit+web / build 5 pkgs / 28 e2e, zero baseline churn). Status → review. |
