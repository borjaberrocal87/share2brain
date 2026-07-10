---
baseline_commit: 7d4e42e4a36d894eb41d4b0ce9dc028d57527a16
---

# Story 5.3: Widget Flotante FAB + Panel Base

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **user of the web app**,
I want **to open a floating chat panel from any authenticated screen**,
so that **I can reach the agent without leaving my current context**.

> **Scope boundary (read first).** This story builds the chat widget **shell** only:
> the FAB launcher, the panel container + header, the empty state, and the conversation-history
> overlay (reading `GET /api/conversations`). It does **NOT** build the message composer
> (textarea + send button + privacy footer), message-bubble rendering, SSE streaming, the
> execution-trace panel, or citation chips — **all of that is Story 5.4**. Selecting a history
> item or "new conversation" in 5.3 only updates panel state (active id + close overlay); it does
> **not** load or render messages yet. Keep the message area showing the empty state.

## Acceptance Criteria

Derived from epics.md §Historia 5.3, UX-DR15/16/17/18/23, and the pixel-exact prototype
`docs/context/design/Share2Brain Web.dc.html` (lines 284–348). The prototype is the source of truth
for exact px/color values; **its `--tx*` token names are stale** — use the real names (see Dev
Notes §Token mapping).

1. **FAB visible on every authenticated route** — When an authenticated user views the app, a
   hexagonal FAB is rendered: 60×60px, `position: fixed`, `bottom: 24px`, `right: 24px`,
   `z-index: 60`. Its shape is the brand hexagon (`clip-path` polygon) filled with the amber
   gradient (`linear-gradient(150deg, #FFCB6B, #F5A623)`) and it carries the amber drop shadow
   `box-shadow: 0 14px 34px -10px rgba(245,166,35,0.65)`. It contains a chat/message icon stroked
   in `var(--on-accent)` (`#0E1116`). `aria-label="Abrir chat con el agente"`. On `:hover` it
   lifts with `transform: translateY(-2px)`.

