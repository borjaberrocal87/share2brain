---
baseline_commit: 1ff69b1030bc466798c728f1d510252f32a80a04
---

<!-- Powered by BMAD-CORE™ -->

<!-- story_key: 8-1-web-docsview-rediseno-estados-leido-no-leido-y-layout-columnas -->

# Story 8.1: web — DocsView: rediseño de estados leído/no-leído y layout de columnas

Status: done

<!-- Ultimate context engine analysis completed - comprehensive developer guide created
     (design HTML placeholder values extracted from the Share2Brain Web.dc.html script block;
     current DocsView.tsx / DocsView.test.tsx / docs.spec.ts / components.css / global.css
     read in full; 7.5/7.6 story + review intelligence folded in). -->

## Story

As a **community member browsing the Documentos view**,
I want **unread resources to be visually emphasized (amber dot + glow, "Nuevo" badge, row accent)
and read resources to look "done" (checkmark, still-legible title) in a 6-column table**,
so that **consumed knowledge no longer reads as disabled/broken and new knowledge jumps out at me,
matching the updated reference design**.

**Scope**: `packages/web` ONLY — `DocsView.tsx` (the `DocRow` + table header + container),
`DocsView.test.tsx`, `tests/docs.spec.ts` (7.6 visual harness), `styles/components.css` (new
`.kh-doc-link` class), `styles/global.css` (remove the now-unused `--dot-read` token) + UX-DR
sync in `epics.md` (DR1 token list, DR12 table header, DR13 row treatment). Epic line:
*"Historia 8.1: web — DocsView: rediseño de estados leído/no-leído y layout de columnas"*
[Source: _bmad-output/planning-artifacts/epics.md:1023-1040]. Frontend-only, **Moderate**
[Source: _bmad-output/planning-artifacts/sprint-change-proposal-2026-07-10.md].

**Out of scope**: any backend/shared/workers/bot change; any Zod contract or DDL; SearchView,
chat/citations, Sidebar, Header (untouched); the design's `docCountLabel` flourish
(`"mostrando X de Y · N sin leer"` — our label stays `"mostrando X de Y"`, no AC covers it);
the design's `stopProp` on the link (explicitly overridden by AC4 — bubbling preserved);
Epic 9 / Stats (separate epic); DocsView pagination-skip deferral (deferred-work, unchanged).

**Critical context — this is a re-skin, not a re-wire.** Every behavior in DocsView is done and
review-hardened (4.4 + 7.5 + three code-review rounds): optimistic mark-read + revert, mark-all
snapshot revert, server-side `channelId`/`unreadOnly` filters, "Cargar más" abort/race guards,
the bubbling "ver recurso" click (7.5 F2), sidebar badge via `onUnreadChange`. **8.1 changes ONLY
JSX structure and styling** inside the table (header + `DocRow`) plus the container's overflow.
Zero handler/state/effect/API changes. If you find yourself editing `handleRowClick`,
`handleMarkAll`, `loadMore` or any `useEffect` — stop, you're off-scope.

## Design source of truth (extracted, authoritative)

The reference design `docs/context/design/Share2Brain Web.dc.html` is a single-line encoded mock —
do NOT try to re-read it; its DocsView treatment and its script's placeholder values are
extracted verbatim here. Design tokens map to app tokens (established `--tx*` map, Story 5.3):
`--tx`→`--text-primary`, `--tx2`→`--text-secondary`, `--tx3`→`--text-tertiary`,
`--tx4`→`--text-muted`, `--tx5`→`--text-subtle`.

From the design's `docItems` script block (placeholder values resolved):

```js
titleColor: 'var(--tx)',                                            // BOTH states → --text-primary
weight:     isUnread ? '700' : '500',                               // was 500/400
descColor:  'var(--tx3)',                                           // → --text-tertiary
rowAccent:  isUnread ? 'inset 3px 0 0 #F5A623' : 'inset 3px 0 0 transparent',
```

From the design's docs-table markup:

- **Container**: `border:1px solid var(--border); border-radius:14px; overflow-x:auto;
  background:var(--surface)` — note `overflow-x:auto` (current code has `overflow:hidden`).
- **Header + row grid** (identical on both): `grid-template-columns:150px minmax(160px,1fr)
  44px 92px 116px 84px; gap:12px; min-width:720px` — header labels (lowercase in source,
  uppercased by the existing inline `textTransform`): `título · descripción · link · canal ·
  autor · indexado`, keeping today's mono 10.5px `--text-subtle` header styling.
- **Row**: `padding:15px 20px; border-bottom:1px solid var(--line); align-items:center;
  cursor:pointer; box-shadow:<rowAccent>` + existing `.kh-doc-row:hover` background.