2. **Clicking the FAB opens the panel with the correct chrome** — Clicking the FAB opens a panel
   that:
   - is `position: fixed` bottom-right (`bottom: 24px; right: 24px`), `z-index: 60`, sized
     `width: 404px; max-width: calc(100vw - 32px); height: 642px; max-height: calc(100vh - 48px)`,
     `border-radius: 18px`, `border: 1px solid var(--border-strong)`, `background: var(--bg)`, with
     a deep shadow, `overflow: hidden`;
   - animates in with `animation: kh-pop 0.2s ease both`;
   - shows a header (`background: var(--bg-deep)`, bottom border `var(--line)`) containing the
     hexagon logo + "Share2Brain" (Space Grotesk 700 15px) + status row (green 6px dot + "Agente de
     conocimiento" in `var(--text-muted)` 11px) + **three** 32×32px icon buttons: **historial**
     (clock), **nueva conversación** (plus), **cerrar** (X). History/new buttons hover to
     `color: var(--accent-ink)` + `border-color: var(--border-hover)`; the close button hovers to
     `color: #ED4245` + `border-color: #ED4245`.

3. **FAB hides while the panel is open** — When the panel is open the FAB is not rendered
   (`toHaveCount(0)`); when the panel closes the FAB reappears.

4. **Empty state** — When the panel opens with no active/selected conversation, the message area
   shows the empty state: a centered 60px amber hexagon (amber-gradient outer → `var(--bg)`
   middle, no center dot), `h3` "Preguntá lo que quieras" (Space Grotesk 600 21px), a description
   paragraph in `var(--text-tertiary)`, and **3** suggestion chips (`padding: 13px 16px`,
   `border: 1px solid var(--border)`, `border-radius: 11px`, `background: var(--surface)`) that
   on `:hover` set `border-color: var(--accent-ink)`.

5. **Conversation-history overlay** — Clicking the header **historial** button opens an overlay
   that covers the message area (`position: absolute; inset: 0; z-index: 5; background: var(--bg)`)
   with the label "Historial de conversaciones" (IBM Plex Mono uppercase 10px `var(--text-subtle)`)
   and a scrollable list. On open it calls `GET /api/conversations`; each row is a full-width
   button (chat icon + title truncated with ellipsis + relative timestamp in
   `var(--text-subtle)`), ordered most-recently-active first, hovering to `background: var(--hover)`.
   When the list is empty it shows an empty message. Clicking a row sets the active conversation id
   and closes the overlay (no message rendering in 5.3). The header **nueva conversación** button
   clears the active id and closes the overlay.

6. **Close & dismiss** — The header **cerrar** button closes the panel (FAB returns, per AC3).
   Pressing `Escape` while the panel is open closes it. On close, keyboard focus returns to the
   FAB; on open, focus moves into the panel.

7. **E2E harness coverage (Epic 4 retro AI#6 — critical path)** — `packages/web/tests/chat.spec.ts`
   verifies via `getComputedStyle`/`toHaveCSS` and a full-page screenshot: FAB geometry + amber
   shadow + hexagon clip-path (AC1); panel dimensions (404×642), radius 18px, `kh-pop`
   animation-name (AC2); FAB hidden while open (AC3); empty-state hexagon + "Preguntá lo que
   quieras" + 3 suggestions (AC4); history overlay populated from the seeded conversation (AC5).
   The E2E seed is extended with one `e2e-`-prefixed conversation (+ messages) for `e2e-member` so
   the populated history is assertable.

8. **Verification gate green** — `npm run lint && npm run test && npm run build` all clean, plus
   `npm run test:e2e -w @share2brain/web` passing on chromium; output pasted in the Dev Agent Record. No
   secrets/behavior mixing; English-only code; Spanish UI copy verbatim.

## Tasks / Subtasks

- [x] **Task 1 — Add the 4 new icons** (AC: 1, 2, 5)
  - [x] In `packages/web/src/components/icons.tsx`, add `ChatIcon`, `CloseIcon`, `HistoryIcon`,
        `PlusIcon` following the existing `IconProps`/`viewBox="0 0 24 24"`/`stroke="currentColor"`
        pattern. Use the exact SVG paths from the prototype (Dev Notes §SVG paths).
  - [x] Extend `Hexagon.test.tsx` is NOT needed; add icon smoke coverage only if you add logic.

- [x] **Task 2 — Export the hexagon clip-path constants for FAB reuse** (AC: 1, 4)
  - [x] In `packages/web/src/components/Hexagon.tsx`, `export const CLIP_PATH` and
        `export const AMBER_GRADIENT` (they exist as module-private consts today). The FAB is a
        **single** amber hexagon (not the 3-layer `Hexagon`), so it reuses these constants inline.
  - [x] The header logo and empty-state hexagon **do** reuse the `Hexagon` component
        (`<Hexagon size={32} innerBg="bg-deep" showDot={false} />` and
        `<Hexagon size={60} innerBg="bg" showDot={false} />`).

- [x] **Task 3 — Conversations API client** (AC: 5)
  - [x] Create `packages/web/src/api/conversations.ts` with
        `fetchConversations(params: { page?: number; limit?: number }, signal?: AbortSignal): Promise<ConversationsResponse>`,
        modeled exactly on `api/documents.ts` (`credentials: 'include'`, `!res.ok` throw,
        `ConversationsResponseSchema.parse(...)`). Import types **only** from
        `@share2brain/shared/schemas` (never the root barrel — AD-3 ESLint ban).
  - [x] Create `packages/web/src/api/conversations.test.ts` mirroring `documents.test.ts`
        (mock `fetch`, assert URL/credentials/parse/throw-on-!ok).
  - [x] Do **NOT** add a detail client (`fetchConversation`) or any chat/SSE client — those are 5.4.

- [x] **Task 4 — Relative-time formatter** (AC: 5)
  - [x] Create `packages/web/src/lib/relativeTime.ts`: pure `relativeTimeEs(iso: string, now?: Date): string`
        using `Intl.RelativeTimeFormat('es', { numeric: 'auto' })` → "hace 5 días" / "ayer" / "hace 2 h".
  - [x] Create `packages/web/src/lib/relativeTime.test.ts` (pure unit tests with an injected `now`).

- [x] **Task 5 — Build the `ChatWidget` component** (AC: 1–6)
  - [x] Create `packages/web/src/components/ChatWidget.tsx`, a self-contained component owning
        `chatOpen`, `chatHistoryOpen`, `activeConversationId` state (see Dev Notes §State).
  - [x] Render the FAB (`data-testid="chat-fab"`) when `!chatOpen`; render the panel
        (`data-testid="chat-panel"`, `role="dialog"`, `aria-label="Chat con el agente"`) when
        `chatOpen`. Match every inline style/px/color from the prototype using the **real** tokens.
  - [x] Header: hexagon logo + "Share2Brain" + status + 3 icon buttons wired to
        `toggleHistory` / `newChat` / `closeChat`.
  - [x] Message area: render the empty state (`data-testid="chat-empty-state"`) with the 60px
        hexagon, heading, description, and 3 suggestion chips (`data-testid="chat-suggestion"`).
        Suggestion click is a no-op stub in 5.3 (5.4 wires it to send a prefilled message) — but
        keep the buttons focusable/clickable.
  - [x] History overlay (`data-testid="chat-history-overlay"`): fetch on open (AbortController +
        cleanup), loading/error/empty/populated states; rows `data-testid="chat-history-item"`;
        empty state `data-testid="chat-history-empty"`.
  - [x] a11y: `Escape` closes the panel; focus moves into the panel on open and returns to the FAB
        on close (store the FAB ref).
  - [x] Reduced motion: no new CSS — the global `@media (prefers-reduced-motion: reduce)` block in
        `global.css` already neutralizes `kh-pop`/`kh-pulse`. Do not add a local block.

- [x] **Task 6 — CSS classes for hover/focus states** (AC: 1, 2, 4, 5)
  - [x] In `packages/web/src/styles/components.css`, add `.kh-chat-fab`, `.kh-chat-header-btn`,
        `.kh-chat-header-btn--danger`, `.kh-chat-suggestion`, `.kh-chat-history-item`.
  - [x] **Cascade rule (Epic 4 AI#4):** any element whose border/color changes on `:hover` must
        declare its **base `border`/`color` in the CSS class**, not inline — an inline `border`
        shorthand outranks a stylesheet `:hover { border-color }` and the hover silently dies. Put
        base borders in the classes; use inline only for a state that must **beat** hover (the
        active history item's amber tint, mirroring `.kh-nav-item--active`).
  - [x] Focus-visible: reuse the established ring `outline: 2px solid var(--accent-ink); outline-offset: 2px;`.

- [x] **Task 7 — Mount the widget in `App.tsx`** (AC: 1, 3)
  - [x] Wrap the authenticated `return` in a fragment and render `<ChatWidget />` as a **sibling
        after** `<AppLayout ... />` so it overlays the whole shell (`AppLayout` is
        `overflow: hidden`, so a `position: fixed` sibling is correct). No props needed in 5.3.
  - [x] Do not touch the `loading`/`anon` branches — the widget renders only when authenticated.

- [x] **Task 8 — Unit tests (jsdom / Testing Library)** (AC: 1–6)
  - [x] `packages/web/src/components/ChatWidget.test.tsx`: FAB renders; click opens panel + FAB
        hides; close button + `Escape` close + FAB returns; history button opens overlay and calls
        `fetchConversations` (mocked); empty-history state; populated list renders titles + relative
        times; "nueva conversación" clears active id + closes overlay; 3 suggestions render.
  - [x] Extend `App.test.tsx` with one test that the FAB is present in the authenticated shell and
        absent on the login screen.

- [x] **Task 9 — Extend the E2E seed with a conversation** (AC: 5, 7)
  - [x] In `packages/backend/src/e2e/seed.ts`, insert one `e2e-`-prefixed `conversations` row for
        `memberId` (already captured in the seed) + `messages` rows (first a `user` message whose
        content yields a known derived title, then an `assistant` message with `citations`).
        Cross-check exact columns against `conversations.integration.test.ts` /
        `chat.integration.test.ts`.
  - [x] Add `messages` then `conversations` to the reset block **in FK order** (delete `messages`
        before `conversations`), keeping the `e2e-`/member-user predicate — **never widen cleanup
        beyond `e2e-`** (module discipline). Update `SeedSummary` + boot log counts.

- [x] **Task 10 — E2E spec `chat.spec.ts`** (AC: 7)
  - [x] Create `packages/web/tests/chat.spec.ts` with a local `gotoChat(page)` helper
        (`loginAs(page, 'e2e-member')` then open the FAB), following the `docs.spec.ts` pattern
        (token `rgb(...)` constants, `toHaveCSS`, `getByTestId`, full-page screenshot).
  - [x] Assert AC1–AC5 computed styles + the populated history list (seeded title).
  - [x] Document the new spec's discovery-order in `tests/README.md` (deferred-work note: file
        discovery is alphabetical + `workers:1`; `chat.spec.ts` sorts before `docs.spec.ts`, so the
        docs mutating test still runs last — state this invariant explicitly).

- [x] **Task 11 — Verification gate** (AC: 8)
  - [x] Run and paste: `npm run lint && npm run test && npm run build`, then
        `npm run test:e2e -w @share2brain/web` (chromium; ensure `npx playwright install chromium` done).

### Review Findings

_bmad-code-review, 2026-07-07 — 3 adversarial layers (Blind Hunter + Edge Case Hunter + Acceptance Auditor) over the uncommitted working tree vs baseline `7d4e42e`. Acceptance Auditor found 0 AC violations (AC1–AC6 faithfully implemented, D1–D6 documented deviations honored, seed SQL cross-checked against `packages/shared/src/db/schema.ts`)._

- [x] [Review][Patch] Chat panel has no focus trap / `aria-modal` / inert background — `role="dialog"` panel (`ChatWidget.tsx`) handles `Escape` and moves focus in/out (satisfying AC6 as literally worded), but Tab/Shift+Tab can still move focus out of the panel into the fully-interactive `AppLayout` behind it (not marked `inert`/`aria-hidden`). RESOLVED with Borja: patch now — add `aria-modal="true"` and a Tab/Shift+Tab focus trap cycling within the panel's focusable elements. APPLIED: `getFocusableElements` helper + Tab/Shift+Tab wrap-around handling in the panel's `onKeyDown`; regression tests added ("should trap Tab focus...", "should trap Shift+Tab focus..."). [packages/web/src/components/ChatWidget.tsx]
- [x] [Review][Patch] `relativeTimeEs` throws an uncaught `RangeError` on a malformed/non-parseable ISO date — `Intl.RelativeTimeFormat.format` requires a finite number; a `NaN` duration (from an unparseable `iso`) throws instead of degrading gracefully. `ConversationSummary.updatedAt` is typed as a plain `z.string()` (not `.datetime()`), so nothing upstream guarantees a valid date. Crashes the whole panel render if ever hit. APPLIED: `relativeTimeEs` now returns `''` when `new Date(iso).getTime()` is `NaN`; regression test added ("should return an empty string for an unparseable iso instead of throwing"). [packages/web/src/lib/relativeTime.ts:33]
- [x] [Review][Patch] History-overlay `Escape` always closes the entire panel, even when only the history overlay is open — closing just the overlay first (then the panel on a second `Escape`) matches the usual nested-panel dismiss pattern; currently untested and unhandled. APPLIED: the panel's `onKeyDown` now closes `chatHistoryOpen` first if open, else closes the panel; regression test added ("should close only the history overlay..."). [packages/web/src/components/ChatWidget.tsx]
- [x] [Review][Patch] Brittle test assertion — `ChatWidget.test.tsx`'s active-row check uses `expect(activeRow.style.background).toContain('245')`, a substring match that would pass for any unrelated style value containing "245". Assert the exact expected value instead. APPLIED: now asserts `toBe('rgba(245, 166, 35, 0.12)')` / `toBe('')`. [packages/web/src/components/ChatWidget.test.tsx]
- [x] [Review][Patch] `relativeTime.test.ts` has no test for the `week` division or for a future (positive-duration) timestamp — coverage gap on an otherwise fully pure, cheaply-testable boundary. APPLIED: added a "should render weeks ago" and a "should render a future timestamp" test. [packages/web/src/lib/relativeTime.test.ts]
- [x] [Review][Patch] Task 10 checkbox claims a local `gotoChat(page)` helper was created in `chat.spec.ts`; it wasn't — 3 of the 4 tests inline the same `loginAs` + FAB-click pair instead (the first test can't use it, since it needs to assert the FAB's closed/resting state first). Functionally harmless (duplicated boilerplate only), but the task record doesn't match the diff. APPLIED: added `gotoChat(page)` and used it in the AC2/AC3, AC4, and AC5 tests (AC1 correctly keeps its own inline login+assert-closed sequence). [packages/web/tests/chat.spec.ts]
- [x] [Review][Defer] `resetAndSeed`'s new deletes/inserts run as separate unguarded `db.execute` calls, no transaction — a mid-sequence failure leaves partial e2e state; self-heals on the next boot since delete-then-insert always re-runs first. Test-infra only, not production code. [packages/backend/src/e2e/seed.ts]
- [x] [Review][Defer] `fetchConversations`'s `if (params.page)` / `if (params.limit)` truthiness checks silently drop an explicit `page: 0`/`limit: 0` — copied verbatim from the story's own Dev Notes §Conversations API template; currently unreachable since `ChatWidget` never passes these params in 5.3. [packages/web/src/api/conversations.ts]
- [x] [Review][Defer] The history overlay fetches `total` but never surfaces it — no pagination affordance if a user ever has more conversations than the default page size. Out of the 5.3 shell's stated scope. [packages/web/src/components/ChatWidget.tsx]
- [x] [Review][Defer] `conversations.ts` throws a generic `Error` with just the HTTP status on a non-ok response (discards any error body) and doesn't guard a malformed-JSON parse failure — matches the existing `api/documents.ts` convention verbatim, not a new regression. [packages/web/src/api/conversations.ts]

Dismissed as noise (12): `seed.ts`'s unchecked `rows[0]` access on the conversation insert (unreachable — a Postgres `INSERT ... VALUES ... RETURNING` always returns exactly one row on success or throws on failure); the `discord_id like 'e2e-user-%'` delete predicate "mismatching" its comment (it's the codebase's pre-existing convention, already used for `user_read_status`/`embeddings`/`users` in the same function — the new `messages`/`conversations` deletes just mirror it); header buttons' `title` vs `aria-label` text mismatch (non-issue — `aria-label` wins for the accessible name in every mainstream screen reader; `title` is purely a native hover tooltip); the `launcherActive` dead-code branch with no test coverage (explicitly directed by Dev Notes D1 — "include the dot markup gated on an internal boolean that stays false in 5.3"); `AbortError`-only catch in the history-fetch handler (`DOMException` named `AbortError` is the standardized shape from `fetch`'s `AbortController` in both browsers and Node 18+); `chat.spec.ts`'s Chromium-specific `box-shadow`/`stroke` serialization (the whole E2E harness is Chromium-only by design, Story 4.5 D4 — cross-engine portability was never a goal); assuming `--bg`/`--on-accent` compute to the same dark `rgb()` (explicitly confirmed identical in the story's own Dev Notes token table); the spec discovery-order coupling with no CI enforcement (pre-existing E2E harness design from Story 4.5; Task 10 explicitly asked to document it, not replace it); "can't verify shared-schema shapes from the diff alone" (resolved — the Acceptance Auditor, which had project read access, independently cross-checked `packages/shared/src/db/schema.ts` and confirmed the seed's citation/column shapes match); `PlusIcon`/`CloseIcon` missing `strokeLinejoin` (no visual effect — both icons' paths are disjoint straight-line segments with no shared vertex); duplicated magic geometry constants (`bottom:24`, `zIndex:60`, etc.) across the FAB and panel (only 2 occurrences, against the project's anti-premature-abstraction guidance; no demonstrated z-index collision); the history-fetch effect's in-flight `.then` firing after unmount (inconsequential under React 18+ — a `setState` call on an unmounted component is a silent no-op, not a crash).

### Review Findings — Round 2 (re-review of the 6 round-1 patches as new code)

_bmad-code-review, 2026-07-07 — per Epic 3 retro AI#1 ("treat every applied patch as new un-reviewed code"), the round-1 patches were re-reviewed as a standalone diff (reconstructed against the pre-patch snapshots of the 5 touched files) by fresh Blind Hunter + Edge Case Hunter passes. Both layers independently converged on the same class of regression: the new focus-trap/focus-restore logic had gaps of its own._

- [x] [Review][Patch] **Regression: Shift+Tab escaped the trap on the very first press after opening** — the panel container itself (not any header button) holds focus immediately after opening (the existing `panelRef.current?.focus()` effect), but `getFocusableElements` only returns *descendants*, so the container never equals `first`/`last` and the round-1 trap's `e.shiftKey && activeElement === first` check never fired — native Shift+Tab ran and moved focus backward into `AppLayout`, exactly the escape the patch was meant to close. FIXED: the trap now also treats `document.activeElement === panelRef.current` as the start-of-panel boundary. Regression test added ("should trap Shift+Tab even before focus moves off the panel container..."), verified to fail without the fix (temporarily reverted and re-ran). [packages/web/src/components/ChatWidget.tsx]
- [x] [Review][Patch] **Regression: closing the history overlay (Escape, selecting a row, or "nueva conversación") dropped focus to `document.body`** — the overlay unmounts its own focused row/button with no compensating focus-restore, so the very next Tab/Shift+Tab wasn't intercepted by the trap (activeElement matched neither `first` nor `last`) and could escape into `AppLayout`. FIXED: added a `historyBtnRef` + a `wasHistoryOpenRef`-guarded effect (mirrors the existing `chatOpen`/`fabRef` pattern) that refocuses the "Historial de conversaciones" button on any genuine `chatHistoryOpen` true→false transition. Regression test added ("should restore focus to the history toggle button..."), verified to fail without the fix. [packages/web/src/components/ChatWidget.tsx]
- [x] [Review][Patch] `relativeTimeEs`'s docstring didn't document the new `''`-on-invalid-input contract added by the round-1 NaN guard. APPLIED: docstring now states it. [packages/web/src/lib/relativeTime.ts]
- [x] [Review][Patch] `gotoChat`'s comment overclaimed "every other test" when only 3 of the 4 tests were converted. APPLIED: reworded to name the 3 tests. [packages/web/tests/chat.spec.ts]
- [x] [Review][Patch] `ChatWidget.test.tsx`'s hardcoded `rgba(245, 166, 35, 0.12)` literal had no cross-reference to where it comes from. APPLIED: added a comment pointing to `ChatWidget.tsx`'s `ACTIVE_ROW_STYLE.background`. [packages/web/src/components/ChatWidget.test.tsx]
- [x] [Review][Defer] `aria-modal="true"` alone doesn't make the background inert — `AppLayout` behind the panel is still reachable by assistive tech that doesn't fully honor `aria-modal` (e.g. touch/virtual-cursor browsing), since nothing marks it `inert`/`aria-hidden`. The keyboard-Tab escape this was meant to prevent is now closed by the 2 patches above; adding `inert` to `AppLayout` is additional hardening that touches a file outside `ChatWidget.tsx` — deferred rather than widening this round's blast radius. [packages/web/src/components/ChatWidget.tsx]

Dismissed as noise (6): the `focusable.length === 0` early-return not calling `preventDefault()` (unreachable today — the panel always renders 3 header buttons); the "single focusable element" case (verified working — `first === last` is handled correctly by the existing checks); "regression tests don't discriminate the fix" (verified false by empirically reverting each fix and re-running — both new tests fail without their corresponding fix, both pre-existing round-1 trap tests already discriminate correctly since the panel has 3 distinct header buttons); the future-timestamp test being "unrelated to the NaN-guard patch and diluting signal" (it's deliberate, requested coverage from round-1's own findings, not scope creep); recomputing `getFocusableElements` on every keydown with no memoization (a handful of buttons, a rarely-pressed key — no measurable cost); IME composition / Ctrl+Tab / other modifier combinations on the Tab handler (out of scope — no AC or prior finding requires guarding non-standard tab-cycling modifiers).

Gate re-run green after round-2 fixes: lint 0 / 486 unit+web (+2) / build clean (5 pkgs) / 10 e2e chromium (unchanged pass count).

### Review Findings — Round 3 (re-review of the round-2 patches as new code)

_bmad-code-review, 2026-07-07 — same convention, diff isolated against reconstructed pre-round-2 snapshots of the 2 substantively-changed files (`ChatWidget.tsx`, `ChatWidget.test.tsx`; the round-2 comment-only tweaks to `relativeTime.ts`/`chat.spec.ts` carried no logic risk and were excluded from this pass). Blind Hunter raised several theoretical races between the two focus-restore effects (`wasOpenRef` vs. `wasHistoryOpenRef`) when `closeChat` flips both `chatOpen` and `chatHistoryOpen` in the same tick — investigated via React's commit-phase ref-nulling guarantee (a ref to an unmounting DOM node is cleared during the synchronous mutation phase, strictly before any passive effect runs) and confirmed via a new test: closing the whole panel while the history overlay is open correctly lands focus on the FAB, no crash, no fight over focus. Edge Case Hunter found 1 real, currently-reachable bug (below) that predates round 2 (it's in `getFocusableElements`'s original round-1 selector, not the round-2 diff itself) but sits squarely in the same focus-trap subsystem this review chain exists to harden._

- [x] [Review][Patch] **The Tab-trap's `first`/`last` boundaries could resolve to an empty-state suggestion button hidden behind the history overlay** — `getFocusableElements` queries the whole panel regardless of `chatHistoryOpen`, and the empty-state wrapper (with its 3 suggestion buttons) stayed mounted (just visually covered by the opaque, higher-`z-index` overlay) even while the overlay was open. Reachable today: click "Historial" (focus stays on it = `first`), press Shift+Tab → wraps to `last`, which resolved to a suggestion button the user can't see. FIXED: the empty-state wrapper now only renders when `!chatHistoryOpen`, so it (and its buttons) simply isn't in the DOM — and therefore isn't in `getFocusableElements`'s result — while the overlay covers it. Regression test added ("should not render (or trap focus into) the empty-state suggestions..."), verified to fail without the fix (temporarily reverted and re-ran — it failed even harder than expected, on a duplicate-testid query, since the suggestions were still mounted). [packages/web/src/components/ChatWidget.tsx]
- [x] [Review][Patch] Added an explicit regression test for the two-effects-in-one-commit scenario Blind Hunter raised (closing the whole panel while history is open) — verified this was already correct by construction (React's ref-nulling-before-effects guarantee), not by a code change; the test exists so this guarantee has a named, direct assertion instead of resting on implicit reasoning. [packages/web/src/components/ChatWidget.test.tsx]

Dismissed as noise (7): "the two focus-restore effects race/fight over focus when `closeChat` fires both state changes" (verified false — React clears `historyBtnRef.current` to `null` during the commit/mutation phase, strictly before either passive effect runs, so `historyBtnRef.current?.focus()` safely no-ops and the `wasOpenRef` effect's `fabRef.current?.focus()` — which runs first, in hook-declaration order — is the one that lands; confirmed empirically, not just reasoned); "refocusing `historyBtnRef` on every close reason isn't semantically tailored per-action (select vs. newChat vs. Escape)" (there's no more-correct target yet — the message area has no interactive content tied to a selection until 5.4 adds the composer/bubbles; revisit then, not now); "a failed restore is recorded as handled with no retry" (there's no failure mode to retry — `?.focus()` on a `null` ref is a deliberate, correct no-op, not a silent error); "the `atStart` fix hardcodes `panelRef.current` instead of deriving the boundary generically" (correct as a description, but the described alternative isn't more correct today — it's a hypothetical future-proofing concern with no current bug); "bundling a comment-only test edit into this diff dilutes review scope" (it's one line, already reviewed above in round 2, not re-litigated); a claimed "brace mismatch" at the end of the test file's `describe` block (verified false — `tsc`/`eslint`/`vitest` all parse the file cleanly; the diff tool's hunk context just didn't show the unchanged closing brace); the Shift+Tab-pressed-twice / stuck-`atStart` scenario (verified via the existing "should trap Shift+Tab..." test structure — `atStart` is recomputed fresh from `document.activeElement` on every keydown, so it cannot get "stuck").

Gate re-run green after round-3 fixes: lint 0 / 488 unit+web (+2) / build clean (5 pkgs) / 10 e2e chromium (unchanged pass count).

## Dev Notes

### State & ownership (D1)
`ChatWidget` is **self-contained** — `chatOpen`, `chatHistoryOpen`, `activeConversationId` live
inside it, **not** lifted to `App.tsx` (unlike unread counts, which the sidebar badge needs).
Nothing outside the widget consumes chat-open state in 5.3, so keep `App.tsx`'s change to a single
sibling element. The `launcherActive` green pulsing dot from UX-DR15 (sending-while-closed) is
5.4's trigger; include the dot markup gated on an internal `launcherActive` boolean that stays
`false` in 5.3 (forward-compatible, matches the prototype).

Prototype state handlers to mirror (`Share2Brain Web.dc.html` lines 550–563):
`toggleChat` (open/close + close history), `closeChat`, `toggleHistory`, `selectConv(id)`
(set active + close history), `newChat` (clear active + close history).

### Token mapping — CRITICAL (D2)
The prototype markup uses the **old** token names renamed in Story 2.1. Map every occurrence:

| Prototype (`--tx*`) | Real token (use this) | Dark computed `rgb()` (for test ACs) |
|---|---|---|
| `--tx`  | `--text-primary`   | `rgb(230, 233, 239)` |
| `--tx2` | `--text-secondary` | `rgb(199, 205, 216)` |
| `--tx3` | `--text-tertiary`  | `rgb(154, 163, 178)` |
| `--tx4` | `--text-muted`     | `rgb(124, 132, 148)` |
| `--tx5` | `--text-subtle`    | `rgb(100, 108, 124)` |

Other dark computed values for `toHaveCSS`: `--bg` `rgb(14,17,22)`, `--bg-deep` `rgb(11,14,19)`,
`--surface` `rgb(18,22,29)`, `--border` `rgb(32,38,47)`, `--border-strong` `rgb(42,49,61)`,
`--border-hover` `rgb(58,66,80)`, `--line` `rgb(24,29,37)`, `--accent-ink` (dark) `rgb(245,166,35)`,
`--on-accent` `rgb(14,17,22)`. Brand hex (theme-independent): amber `#F5A623`, gradient light stop
`#FFCB6B`, Discord `#5865F2`, green `#3BA55D`, red `#ED4245`. **Use `var(--accent-ink)` for amber
text/borders** so it adapts to light theme (`#9A5B00`); the E2E harness forces dark, so assert the
dark `rgb`.

### AC-vs-source reconciliation (D3)
The epic AC5 phrasing "header con título 'Chat'" is loose. **UX-DR16 + the prototype are
authoritative for detail**: the header shows the hexagon logo + brand "**Share2Brain**" + status
"**Agente de conocimiento**", **not** a literal "Chat" heading. Implement per UX-DR16/prototype
(this is intentional, not a miss — noted so review doesn't flag it).

### Hexagon reuse (D4)
- **FAB** = single amber hexagon: a `<span>` with `clipPath: CLIP_PATH`,
  `background: AMBER_GRADIENT`, the amber shadow, + the chat icon on top (`position: relative`,
  `stroke="var(--on-accent)"`). It is **NOT** the 3-layer `Hexagon` component (which forces a
  nested bg middle layer the FAB does not have). Reuse the exported `CLIP_PATH`/`AMBER_GRADIENT`
  from `Hexagon.tsx` — do not re-inline the magic polygon string.
- **Header logo** = `<Hexagon size={32} innerBg="bg-deep" showDot={false} />`.
- **Empty-state hexagon** = `<Hexagon size={60} innerBg="bg" showDot={false} />`.
- The `Hexagon` component already interpolates sizes not in its `EXACT_MIDDLE` table (60 → ~33px
  middle); the ~1px difference vs the prototype's 34px is acceptable (component is the source of
  truth now, reused across Epics 2 & 5).

### Prototype SVG paths (copy verbatim into `icons.tsx`)
- **ChatIcon** (also used in history rows): `M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z` (`stroke-width` 2, round caps/joins).
- **HistoryIcon**: `<circle cx="12" cy="12" r="9"/>` + `<path d="M12 7v5l3 2"/>` (`stroke-width` 1.9).
- **PlusIcon**: `M12 5v14M5 12h14` (`stroke-width` 2).
- **CloseIcon**: `M18 6L6 18M6 6l12 12` (`stroke-width` 2).
The FAB chat icon renders at 25px; header buttons at 16/17/16px; history-row icon at 15px opacity 0.7.

### Prototype excerpt (authoritative geometry — lines 284–348)
FAB: `position:fixed; bottom:24px; right:24px; z-index:60; width:60px; height:60px` button
(transparent, border:none) wrapping the amber-hexagon span
(`box-shadow:0 14px 34px -10px rgba(245,166,35,0.65)`) + 25px chat svg
(`stroke="#0E1116"` → use `var(--on-accent)`). launcherActive dot: `top:1px; right:1px; 13×13;
border-radius:50%; background:#3BA55D; border:2px solid var(--bg); animation:kh-pulse 1.4s`.
Panel: `width:404px; max-width:calc(100vw - 32px); height:642px; max-height:calc(100vh - 48px);
border-radius:18px; border:1px solid var(--border-strong); background:var(--bg);
box-shadow:0 30px 80px -20px rgba(0,0,0,0.6); overflow:hidden; animation:kh-pop 0.2s ease both`.
Header: `padding:13px 12px 13px 16px; border-bottom:1px solid var(--line); background:var(--bg-deep)`.
Header buttons: `32×32; border:1px solid var(--border); border-radius:9px; background:transparent`.
Empty state: hexagon 60px, `h3` Space Grotesk 600 21px "Preguntá lo que quieras", `p`
`color:var(--text-tertiary)` 14px "El agente responde con RAG sobre el conocimiento de la comunidad
y cita sus fuentes.", suggestions `padding:13px 16px; border:1px solid var(--border);
border-radius:11px; background:var(--surface); color:var(--text-secondary); font-size:13.5px`.
History overlay: `position:absolute; inset:0; z-index:5; background:var(--bg)`; label
`padding:14px 16px 8px; IBM Plex Mono 10px; letter-spacing:0.08em; text-transform:uppercase;
color:var(--text-subtle)`; rows are full-width buttons (chat svg 15px opacity .7 + title
ellipsis + `font-size:10.5px; color:var(--text-subtle)` time), hover `background:var(--hover)`.

### Suggested Spanish copy to define (prototype leaves these dynamic)
- Empty-state suggestions (3): choose 3 knowledge-oriented prompts, e.g.
  "¿Cómo configuro las notificaciones?", "¿Qué es el backfill histórico?",
  "¿Cómo funciona el filtrado RBAC?" (final wording at dev's discretion, Spanish).
- Empty-history message: e.g. "Todavía no tenés conversaciones guardadas." (centered,
  `var(--text-subtle)`).
- History error state: reuse the view convention (a short retry line), consistent with `DocsView`.
- One deliberate deviation from the prototype: suggestion-chip `:hover` uses
  `color: var(--text-primary)` (not the prototype's hardcoded `#fff`) so light theme stays legible;
  hover still sets `border-color: var(--accent-ink)`. Document this in the code comment.

### Conversations API + contracts (D5)
`GET /api/conversations?page&limit` → `ConversationsResponse { results: ConversationSummary[],
page, limit, total }`; `ConversationSummary { id, title, createdAt, updatedAt }` (title is
**derived server-side** from the first user message — there is no title column;
`CONVERSATION_TITLE_MAX_LENGTH = 80`). Ordered `updated_at DESC` by the backend. All these Zod
schemas **already exist** in `@share2brain/shared/schemas` (Story 5.2) — do not add shared schemas; add
only the web client. Detail (`GET /api/conversations/:id` → `ConversationDetail.messages`),
`POST /api/chat` (SSE), `SSEFrameSchema`, and `ChatRequestSchema` exist but are **5.4's** concern.

Client template (from `api/documents.ts`):
```ts
import { ConversationsResponseSchema, type ConversationsResponse } from '@share2brain/shared/schemas';
export async function fetchConversations(
  params: { page?: number; limit?: number } = {},
  signal?: AbortSignal,
): Promise<ConversationsResponse> {
  const qs = new URLSearchParams();
  if (params.page) qs.set('page', String(params.page));
  if (params.limit) qs.set('limit', String(params.limit));
  const res = await fetch(`/api/conversations${qs.toString() ? `?${qs}` : ''}`, {
    credentials: 'include', signal,
  });
  if (!res.ok) throw new Error(`GET /api/conversations failed: ${res.status}`);
  return ConversationsResponseSchema.parse(await res.json());
}
```

### E2E harness integration (D6 — Epic 4 retro AI#6, critical path)
- Config: `packages/web/playwright.config.ts` — 2 webServers (test backend `npm run e2e:server -w
  @share2brain/backend` on `:3100`; built SPA `vite preview --port 4173` with
  `SHARE2BRAIN_API_PROXY_TARGET=http://127.0.0.1:3100`), `workers:1`, chromium only,
  `reuseExistingServer:!CI`. Dark theme is forced **inside `loginAs`**, not the config.
- `loginAs(page, code='e2e-member')` (`tests/helpers/session.ts`) drives fake OAuth
  (`/api/auth/login` 302 → extract `state` → `/api/auth/callback?code&state` 302), shares the
  `page.request` cookie jar, and `addInitScript(localStorage 'share2brain-theme'='dark')`. `code` selects
  identity: `e2e-member` (role `e2e-role-member`, sees general/random) or `e2e-empty`. **The chat
  is a floating widget, not a nav item (UX-DR5)** — there is no "Chat" sidebar entry; the spec
  opens the panel via the FAB (`getByTestId('chat-fab').click()` or
  `getByRole('button', { name: /Abrir chat/ })`).
- Seed (`packages/backend/src/e2e/seed.ts`): today seeds only channels/messages/embeddings/user/
  read-status (all `e2e-` prefixed) — **no conversations**. This story adds one seeded conversation
  (+ messages) for `memberId` so the history overlay is populated & assertable. FK-safe reset:
  delete `messages` before `conversations`; keep the `e2e-`/member predicate; never widen it.
- Spec pattern (from `docs.spec.ts`): declare token `rgb(...)` constants at top, assert with
  `expect(locator).toHaveCSS(prop, value)` (auto-retries), locate via `getByTestId`/`getByRole`,
  end with `page.screenshot({ path: testInfo.outputPath('chat-*.png'), fullPage: true })`.
  In the default 1280×720 Desktop-Chrome viewport the panel resolves to exactly
  `width: 404px; height: 642px` (both under their `max-*` clamps) — assert those.

### Testing standards
- Vitest + Testing Library for components (jsdom); AAA + behavior-driven names
  (`should <behavior> when <condition>`). Mock `api/conversations` (`vi.mock('./api/conversations')`)
  in `ChatWidget.test.tsx`, mirroring how `App.test.tsx` mocks the other api modules.
- jsdom does **not** apply external CSS — visual/CSS ACs are **only** truly verified by the
  Playwright spec (Epic 4 lesson: a visual AC is not done until the harness asserts it). Do not
  claim CSS ACs "verified" from unit tests alone.
- Mandatory-steps §3.4: touching the UI requires the E2E run in the gate.

### Project Structure Notes
- New files: `packages/web/src/components/ChatWidget.tsx` (+ `.test.tsx`),
  `packages/web/src/api/conversations.ts` (+ `.test.ts`),
  `packages/web/src/lib/relativeTime.ts` (+ `.test.ts`),
  `packages/web/tests/chat.spec.ts`.
- Modified: `packages/web/src/components/icons.tsx` (4 icons),
  `packages/web/src/components/Hexagon.tsx` (export 2 consts),
  `packages/web/src/App.tsx` (mount sibling), `packages/web/src/styles/components.css` (5 classes),
  `packages/backend/src/e2e/seed.ts` (+ conversation seed), `packages/web/tests/README.md` (spec order).
- Naming: `kh-` class prefix; `PascalCase.tsx` components; Spanish UI copy, English identifiers.
- No new npm deps. No shared-schema change. No DB migration (5.2 tables already exist). No router
  (in-app state; the widget is not a "screen"). No change to `Sidebar`/`Header`/`AppLayout` props.
- AD-3: web imports only `@share2brain/shared/schemas` (browser-safe), never the root barrel.

### References
- [Source: _bmad-output/planning-artifacts/epics.md#Historia 5.3] — story + ACs.
- [Source: _bmad-output/planning-artifacts/epics.md#Requisitos de Diseño UX] — UX-DR5 (floating,
  not nav), UX-DR15 (FAB), UX-DR16 (panel/header), UX-DR17 (history overlay), UX-DR18 (empty state),
  UX-DR23 (kh-pop/kh-pulse).
- [Source: docs/context/design/Share2Brain Web.dc.html:284-348] — pixel-exact FAB/panel/empty/history
  markup (stale `--tx*` tokens; map per §Token mapping).
- [Source: packages/web/src/App.tsx] — auth gate + mount point (sibling after `<AppLayout>`).
- [Source: packages/web/src/components/Hexagon.tsx] — `CLIP_PATH`, `AMBER_GRADIENT`, `EXACT_MIDDLE`.
- [Source: packages/web/src/styles/global.css] — real tokens (both themes), `@keyframes` (all six
  kh-* exist), global reduced-motion block.
- [Source: packages/web/src/styles/components.css:64-68] — inline-border-vs-`:hover` cascade rule.
- [Source: packages/web/src/api/documents.ts] — API client template.
- [Source: packages/shared/src/schemas/conversations.ts] — `ConversationsResponse` /
  `ConversationSummary` shapes (title derived, `CONVERSATION_TITLE_MAX_LENGTH=80`).
- [Source: packages/web/playwright.config.ts, tests/helpers/session.ts, tests/docs.spec.ts,
  packages/backend/src/e2e/seed.ts, server.ts] — harness boot, `loginAs`, seed to extend.
- [Source: _bmad-output/implementation-artifacts/deferred-work.md] — spec discovery-order invariant.
- [Source: _bmad-output/project-context.md] — frontend rules (AD-3 subpath import, static SPA).

## Dev Agent Record

### Agent Model Used

claude-opus-4-8 (bmad-dev-story, 2026-07-07).

### Debug Log References

None — no HALT conditions hit. Red-green flow followed for the two pure/logic
units (`fetchConversations`, `relativeTimeEs`) and behavior for the component;
CSS ACs deferred to the Playwright spec per the Epic 4 lesson (jsdom applies no
external CSS).

### Completion Notes List

- **Shell only, per the scope boundary.** No composer, no bubble rendering, no
  SSE, no execution trace, no citation chips. Selecting a history item or "nueva
  conversación" only mutates panel state (`activeConversationId` + close overlay);
  the message area always shows the empty state in 5.3.
- **Self-contained state (D1).** `chatOpen` / `chatHistoryOpen` /
  `activeConversationId` live inside `ChatWidget`; `App.tsx`'s only change is a
  fragment wrapping `<AppLayout>` + a `<ChatWidget />` sibling (no props). The
  `launcherActive` pulsing-dot markup is present but hard-`false` (5.4 trigger).
- **FAB = single amber hexagon**, not the 3-layer `Hexagon` component: reuses the
  now-exported `CLIP_PATH` / `AMBER_GRADIENT` inline (D4). Header logo + empty-state
  hexagon reuse the `Hexagon` component (`size={32}`/`size={60}`, `showDot={false}`).
- **Token mapping (D2).** All prototype `--tx*` names mapped to the real
  `--text-*` names; the E2E spec asserts the dark-theme `rgb()` values (harness
  forces dark).
- **Cascade rule (Epic 4 AI#4).** Every `:hover`/active border/color/background
  base value lives in `components.css` classes (`.kh-chat-fab`,
  `.kh-chat-header-btn`(+`--danger`), `.kh-chat-suggestion`, `.kh-chat-history-item`),
  never inline — the active history row's amber tint is the one deliberate inline
  state (it must beat `:hover`, mirroring `.kh-nav-item--active`).
- **Deliberate deviation:** suggestion-chip `:hover` color is `var(--text-primary)`
  (not the prototype's hardcoded `#fff`) so light theme stays legible; documented
  in the CSS comment.
- **a11y (AC6):** `Escape` closes the panel; focus moves into the panel (`role="dialog"`,
  `tabIndex=-1`) on open and returns to the FAB on close (guarded by `wasOpenRef`
  so the initial mount never steals focus).
- **E2E seed (AC7):** added one `e2e-`-prefixed conversation (+ user/assistant
  messages, assistant carries a citation) for the member; reset deletes
  `messages` → `conversations` before `users` (FK order), scoped to the `e2e-user-%`
  predicate — never widened. `SeedSummary` + boot log gained a `conversations` count.
- **Spec discovery-order invariant** documented in `tests/README.md`:
  `chat.spec.ts` sorts before `docs.spec.ts` and is read-only, so the docs mutating
  "mark all read" test still runs last.

**Verification gate (AC8) — all green:**

```
npm run lint   → clean (eslint ., 0 errors)
npm run test   → 62 files, 475 passed  (unit + web projects; +31 over the 444 baseline)
npm run build  → clean (backend/bot/shared tsc --noEmit + web vite build 304.28 kB, workers tsc)
npm run test:e2e -w @share2brain/web → 10 passed (chromium); 4 new chat.spec (AC1-5) +
  6 pre-existing (docs/interactions/search) still green, docs mutating test last.
```

**Gate re-run (2026-07-07, after applying the 6 code-review patch findings — see Review Findings):**

```
npm run lint   → clean (eslint ., 0 errors)
npm run test   → 62 files, 484 passed (unit + web projects; +9 over the 475 pre-review baseline)
npm run build  → clean (backend/bot/shared tsc --noEmit + web vite build 304.79 kB, workers tsc)
npm run test:e2e -w @share2brain/web → 10 passed (chromium); chat.spec (AC1-5, using the new
  gotoChat helper for 3 of 4 tests) + 6 pre-existing (docs/interactions/search) still green.
```

**Gate re-run (2026-07-07, after Round 2 — 2 focus-trap regressions found and fixed in the round-1 patches themselves, see Review Findings Round 2):**

```
npm run lint   → clean (eslint ., 0 errors)
npm run test   → 62 files, 486 passed (unit + web projects; +2 over the 484 round-1 baseline)
npm run build  → clean (backend/bot/shared tsc --noEmit + web vite build 304.95 kB, workers tsc)
npm run test:e2e -w @share2brain/web → 10 passed (chromium); unchanged pass count.
```

**Gate re-run (2026-07-07, after Round 3 — 1 more focus-trap gap found in the original round-1 selector and fixed, see Review Findings Round 3):**

```
npm run lint   → clean (eslint ., 0 errors)
npm run test   → 62 files, 488 passed (unit + web projects; +2 over the 486 round-2 baseline)
npm run build  → clean (backend/bot/shared tsc --noEmit + web vite build 304.95 kB, workers tsc)
npm run test:e2e -w @share2brain/web → 10 passed (chromium); unchanged pass count.
```

No new npm deps, no shared-schema change, no DB migration, no router change, no
`Sidebar`/`Header`/`AppLayout` prop change.

### File List

**New:**
- `packages/web/src/components/ChatWidget.tsx`
- `packages/web/src/components/ChatWidget.test.tsx`
- `packages/web/src/api/conversations.ts`
- `packages/web/src/api/conversations.test.ts`
- `packages/web/src/lib/relativeTime.ts`
- `packages/web/src/lib/relativeTime.test.ts`
- `packages/web/tests/chat.spec.ts`

**Modified:**
- `packages/web/src/components/icons.tsx` (ChatIcon, HistoryIcon, PlusIcon, CloseIcon)
- `packages/web/src/components/Hexagon.tsx` (export CLIP_PATH, AMBER_GRADIENT)
- `packages/web/src/App.tsx` (mount `<ChatWidget />` sibling after `<AppLayout>`)
- `packages/web/src/App.test.tsx` (FAB present when authed / absent on login)
- `packages/web/src/styles/components.css` (5 `.kh-chat-*` classes)
- `packages/backend/src/e2e/seed.ts` (+1 seeded conversation, FK-order reset, SeedSummary.conversations)
- `packages/backend/src/e2e/server.ts` (boot log conversations count)
- `packages/web/tests/README.md` (spec discovery-order invariant)

## Change Log

| Date | Change |
|---|---|
| 2026-07-07 | Story 5.3 implemented — chat widget shell (FAB + panel + header + empty state + history overlay). Gate green: lint 0 / 475 unit+web / build clean / 10 e2e chromium. Status → review. |
| 2026-07-07 | Code review (bmad-code-review): 3 adversarial layers, 0 AC violations, 1 decision resolved (focus trap → patch now) + 6 patches applied (focus trap/aria-modal, `relativeTimeEs` NaN guard, nested-Escape overlay-first dismissal, brittle test assertion, missing week/future-timestamp tests, `gotoChat` helper), 4 deferred, 12 dismissed as noise. Gate re-run green: lint 0 / 484 unit+web (+9) / build clean / 10 e2e chromium. Status → done. |
| 2026-07-07 | Code review Round 2 (re-review of the round-1 patches as new code, Epic 3 retro AI#1): Blind Hunter + Edge Case Hunter converged on 2 real regressions in the focus-trap/focus-restore patches themselves — Shift+Tab escaped on the very first press after opening (activeElement was the panel container, not tracked as a boundary), and closing the history overlay dropped focus to `document.body` with no restore, defeating the trap on the next Tab. Both FIXED, with regression tests empirically verified to fail without their fix. 3 more trivial doc/comment patches applied. 1 deferred (`inert` on `AppLayout`, additional hardening outside `ChatWidget.tsx`). 6 dismissed as noise. Gate re-run green: lint 0 / 486 unit+web (+2) / build clean / 10 e2e chromium. |
| 2026-07-07 | Code review Round 3 (re-review of the round-2 patches as new code): found 1 more real, currently-reachable focus-trap gap — the Tab-trap's boundaries could resolve to an empty-state suggestion button hidden behind the history overlay (predates round 2, traced to round-1's `getFocusableElements`). FIXED: the empty-state wrapper now only renders while the overlay is closed. Also added a direct regression test for a theoretical two-effects-race Blind Hunter raised (closing the whole panel while history is open); investigated via React's commit-phase ref-nulling guarantee and confirmed already-correct by construction, not by a code change. 2 patches applied, 0 deferred, 7 dismissed as noise. Gate re-run green: lint 0 / 488 unit+web (+2) / build clean / 10 e2e chromium. Convergence: round 4 not warranted — remaining findings are hypothetical/future-proofing, not reachable bugs. |