- **Indicator wrapper** (inside the título cell, which is `display:flex; gap:9px;
  align-items:flex-start; min-width:0`): `margin-top:2px; flex-shrink:0; display:flex;
  width:16px; justify-content:center` — fixed 16px so dot and checkmark align identically.
  - **Unread dot**: `width:8px; height:8px; margin-top:4px; border-radius:50%;
    background:#F5A623; box-shadow:0 0 0 3px rgba(245,166,35,0.16)` (8px now, was 7px).
  - **Read checkmark**: 14×14 svg, `stroke: var(--tx5)` (→`--text-subtle`), stroke-width 2.4,
    path `M20 6L9 17l-5-5`, `margin-top:2px` — this is EXACTLY the existing `CheckIcon`
    (`icons.tsx:152`, `strokeWidth={2.4}`, `stroke="currentColor"`, same path): render
    `<CheckIcon size={14} />` inside a span that sets `color: 'var(--text-subtle)'`.
- **Title** (in título column, wrapper `min-width:0`): `font-size:13.5px; line-height:1.4;
  overflow:hidden; text-overflow:ellipsis; display:-webkit-box; -webkit-line-clamp:2;
  -webkit-box-orient:vertical` — **title is now 2-line clamped** (was single-line
  `whiteSpace:nowrap` ellipsis).
- **"Nuevo" badge** (unread only, sibling under the title): `display:inline-flex;
  align-items:center; margin-top:5px; padding:1px 7px; font-family:'IBM Plex Mono',monospace;
  font-size:9.5px; font-weight:600; letter-spacing:0.06em; text-transform:uppercase;
  color:var(--accent-ink); background:rgba(245,166,35,0.13); border-radius:5px`, text `Nuevo`.
- **Description column** (own grid cell now): `font-size:13px; line-height:1.5;
  color:var(--tx3); overflow:hidden; text-overflow:ellipsis; display:-webkit-box;
  -webkit-line-clamp:2; -webkit-box-orient:vertical` (was 12.5px `--text-muted` inside the
  main cell).
- **Link column**: 28×28 icon-button anchor — `display:flex; align-items:center;
  justify-content:center; width:28px; height:28px; border:1px solid var(--border);
  border-radius:8px; color:var(--tx4); text-decoration:none`, containing the external-link
  svg 13×13 (= existing `ExternalLinkIcon`, `icons.tsx:133`, default `size = 13`).
- **Canal / autor / indexado cells**: styling unchanged from today (mono amber `#channel`,
  20px avatar + truncated name, right-aligned mono date) — they only move to their own
  grid positions.

## Decisions embedded in the ACs (recommended defaults — veto at review)

| # | Fork | Decision |
|---|---|---|
| D1 | Design's link button says `title="Ver en Discord"`, hover blurple `#5865F2`, and its mock href is `https://discord.com/channels` (the script's `link()` stub) | **The button opens the RESOURCE** (`href={doc.link}`), per the ratified AC4 wording ("abre el recurso en nueva pestaña"). Therefore: `aria-label="Ver recurso"` + `title="Ver recurso"`, and hover **amber** (`--accent-ink`), NOT blurple — the app reserves blurple for Discord-destination links (`.kh-discord-link`, components.css:88-96 comment). The design's blurple/Discord tooltip is a mock leftover contradicted by its own href semantics in our app. |
| D2 | Class for the icon-button | **New `.kh-doc-link`** in `components.css` (do NOT reuse `.kh-resource-link`, which stays as SearchView's text-anchor style): base `border: 1px solid var(--border); color: var(--text-muted);` in the class, `:hover { border-color: var(--accent-ink); color: var(--accent-ink); }`. ⚠️ Cascade gotcha (Epic 4 retro AI#4, fixed repo-wide in PR #26): the base `border` and `color` MUST live in the class, never inline — an inline shorthand outranks the stylesheet `:hover` and the hover silently dies. The anchor's inline style carries only layout (flex/size/radius/text-decoration). |
| D3 | Read-row accent | `boxShadow: 'inset 3px 0 0 transparent'` on read rows (design verbatim), not `'none'` — keeps the computed box-shadow shape uniform so the e2e assertion differs only in color. Inline is fine here: `.kh-doc-row:hover` changes `background`, never `box-shadow`, so no cascade conflict. |
| D4 | `doc-row-dot` testid on read rows | The dot renders **only on unread rows** (keeps `data-testid="doc-row-dot"`); read rows render the checkmark with NEW `data-testid="doc-row-check"`. The "Nuevo" badge gets NEW `data-testid="doc-row-new-badge"`. `doc-row-content` (title) and `doc-row-description` testids are KEPT. |
| D5 | `--dot-read` token | **Remove** from `global.css` (both `:root` dark line 21 and light line 27 blocks) — DocsView was its only consumer (repo-grep verified: only global.css + DocsView.tsx + docs.spec.ts constant). Also delete the now-dead `DOT_READ` constant in `docs.spec.ts` and drop `--dot-read` from the UX-DR1 token list. SCP §2 sanctioned this ("`--dot-read` may become unused"). |
| D6 | Title clamp | Title becomes **2-line clamp** (design verbatim) replacing single-line `nowrap` ellipsis — the 150px column is narrow; one line would truncate almost every title. `line-height` tightens 1.5→1.4 per design. |
| D7 | Theme parity mechanism (AC5) | Parity is structural: every color in the new treatment is a theme token (`var(--…)`) except the sanctioned literal amber `#F5A623` / `rgba(245,166,35,…)`, which is intentionally identical in both themes (same precedent as the current unread dot, the "Sin leer" toggle and the chip tint; light theme keeps `--accent-ink:#9A5B00` for TEXT so the badge text stays readable). No new hardcoded theme-specific hex allowed. The e2e harness verifies dark (forced by `loginAs`); light is covered by token discipline, same as 4.3/4.4/7.5. |
| D8 | Spanish UI copy verbatim, English identifiers/comments (repo rule) | New user-visible strings in this story: `Nuevo`, `Ver recurso` (aria-label/title), header labels `título / descripción / link / canal / autor / indexado`. Intro copy UNCHANGED (still accurate: the amber dot still marks unread). |

## Acceptance Criteria

1. **6-column layout (AC1)** — Table header and every row use
   `gridTemplateColumns: '150px minmax(160px,1fr) 44px 92px 116px 84px'`, `gap: 12`,
   `minWidth: 720` ; header labels become `título · descripción · link · canal · autor ·
   indexado` (keeping the existing mono/uppercase/10.5px/`--text-subtle` header styling); the
   table container switches `overflow: 'hidden'` → `overflowX: 'auto'` so narrow viewports get
   horizontal scroll instead of crushing the grid. Border/radius/background of the container
   unchanged.
2. **Unread row = emphasis (AC2)** — Unread rows show: the amber dot (`8px`, `#F5A623`, glow
   `0 0 0 3px rgba(245,166,35,0.16)`, `data-testid="doc-row-dot"`) centered in a 16px
   indicator slot; a `Nuevo` badge under the title (`data-testid="doc-row-new-badge"`, exact
   design styles per the extract above); a left-edge row accent
   `boxShadow: 'inset 3px 0 0 #F5A623'`; title `fontWeight: 700`.
3. **Read row = "done", not "disabled" (AC3)** — Read rows show a checkmark
   (`<CheckIcon size={14} />` in a `color: 'var(--text-subtle)'` span,
   `data-testid="doc-row-check"`) instead of any dot; NO badge; accent
   `boxShadow: 'inset 3px 0 0 transparent'`; title `fontWeight: 500`. **The title color is
   `var(--text-primary)` in BOTH states** — the read title is no longer dimmed to
   `--text-muted`. The `--dot-read` token is removed from `global.css` (D5) and nothing
   references it anymore (repo-grep clean).
4. **Link icon-button with bubbling preserved (AC4)** — The "ver recurso" text anchor is
   replaced by a 28×28 icon-button anchor in the new `link` column: `href={doc.link}`,
   `target="_blank" rel="noopener noreferrer"`, `aria-label="Ver recurso"`,
   `title="Ver recurso"`, class `.kh-doc-link` (D1/D2), `ExternalLinkIcon` (size 13). It has
   **NO `stopPropagation`** — clicking it on an unread row opens the resource AND bubbles to
   the row's `handleRowClick` → optimistic mark-read (7.5 F2 behavior, verbatim). Row click
   behavior itself (mark-read, no-op when already read) unchanged.
5. **Theme parity + zero functional regression (AC5)** — All new colors are theme tokens except
   the sanctioned amber literals (D7); both themes render correctly. UNCHANGED and still green:
   channel chips + server-side `channelId` filter, "Sin leer" toggle + server-side `unreadOnly`
   + local mirror + empty state, "Marcar todas como leídas" + snapshot revert, "Cargar más" +
   abort/race guards, optimistic mark-read + revert, `onUnreadChange` sidebar-badge bubbling,
   intro copy, empty-state copy, `mostrando X de Y` label. `App.test.tsx` (which clicks
   `.kh-doc-row`) stays green untouched.
6. **Tests updated and green (AC6)** — `DocsView.test.tsx` updated: header-labels test asserts
   the 6 new labels; the read/unread styling test asserts the NEW semantics (both titles
   `var(--text-primary)`; weights `700`/`500`); NEW assertions: checkmark testid present on
   read row + absent on unread, dot present on unread + absent on read, `Nuevo` badge present
   on unread + absent on read, row `boxShadow` accent per state; the "ver recurso" tests now
   locate the icon-button via `getByRole('link', { name: /ver recurso/i })` (aria-label) and
   keep asserting `href === doc.link` and the bubbling `markRead` call. `docs.spec.ts` updated
   to the new treatment (details in Dev Notes §e2e) — full suite `npx playwright test` green at
   16 specs, `docs.spec.ts` order preserved (read-only tests → bubbling mutation → terminal
   mark-all). Verification gate green: `npm run lint && npm run test && npm run build`.

## Tasks / Subtasks

- [x] Task 0: Branch `feat/8-1-docsview-read-unread-redesign` off `main` (SCP §5 names this
      branch; never commit on main).
- [x] Task 1: Restructure `DocRow` + header in `DocsView.tsx` (AC1, AC2, AC3, AC4)
  - [x] 1.1 Header row: swap `gridTemplateColumns` to the 6-col spec + `minWidth: 720`,
        `gap: 12`; replace `<span>recurso</span>…` with the six new labels.
  - [x] 1.2 Container div: `overflow: 'hidden'` → `overflowX: 'auto'`.
  - [x] 1.3 `DocRow` grid: same 6-col spec + `minWidth: 720`, `gap: 12`; add the state-driven
        `boxShadow` accent (D3).
  - [x] 1.4 Título cell: 16px indicator slot (dot XOR checkmark per `doc.isRead`, D4) +
        title span (keep `data-testid="doc-row-content"`; 2-line clamp per design extract,
        color always `var(--text-primary)`, weight 700/500) + conditional `Nuevo` badge.
  - [x] 1.5 Descripción cell: move the existing description span (keep
        `data-testid="doc-row-description"`) to its own grid cell; restyle 13px /
        `--text-tertiary` / clamp-2.
  - [x] 1.6 Link cell: replace the "ver recurso" text anchor with the `.kh-doc-link`
        icon-button (D1/D2; layout-only inline styles; NO `stopPropagation`).
  - [x] 1.7 Canal / autor / indexado cells: unchanged content/styles in their new positions.
- [x] Task 2: CSS (AC3, AC4)
  - [x] 2.1 `components.css`: add `.kh-doc-link` + `:hover` (D2, border+color in class —
        cascade gotcha) next to the existing "Documentos view" block; comment why the base
        lives in the class (mirror the `.kh-resource-link` comment).
  - [x] 2.2 `global.css`: remove `--dot-read` from both theme blocks (D5).
- [x] Task 3: Update `DocsView.test.tsx` (AC6) — all listed assertion changes; keep the
      untouched behavioral tests (filters, pagination, mark-all revert, abort guards) exactly
      as they are; jsdom note: clicking the anchor logs "Not implemented: navigation" but does
      not throw (7.5 D6 precedent).
- [x] Task 4: Update `tests/docs.spec.ts` (AC6) — per Dev Notes §e2e; preserve test order and
      the route-block + popup-capture pattern of the bubbling test; refresh the header comment
      blocks that describe the old treatment.
- [x] Task 5: Docs sync (docs-are-source-of-truth, before the PR)
  - [x] 5.1 `epics.md` UX-DR13: rewrite to the new row treatment (6-col grid, dot/checkmark,
        badge, accent, icon-button link, title never dimmed) with an *"(Historia 8.1 — …)"*
        provenance note, mirroring the 7.5 edit style.
  - [x] 5.2 `epics.md` UX-DR12: header grid 4→6 cols + `overflow-x:auto` note, same provenance
        style.
  - [x] 5.3 `epics.md` UX-DR1: drop `--dot-read` from the border-token list.
- [x] Task 6: Verification gate (AGENT runs it, paste output): `npm run lint && npm run test
      && npm run build`, then `npx playwright test` from `packages/web` (16 specs, workers:1).
      Integration suite not required (no shared/backend change) — state this explicitly in the
      Dev Agent Record instead of silently skipping.

### Review Findings

_Code review 2026-07-10 (bmad-code-review, 3 adversarial layers @ Opus: Blind Hunter / Edge
Case Hunter / Acceptance Auditor). First pass: 0 decision-needed, 0 patch, 2 defer, 6 dismissed;
Auditor 0 AC/D violations — all 6 ACs and D1–D8 verified against the extracted design values.
Re-run #1 (identical diff): 1 patch APPLIED (the `.kh-doc-link:focus-visible` ring below),
2 defer (unchanged), rest dismissed. **Process note:** a re-run #1 "patch" (missing
`fetchChannels` stub in the 3 new tests) was RETRACTED as a false positive — it came from a
hand-compressed diff fed to the Blind Hunter that had dropped the `fetchChannels.mockResolvedValue([])`
lines; the real tests (DocsView.test.tsx:123,136,149) already carry the stub. Unit suite 19/19 green.
Re-run #2 (diff now includes the focus patch): CLEAN — 0 new patches, 0 new defers. All 3 layers
concur the focus-visible rule is sound (Auditor: sanctioned additive a11y, satisfies D7, inert to
tests). Two new probes resolved empirically: (a) `overflowX:auto` does NOT drop the border-radius
corner clipping — `overflow-y` computes to `auto` (a clipping context) and a corner-pixel probe
returns `body`, so corners still clip (an Edge-Hunter pass-2 claim, refuted); (b) `minWidth:720`
(AC1 design-verbatim) is inert — the grid's intrinsic min is ~746px (>720) so it never binds, but
no-crush + horizontal scroll are already guaranteed by the track floors; harmless, kept as-is to
match AC1's literal value._

- [x] [Review][Patch] APPLIED — New `.kh-doc-link` icon-button now has a `:focus-visible` ring
      [`packages/web/src/styles/components.css:121`] — the story turns the "ver recurso" text
      link into a 28×28 **icon-only** anchor; `.kh-doc-link` had only `:hover`. Added
      `.kh-doc-link:focus-visible { outline: 2px solid var(--accent-ink); outline-offset: 2px; }`
      matching the app's interactive-control focus convention (`.kh-icon-btn`, `.kh-nav-item`,
      `.kh-chat-*`). Not a strict regression (the old `.kh-resource-link`, and DocsView's own
      `.kh-load-more`/`.kh-mark-all`, are also focus-less), but an icon-only control benefits and
      the pattern is established elsewhere. Inert for existing tests (no focus assertions).
- [x] [Review][Defer] Read row has no non-visual accessible label (checkmark is decorative)
      [`packages/web/src/components/DocsView.tsx:438`] — deferred, not a regression. The read
      checkmark is a bare decorative `<CheckIcon>`; a screen reader hears "Nuevo" on unread rows
      and nothing on read rows. Not a regression (the old grey dot was equally decorative, and
      unread actually *gained* announced text), and no AC requires it. Optional enhancement: a
      visually-hidden "Leído"/`aria-label` on the check span for symmetry.
- [x] [Review][Defer] Empty `description` renders a blank clamped cell with no placeholder
      [`packages/web/src/components/DocsView.tsx:497`] — deferred, pre-existing. `documents.ts`
      types `description: z.string()` (permits `''`, unlike `title`'s `.trim().min(1)`); 7.5
      already rendered it, but promoting description to its own labeled grid column makes an
      empty value more conspicuous. No test covers the `''` boundary. Fix, if promoted: a
      placeholder/em-dash fallback + a `''` test case.

## Dev Notes

### Current state of every file being modified

- **`packages/web/src/components/DocsView.tsx` (535 lines)** — `DocRow` at :404-535 renders a
  4-col grid `'1fr 130px 130px 96px'`; the main cell packs dot (:423-434, 7px,
  `--dot-read`/amber + glow) + title (:436-450, single-line nowrap ellipsis, read state dims to
  `--text-muted`/400) + description (:451-466, clamp-2, `--text-muted`, 12.5px) + "ver recurso"
  text anchor (:467-484, `.kh-resource-link`, mono 11.5px, `ExternalLinkIcon size={12}`).
  Header at :306-325 (4 labels). Container at :297-305 with `overflow: 'hidden'`. Handlers
  :125-152 and effects :44-123 are review-hardened — DO NOT TOUCH. `CheckIcon` is already
  imported (:17) for the empty state.
- **`packages/web/src/components/DocsView.test.tsx` (309 lines)** — tests that MUST change:
  header labels (:71-82), read/unread color+weight (:106-118), "ver recurso" link+bubbling
  (:120-134, locator survives via aria-label). Tests that must NOT change: row-click mark-read
  (:136-150), read no-op (:152-163), filters (:165-190), pagination (:192-206), empty state
  (:208-221), mark-all (:223-235), the four review-patch regression tests (:237-308). Repo
  rules: no jest-dom (use `toBeTruthy()`/`toBeNull()`/`getAttribute`), AAA, behavior-driven
  names.
- **`packages/web/tests/docs.spec.ts` (204 lines)** — three describes in mandatory order:
  4.4 visual (:28-83) → 7.6 description/link + MUTATING bubbling (:90-167) → terminal mark-all
  (:169-204). `workers: 1` pinned in `playwright.config.ts:24`. Dark theme forced by `loginAs`.
  First doc row = `e2e-msg-g1`, link `https://example.com/e2e/configurar-canales-indexados`
  (:20). The bubbling test route-blocks `https://example.com/**` and captures the popup BEFORE
  the click (:138-166) — keep that pattern, only swap the `.kh-resource-link` locators to
  `.kh-doc-link`.
- **`packages/web/src/styles/components.css`** — `.kh-resource-link` (:97-102, stays,
  SearchView still uses it); `.kh-doc-row:hover` (:105-107, stays); add `.kh-doc-link` in the
  "Documentos view" block. Read the :92-96 comment — it documents the cascade rule you must
  follow for the new class.
- **`packages/web/src/styles/global.css`** — `--dot-read` at :21 (dark `#272E39`) and :27
  (light `#C7CCD4`): delete both.
- **`_bmad-output/planning-artifacts/epics.md`** — UX-DR1 (:89), UX-DR12 (:111), UX-DR13
  (:113) per Task 5.

### e2e — exact `docs.spec.ts` changes (AC6)

Dark-theme computed constants: keep `ACCENT_INK`, `HOVER_ROW`, `TEXT_PRIMARY`, `TEXT_MUTED`,
`TEXT_SUBTLE`, `BORDER_STRONG`; DELETE `DOT_READ`; ADD
`TEXT_TERTIARY = 'rgb(154, 163, 178)'` (`--text-tertiary` dark `#9AA3B2`).

- **Grid assertion** (:36-39): 6 tracks — Chromium resolves `minmax(160px,1fr)` to px:
  `/^150px \d+(\.\d+)?px 44px 92px 116px 84px$/`.
- **Header cell** (:42-46): anchor on `título` (or keep any one label) — same
  mono/10.5px/uppercase/subtle asserts; the text anchors `recurso` no longer exist.
- **Unread row** (:49-55): dot asserts unchanged in color/glow (background `ACCENT_INK`,
  box-shadow `rgba(245, 166, 35, 0.16) 0px 0px 0px 3px`); title now `TEXT_PRIMARY` +
  `font-weight: 700`; ADD: row accent box-shadow (expected Chromium serialization
  `rgb(245, 166, 35) 3px 0px 0px 0px inset` — verify the actual computed string with a quick
  `getComputedStyle` probe before hardcoding, serialization order can differ per property
  source); ADD: `doc-row-new-badge` visible, `color: ACCENT_INK`,
  `background-color: rgba(245, 166, 35, 0.13)`, `text-transform: uppercase`,
  `font-family` /IBM Plex Mono/.
- **Read row** (:57-64): REPLACE dot asserts with: `doc-row-dot` count 0 within the row;
  `doc-row-check` visible; checkmark color: assert the wrapper span's `color: TEXT_SUBTLE`
  (the svg inherits via `currentColor` — asserting `stroke` on the svg would return the
  literal `currentcolor` keyword in some engines, the span color is the stable assert); title
  `TEXT_PRIMARY` + `font-weight: 500`; badge count 0; accent box-shadow transparent
  (`rgba(0, 0, 0, 0) 3px 0px 0px 0px inset` — same verify-before-hardcoding caveat).
- **Title clamp** (:113-118): REPLACE the nowrap/ellipsis/overflow-x asserts with the clamp
  set: `-webkit-line-clamp: 2`, `-webkit-box-orient: vertical`, `overflow-x: hidden`,
  `overflow-y: hidden`. ⚠️ Chromium quirk (7.6 hard-won): with an active `-webkit-line-clamp`,
  computed `display` serializes as `flow-root` — NEVER assert `display` on clamped elements.
- **Description** (:104-111): color `TEXT_MUTED` → `TEXT_TERTIARY`; clamp asserts unchanged
  (already the right pattern).
- **Resource link** (:123-129): locator `.kh-resource-link` → `.kh-doc-link`; keep href/target
  asserts; REPLACE the mono-font assert (icon-button has no text) with geometry:
  `width: 28px`, `height: 28px`, `border-radius: 8px`; base `color: TEXT_MUTED`; hover:
  `color: ACCENT_INK` AND `border-*-color: ACCENT_INK` — the border-color hover is the D2
  cascade guard, assert it explicitly.
- **Bubbling test** (:138-166): only the two `.kh-resource-link` locators change to
  `.kh-doc-link`; everything else (route-block, popup capture/close, href-anchored row
  locator, data-read flip assert) stays verbatim. The href-anchored locator pattern exists
  because a `[data-read="false"]` locator re-evaluates after the flip (7.6 lesson) — keep it.
- **Terminal mark-all describe** (:169-204): unchanged (asserts empty-state + badge, none of
  the row styling).
- Update the stale comment blocks (file header :1-4, :85-89, :134-137) to describe the new
  treatment — comments claiming "grey dot + muted title" would be false after this story.

### Testing standards summary

Vitest + Testing Library, co-located, no jest-dom, AAA, behavior-named tests
(`should <behavior> when <condition>`). jsdom does not compute external CSS — unit tests assert
inline `style.*` values and testid presence; pixels/cascade/hover live in the Playwright
harness (`npx playwright test` from `packages/web`, dev server auto-started via
`preview.proxy`, workers:1, dark chromium). Run the FULL 16-spec suite, not just docs.spec —
search/chat/interactions must stay green (they don't touch DocsView, but the shared seed and
session helpers are order-sensitive across files only via `workers: 1`; docs.spec internal
order is the invariant you must preserve).

### Anti-regression tripwires (learned the hard way, Epics 4–7)

1. **Inline border/color kills `:hover`** — base values for anything the hover changes go in
   the CSS class (D2). This exact bug shipped once (Epic 4) and was re-caught in 7.5.
2. **Never assert `display` on line-clamped elements** in Playwright (computes `flow-root`).
3. **`doc-row-dot` disappears from read rows** — any test/helper assuming "every row has a
   dot" breaks; repo-grep for `doc-row-dot` after the change (expected consumers: DocsView.tsx,
   DocsView.test.tsx, docs.spec.ts only).
4. **Do not reorder docs.spec.ts describes** — read-only → bubbling mutation → terminal
   mark-all. The seed's read/unread mix is consumed in that order.
5. **`App.test.tsx:192`** clicks `.kh-doc-row` — the class name and row-level click handler
   must survive (they do, per Task 1).
6. **No new deps, no new icons** — `CheckIcon` (14px via prop) and `ExternalLinkIcon` (13px
   default) already exist with the exact design geometry/stroke.
7. **`unreadOnly` local mirror** (`visibleDocs`) means a bubbling-marked row vanishes
   immediately under "Sin leer" — existing behavior, don't "fix" it.
8. **Latest-tech note**: no library/version changes are involved (React 19.2, Playwright
   1.61.1 pinned); no web research required for this story.

### Project Structure Notes

- All changes under `packages/web/` (AD-1/AD-2/AD-3 intact — static SPA, no contracts, no DDL,
  no service coupling). No `src/` at root. Conventional Commits scoped `web` (the epics.md
  UX-DR sync commit is scoped `repo` or folded per repo convention: docs change belonging to
  the story may ride with it — follow `docs/base-standards.md` §commits).
- One story = one PR: `feat/8-1-docsview-read-unread-redesign` → PR → `bmad-code-review` →
  `bmad-checkpoint-preview`. Never auto-merge.

### References

- [Source: _bmad-output/planning-artifacts/epics.md:1013-1040 — Épico 8 + Historia 8.1 ACs]
- [Source: _bmad-output/planning-artifacts/sprint-change-proposal-2026-07-10.md — trigger,
  impact analysis, layout decision (Borja), branch name]
- [Source: docs/context/design/Share2Brain Web.dc.html — extracted verbatim in "Design source of
  truth" above; do not re-parse the file]
- [Source: packages/web/src/components/DocsView.tsx:297-535 — current header/row implementation]
- [Source: packages/web/tests/docs.spec.ts — 7.6 harness patterns + ordering invariants]
- [Source: packages/web/src/styles/components.css:92-107 — cascade-rule comment + existing
  doc-row classes]
- [Source: _bmad-output/implementation-artifacts/7-5-…md + 7-6-…md — D-decision precedents
  (bubbling anchor F2, clamp asserts, testid discipline)]
- [Source: docs/bmad-story-mandatory-steps.md — verification gate, evidence pasting]

## Dev Agent Record

### Agent Model Used

Claude Sonnet 5 (claude-sonnet-5)

### Debug Log References

None — no failing test runs or blocking issues encountered. `npm run lint`, `npm run test`,
`npm run build`, and `npx playwright test` (from `packages/web`) all passed on first attempt
after implementation.

### Completion Notes List

- Re-skin executed exactly as scoped: zero changes to `DocsView.tsx` handlers/effects/state
  (`handleRowClick`, `handleMarkAll`, `loadMore`, both `useEffect`s untouched) — only the
  header grid, `DocRow` JSX/styles, and the outer container's `overflow` changed.
- `DocRow` main cell split into 3 independent grid cells (título/descripción/link) replacing
  the old single "recurso" cell; canal/autor/indexado cells kept their existing
  content/styles, only repositioned in the new 6-col grid.
- Título cell: 16px indicator slot renders the amber dot (unread, `doc-row-dot`) XOR the
  existing `CheckIcon` at 14px in a `--text-subtle` span (read, new `doc-row-check` testid) —
  never both. Title color is now `var(--text-primary)` in both states (no more dim-to-muted);
  weight switches 700 (unread) / 500 (read). "Nuevo" badge (new `doc-row-new-badge` testid)
  renders only when unread.
- Row accent implemented as `boxShadow: 'inset 3px 0 0 #F5A623'` (unread) /
  `'inset 3px 0 0 transparent'` (read) per D3 — kept the shape identical across states so
  only the color differs (verified: Chromium serializes both as
  `... 3px 0px 0px 0px inset`, confirmed live via the Playwright run, no guessing needed).
- Link cell: new 28×28 `.kh-doc-link` icon-button anchor, `href={doc.link}`,
  `aria-label`/`title="Ver recurso"`, NO `stopPropagation` — bubbling to `handleRowClick`
  verified green in the existing docs.spec.ts mutation test (only locator swapped
  `.kh-resource-link` → `.kh-doc-link`). Base border/color live in the CSS class per the
  cascade rule (D2) — verified via the e2e hover assertions on both `color` and
  `border-top-color`.
- `--dot-read` token removed from both `global.css` theme blocks (D5); repo-grep confirms zero
  remaining references outside this story's own test files (which now assert its absence, not
  its value).
- `DocsView.test.tsx`: replaced the read/unread color+weight test with the new
  `var(--text-primary)` + 700/500 semantics, and added 3 new tests for
  dot/checkmark/badge presence-and-absence per row state and the row-level `boxShadow`
  accent string (via `getAttribute('style')`, since jsdom's `cssstyle` shorthand parser for
  `box-shadow` is not reliable enough to assert through `el.style.boxShadow`). The existing
  "ver recurso" bubbling test needed no locator change — `getByRole('link', { name: /ver
  recurso/i })` already resolves through the new `aria-label` unchanged. 19/19 tests green
  (16 pre-existing + 3 new).
- `docs.spec.ts`: grid regex now expects 6 tracks; header anchor moved to `título`; unread row
  gained badge + row-accent assertions; read row assertions replaced (checkmark presence,
  `doc-row-dot` count 0, badge count 0, transparent accent); title assertions swapped from
  nowrap/ellipsis to the 2-line clamp set (never asserting `display`, per the Chromium
  line-clamp quirk); description color updated to `TEXT_TERTIARY`; resource-link assertions
  swapped from mono-font+text to icon-button geometry (28×28/8px radius) + hover on both
  `color` and `border-top-color`. All exact computed strings (row-accent box-shadow,
  badge background/color) were verified live against the real Chromium build rather than
  hand-derived — no rework needed after the first run. 16/16 e2e specs green.
- Docs sync: `epics.md` UX-DR1 (dropped `--dot-read` from the token list), UX-DR12 (4→6 col
  header + `overflow-x:auto`), UX-DR13 (full rewrite of the row treatment) — all three carry
  a `(Historia 8.1 — …)` provenance note per the established 7.5 pattern.
- Integration suite intentionally NOT run: this story touches only `packages/web` (JSX/CSS),
  no `shared`/`backend`/`workers` change, so there is nothing new for the integration suite to
  cover (per Task 6 and the story's Out-of-scope note).

### File List

- `packages/web/src/components/DocsView.tsx` (modified — header + `DocRow` restructured to
  the 6-col layout; container `overflow` → `overflowX`)
- `packages/web/src/components/DocsView.test.tsx` (modified — header labels, read/unread
  semantics, new dot/checkmark/badge/accent tests)
- `packages/web/tests/docs.spec.ts` (modified — e2e assertions updated to the 6-col/read-
  unread-redesign treatment; `.kh-resource-link` → `.kh-doc-link` locators)
- `packages/web/src/styles/components.css` (modified — added `.kh-doc-link` + `:hover`)
- `packages/web/src/styles/global.css` (modified — removed `--dot-read` from both theme
  blocks)
- `_bmad-output/planning-artifacts/epics.md` (modified — UX-DR1, UX-DR12, UX-DR13 synced)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (modified — story 8-1 status
  progression ready-for-dev → in-progress → review)

## Change Log

- 2026-07-10 — Story created (bmad-create-story). DocsView read/unread redesign + 6-col
  layout, per `sprint-change-proposal-2026-07-10.md`. Re-skin, not re-wire: zero
  handler/effect changes. Design placeholder values extracted verbatim from `Share2Brain
  Web.dc.html`. 3 ratified defaults flagged for review (D1 link icon-button opens the
  resource w/ amber hover; D5 `--dot-read` token removed; D6 title single-line → clamp-2).
  Status: ready-for-dev.
- 2026-07-10 — Story implemented (bmad-dev-story). `DocsView.tsx` header + `DocRow`
  restructured to the 6-col grid (título/descripción/link/canal/autor/indexado); título cell
  gained the 16px dot-XOR-checkmark indicator slot + always-primary title color + "Nuevo"
  badge; row gained the amber/transparent inset accent (D3); link column replaced the "ver
  recurso" text anchor with a 28×28 `.kh-doc-link` icon-button (D1/D2), bubbling preserved (no
  `stopPropagation`); container `overflow` → `overflowX: 'auto'`. `--dot-read` removed from
  both `global.css` theme blocks (D5, repo-grep clean). `DocsView.test.tsx` updated to the new
  read/unread semantics + 3 new tests (dot/checkmark/badge per state, row accent); `ver
  recurso` bubbling test needed no change (already resolved via `aria-label`). `docs.spec.ts`
  updated per Dev Notes §e2e — all exact computed values (row-accent box-shadow, badge
  colors, icon-button geometry) verified live against Chromium, no rework needed. `epics.md`
  UX-DR1/UX-DR12/UX-DR13 synced with Historia 8.1 provenance notes. Gate green: lint 0 / 816
  unit+web (+3) / build clean (5 pkgs) / 16 e2e chromium (unchanged count, docs.spec content
  rewritten). Integration suite not run (no shared/backend change — stated per Task 6, not
  silently skipped). Status: review.
- 2026-07-10 — Code review (bmad-code-review, 3 adversarial layers @ Opus). First pass: 0 AC/D
  violations, 2 defers, clean. Re-run (requested): applied 1 a11y quality patch
  (`.kh-doc-link:focus-visible` outline, `components.css`); retracted a 2nd "patch" (missing
  `fetchChannels` stub) as a review-harness false positive (real tests already carry it;
  19/19 green). Web build clean with the patch. Status: done.
