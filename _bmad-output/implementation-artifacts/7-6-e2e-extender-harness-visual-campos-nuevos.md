---
baseline_commit: a0841cac10e46fb0cba1f1bd05bce67b77a65445
---

<!-- Powered by BMAD-CORE™ -->

<!-- story_key: 7-6-e2e-extender-harness-visual-campos-nuevos -->

# Story 7.6: e2e — Extender el harness visual (Playwright) a los campos nuevos de recurso

Status: done

<!-- Ultimate context engine analysis completed - comprehensive developer guide created
     (deep-dive: Playwright harness current-state + 7.5 rendered elements + e2e seed +
     4.5 harness conventions + prior-story visual-AC discipline from Epic 4/5 retros). -->

## Story

As a **maintainer trusting the Epic 7 pivot is actually visible to members**,
I want **the Playwright visual harness extended to assert the pixel/CSS reality of the new
resource fields (title heading, "ver recurso" link, DocsView description, citation title) that
Story 7.5 rendered but explicitly deferred**,
so that **every visual acceptance criterion of the curated-resource UI is machine-verified — not
just "it renders" (jsdom) but "it renders correctly" (getComputedStyle) — closing Epic 7 with
the same visual-AC discipline the harness enforced for Epics 4 and 5**.

**Scope**: `packages/web/tests` ONLY — extend the three existing view specs with
`getComputedStyle` + `getAttribute('href')` assertions for the elements Story 7.5 added, plus
one behavioral e2e test for the F2 "ver recurso" bubbling→mark-read in DocsView. No production
code changes, no new seed data (the 7.4 seed already carries realistic titles + `https://example.com/e2e/…`
links), no new deps, no config. Epic line: *"Historia 7.6 · e2e: extender harness visual
(patrón Epic 4) a los campos nuevos"* [Source: _bmad-output/planning-artifacts/epics.md:1011].

**Out of scope**: any change to `SearchView.tsx` / `DocsView.tsx` / `ChatWidget.tsx` /
`components.css` / shared schemas / backend / seed / config (7.5 shipped and merged the
rendering — this story only ASSERTS it; if a component change seems necessary, a real 7.5 defect
was found → record it, do NOT silently patch the harness to match); new Playwright config,
fixtures, or helpers beyond the existing `loginAs` / `gotoDocs` / `gotoChat` pattern; the
`interactions.spec.ts` nav/theme file (unaffected); visual regression via screenshot diffing
(the harness captures screenshots as artifacts, it does not diff them — DR convention);
the deferred DocsView offset-pagination skip/dup, the UX-DR20 trace panel, and the "ver recurso"
middle-click/context-menu mark-read gap (all in `deferred-work.md`, all stay deferred).

**Critical context — what 7.5 already did and explicitly left to 7.6**: on `main @ a0841ca`
(PR #49 merged) the three views RENDER the new fields and 13 chromium specs pass unchanged, but
7.5's completion notes named exactly what its jsdom unit tests could NOT verify and handed it to
this story: *"the SearchView `<h3>` title typography (Space Grotesk 600 15.5px), the
`.kh-resource-link` hover color transition, and the CitationChip title styling (`--text-primary`,
ellipsis/max-width) … their pixel-level verification is deliberately deferred to Story 7.6"*
[Source: 7-5-…md:437-443]. jsdom ignores external stylesheets and resolves no CSS custom
properties [Source: packages/web/tests/README.md:4-8] — only the harness (`vite build` + real
`global.css`/`components.css`) can assert them. **This story writes tests, not features.**

## Decisions confirmed with Borja (2026-07-09, story creation)

| # | Fork | Decision |
|---|---|---|
| F1 | Spec-file organization | **Extend the 3 existing specs.** New read-only `describe('Story 7.6 …')` blocks inside `search.spec.ts` and `docs.spec.ts`; the CitationChip title/href assertions are ADDED to the EXISTING chat.spec.ts history-load test (AC6), not a new test. No new `resources.spec.ts`. Matches how 5.4 extended `chat.spec.ts` and keeps each view's assertions co-located with its existing ones, reusing `loginAs`/`gotoDocs`/`gotoChat` and the existing dark-theme token constants. |
| F2 | Coverage breadth | **All new 7.5 elements across the 3 views**, not just the 3 explicitly named. SearchView: `<h3>` title (typography + color) + `.kh-resource-link` hover + resource `href` + "ver en Discord" coexistence; DocsView: `doc-row-description` (color + 2-line clamp) + anchor `href`; CitationChip: title span (color + ellipsis/max-width) + `href = citation.link`. All `href`s asserted against the **exact** 7.4 seed values (`https://example.com/e2e/…`), not a loose pattern. |
| F3 | DocsView "ver recurso" bubbling (F2 of 7.5) verified in e2e | **Yes — add a mutating behavioral test.** Click "ver recurso" on an UNREAD row, handle the `target="_blank"` popup (`page.waitForEvent('popup')` → `close()`, with the external host route-blocked so no real egress), assert the row's `data-read` flips to `"true"`. This is MUTATING → it MUST be ordered so the single terminal mutation rule of `docs.spec.ts` still holds (see D3 + Dev Notes "Playwright ordering"). |

### Design decisions embedded in the ACs (recommended defaults — veto at review)

- **D1 — SearchView 7.6 describe (non-mutating)**: one new test in a `describe('Story 7.6 —
  SearchView resource title + link')` appended AFTER the existing 4.3 describe. `loginAs(page,
  'e2e-member')` → `.kh-search-input` fill `'share2brain'` → first `.kh-result-card` (top similarity =
  the `unitVector(1)` `#general` fragment). Assert on that card's `<h3>`
  (`card.locator('h3')`): text `'Cómo configurar los canales a indexar'`, `font-family`
  /Space Grotesk/, `font-weight '600'`, `font-size '15.5px'`, `color` TEXT_PRIMARY. Assert the
  description `<p>` (`card.locator('p')` under the h3): `color` TEXT_SECONDARY, `font-size '14px'`.
  Assert `.kh-resource-link` in the card: `getAttribute('href')` === the seed resource link,
  `target '_blank'`, base `color` TEXT_MUTED, then `.hover()` → `color` ACCENT_INK. Assert the
  UNCHANGED `.kh-discord-link` `href` still contains `discord.com/channels`. Screenshot.
- **D2 — DocsView 7.6 non-mutating test**: a new `describe('Story 7.6 — DocsView description +
  resource link')` with one non-mutating test. `gotoDocs(page)` → first `.kh-doc-row`. Assert
  `doc-row-description`: `color` TEXT_MUTED, `-webkit-line-clamp '2'`, `display '-webkit-box'`.
  Assert `doc-row-content` (title) still single-line: `white-space 'nowrap'`, `text-overflow
  'ellipsis'` (read/unread color/weight already covered by the 4.4 test — do not duplicate).
  Assert `.kh-resource-link` anchor in the row: `getAttribute('href')` === the first doc's seed
  link (`https://example.com/e2e/configurar-canales-indexados`, the newest by `created_at DESC`),
  `font-family` /IBM Plex Mono/, `target '_blank'`, base `color` TEXT_MUTED, `.hover()` →
  ACCENT_INK. Screenshot.
- **D3 — DocsView 7.6 bubbling test (MUTATING, F3)**: a SECOND test, placed so it runs AFTER all
  non-mutating docs tests and BEFORE the 4.4 mutating "mark all read" test (which must stay the
  file's terminal mutation). Pick `page.locator('.kh-doc-row[data-read="false"]').first()`, find
  its `.kh-resource-link`, set up the popup capture + external-host block, click, close the
  popup, then `await expect(row).toHaveAttribute('data-read', 'true')`. The optimistic
  `handleRowClick` flips `data-read` synchronously on the same bubbled click (no
  `stopPropagation`, 7.5 F2). Because the seed leaves multiple unread rows for `e2e-member`,
  flipping one keeps both `[data-read]` classes present for any test that needs them, and mark-all
  still transitions the rest. Screenshot.
- **D4 — CitationChip assertions folded into the EXISTING chat.spec history-load test (AC6)**:
  do NOT add a new chat test (avoids disturbing the mutating-streaming-last ordering). In the
  existing `'history load: selecting the seeded row renders its messages + citation (AC6)'`
  test, after the chip is located, add: `citation.locator('span')` filtered to the title span
  shows `'Cómo configurar los canales a indexar'` (CONVERSATION_CITATIONS[0].title), the title
  span `color` TEXT_PRIMARY + `text-overflow 'ellipsis'` + `max-width '180px'`, and
  `citation.getAttribute('href')` === `'https://example.com/e2e/configurar-canales-indexados'`.
  Keep every existing assertion in that test (channel text, border hover blurple) intact.
- **D5 — token constants**: `search.spec.ts` needs TEXT_PRIMARY (`rgb(230, 233, 239)`),
  TEXT_SECONDARY (`rgb(199, 205, 216)`), TEXT_MUTED (`rgb(124, 132, 148)`) added to its
  dark-token block (it currently only declares ACCENT_INK/SURFACE/TEXT_TERTIARY/BORDER_STRONG);
  `docs.spec.ts` already has TEXT_PRIMARY/TEXT_MUTED/ACCENT_INK; `chat.spec.ts` needs
  TEXT_PRIMARY added. Copy the exact `rgb(...)` values from the neighboring specs' comments —
  they are the dark-theme computed values of the `global.css :root` tokens.
- **D6 — hover assertion mechanics**: `.hover()` then `toHaveCSS('color', ACCENT_INK)` relies on
  Playwright auto-retry for the transition; the `.kh-resource-link:hover` rule lives in
  `components.css` (base color in the class, not inline — the 7.5 cascade fix), so the hover
  computed color WILL change (this is the exact regression the harness exists to catch). If it
  does not change, that is a real cascade defect — report it, do not delete the assertion.
- **D7 — popup + external-egress safety (D3)**: before the click, block the resource host so the
  popup never hits the network: `await page.context().route('https://example.com/**', (route) =>
  route.abort())`. Capture with `const popupPromise = page.waitForEvent('popup');` BEFORE the
  click, then `const popup = await popupPromise; await popup.close();`. The mark-read is driven by
  the bubbled click on the SPA page, independent of the popup — the assertion targets the row in
  the original `page`, not the popup.
- **D8 — no production change, no seed change**: `ExternalLinkIcon`, the classes, the testids,
  the seed titles/links all exist as of 7.5/7.4. If any assertion cannot be satisfied without
  editing a non-test file, STOP: either the selector is wrong (fix the test) or a 7.5 regression
  exists (record it in Review/Debug notes and raise it — do not patch product code under an e2e
  story without surfacing it).

## Acceptance Criteria

1. **SearchView resource title + link asserted (D1)** — `search.spec.ts` gains a
   `describe('Story 7.6 …')` with a non-mutating test that, on the top `.kh-result-card` for
   query `'share2brain'` (`e2e-member`), asserts: the `<h3>` renders `'Cómo configurar los canales a
   indexar'` with `font-family` Space Grotesk, `font-weight 600`, `font-size 15.5px`, `color`
   `rgb(230, 233, 239)`; the description `<p>` `color` `rgb(199, 205, 216)` / `font-size 14px`;
   the `.kh-resource-link` `href` equals `https://example.com/e2e/configurar-canales-indexados`,
   `target="_blank"`, base `color` `rgb(124, 132, 148)`, hover `color` `rgb(245, 166, 35)`; and
   the unchanged `.kh-discord-link` `href` still contains `discord.com/channels`. A screenshot is
   captured.
2. **DocsView description + resource anchor asserted (D2)** — `docs.spec.ts` gains a
   `describe('Story 7.6 …')` non-mutating test asserting, on the first `.kh-doc-row`: the
   `doc-row-description` element has `color` `rgb(124, 132, 148)`, `display` `-webkit-box`,
   `-webkit-line-clamp` `2`; the `doc-row-content` (title) keeps `white-space nowrap` +
   `text-overflow ellipsis`; and the row's `.kh-resource-link` has `href`
   `https://example.com/e2e/configurar-canales-indexados`, `font-family` IBM Plex Mono,
   `target="_blank"`, base `color` `rgb(124, 132, 148)`, hover `color` `rgb(245, 166, 35)`. A
   screenshot is captured.
3. **DocsView "ver recurso" bubbles to mark-read, in e2e (D3, D7, F3)** — a MUTATING
   `docs.spec.ts` test clicks the `.kh-resource-link` of the first `[data-read="false"]` row,
   handles the `target="_blank"` popup (`waitForEvent('popup')` → `close()`) with the external
   host route-blocked, and asserts the row's `data-read` becomes `"true"` (the click bubbled to
   `handleRowClick`, no `stopPropagation`). This test is ordered AFTER the 4.4 non-mutating dots
   test and BEFORE the 4.4 mutating "mark all read" test — the mark-all test remains the file's
   terminal mutation. A screenshot is captured.
4. **CitationChip title + link asserted in the existing chat test (D4)** — the existing
   `chat.spec.ts` history-load test (AC6) gains, without removing any current assertion: the
   citation chip shows the seeded title `'Cómo configurar los canales a indexar'`, its title span
   has `color` `rgb(230, 233, 239)`, `text-overflow ellipsis`, `max-width 180px`, and the chip's
   `href` equals `https://example.com/e2e/configurar-canales-indexados`.
5. **Full harness green + counts (§3.4)** — `npm run test:e2e -w @share2brain/web` runs all chromium
   specs green: search 2→3, docs 2→4, chat 7 (unchanged count — AC4 extends an existing test),
   interactions 2 (untouched) → **16 total, up from 13**. Ordering invariants preserved:
   `docs.spec.ts` mark-all stays terminal, `chat.spec.ts` streaming stays terminal, `workers:1`.
   Screenshots land under `packages/web/test-results/` (artifacts, not committed).
6. **No production or seed change; deferrals unchanged (D8)** — the diff touches ONLY
   `packages/web/tests/*.spec.ts` (and nothing else): `git diff --stat` shows no change to
   `src/`, `packages/shared`, `packages/backend`, `components.css`, the seed, config, or docs.
   The `deferred-work.md` items (pagination skip/dup, trace panel, "ver recurso"
   middle-click/context-menu mark-read gap) remain deferred — this story does not close them.
   Every visual AC that 7.5 flagged as "deferred to 7.6" is now asserted by name (traceability
   recorded in completion notes).
7. **Verification gate (AGENT-run, §3.1)** — `npm run lint` (0) && `npm run build` (5 pkgs,
   unchanged) && `npm run test` (unit+web, unchanged — no production/unit files touched) &&
   `npm run test:e2e -w @share2brain/web` (16 chromium green). `npm run test:integration` is NOT
   required (no shared contract, backend, or seed change — record this reasoning in the
   completion notes; contrast with 7.5 which DID re-run integration because it changed a shared
   schema). Evidence pasted in the Dev Agent Record.

## Tasks / Subtasks

- [x] Task 0 — Branch + preconditions (AC: all)
  - [x] `git branch --show-current` → was `main`, created `feat/7-6-e2e-visual-new-fields`.
  - [x] Confirmed the harness runs: `docker compose up -d postgres redis` (already running),
        Homebrew Redis already started, `npx drizzle-kit migrate` (applied), chromium present.
  - [x] Baseline: `npm run test:e2e -w @share2brain/web` → **13 passed** before any change.
- [x] Task 1 — SearchView 7.6 assertions (AC: 1)
  - [x] Added TEXT_PRIMARY/TEXT_SECONDARY/TEXT_MUTED constants to `search.spec.ts` (D5, exact rgb
        verified against global.css :root dark values).
  - [x] Appended `describe('Story 7.6 — SearchView resource title + link')` with the non-mutating
        test per D1 (top card h3 typography/color, description color/size, `.kh-resource-link`
        href/target/base-color/hover, `.kh-discord-link` href unchanged, screenshot).
- [x] Task 2 — DocsView 7.6 non-mutating assertions (AC: 2)
  - [x] Added `describe('Story 7.6 — DocsView description + resource link')` non-mutating test per
        D2 (`doc-row-description` color + clamp, `doc-row-content` ellipsis/nowrap,
        `.kh-resource-link` href/font/target/base-color/hover, screenshot). Clamp asserted via
        `-webkit-line-clamp`/`-webkit-box-orient`/`overflow-x` (see completion notes — Chromium
        serializes the computed `display` as `flow-root` when line-clamp is engaged, not
        `-webkit-box`; the clamp itself works, verified empirically).
- [x] Task 3 — DocsView bubbling mark-read (AC: 3)
  - [x] Added the MUTATING test per D3/D7 (route-block `https://example.com/**`, capture+close the
        popup, assert `data-read` flips). Final `docs.spec.ts` order: 4.4 dots (non-mut) → 7.6
        description (non-mut) → 7.6 bubbling (MUT) → 4.4 mark-all (MUT, terminal). Realized by
        splitting mark-all into its own `describe('Story 4.4 — mark all read (mutating, terminal)')`
        at the file bottom. The row is anchored on its resource `href` (stable), NOT on the
        `[data-read="false"]` filter, which re-evaluates onto a different unread row after the flip.
- [x] Task 4 — CitationChip assertions in the existing chat test (AC: 4)
  - [x] Added TEXT_PRIMARY + citation title/link constants to `chat.spec.ts` (D5). Extended the
        existing AC6 history-load test with title-text, title-span color/ellipsis/max-width, and
        `href` assertions per D4 — no existing assertion removed, no new test added.
- [x] Task 5 — Gate + finish (AC: 5, 6, 7)
  - [x] All 16 chromium specs green; counts confirmed (search 3 / docs 4 / chat 7 /
        interactions 2 = 16); ordering invariants held; screenshots captured under test-results/.
  - [x] `git diff --stat` proves tests-only (+ sprint-status tracking). lint 0 / build clean /
        unit+web 813 pass (unchanged); integration skipped with recorded reasoning (AC-7).
  - [x] Evidence pasted; 7.5-deferred visual ACs traced; sprint-status → `review`; commit in slices.

## Review Findings

_bmad-code-review 2026-07-09 — 3 adversarial layers @ Opus 4.8 (Blind Hunter / Edge Case Hunter / Acceptance Auditor). Edge Case Hunter cross-verified every new assertion against the real 7.5 components, CSS tokens, and seed. Acceptance Auditor: 0 AC violations, 16/16 counts, ordering invariants hold. Result: 2 patch, 0 decision-needed, 0 defer, 11 dismissed as verified false positives / spec-mandated._

- [x] [Review][Patch] Truncation assertions omit `overflow: hidden` — discrimination gap [chat.spec.ts:210-213, docs.spec.ts:99-101] — FIXED: added `overflow-x: hidden` to the citation title span + the DocsView title, and `overflow-y: hidden` to the description clamp. 16/16 e2e green. — the title/citation ellipsis checks assert `text-overflow: ellipsis` + `white-space: nowrap` (+ `max-width` on the chip) and the description asserts `overflow-x: hidden`, but none assert `overflow-y`/`overflow: hidden`. The real spans DO set `overflow: 'hidden'` (DocsView.tsx:444/459, ChatWidget.tsx:996), so the suite is green — but a regression dropping only `overflow:hidden` (leaving ellipsis inert) would still pass. Add an `overflow`/`overflow-y: hidden` assert to the two single-line titles + the citation title span, and `overflow-y: hidden` to the description clamp, to make the assertions sufficient (Standing DoD: assertions must discriminate).
- [x] [Review][Patch] AC2/D2 prose not amended to match the clamp-assertion substitution [7-6-…md:76,137] — FIXED: added the "AC2/D2 amended" ratification note to the Change Log. — AC2 and D2 still literally require asserting `display: '-webkit-box'`, but the implementation correctly substitutes `-webkit-box-orient`+`overflow-x` (Chromium serializes computed `display` as `flow-root` when `-webkit-line-clamp` is engaged — documented in Task 2 / Debug Log / Completion Notes). The engineering call is right; only the acceptance prose is stale. Add a one-line "AC2/D2 amended: clamp asserted via `-webkit-line-clamp`/`-webkit-box-orient`/`overflow-x`, not `display`" note to the Change Log so the AC-to-code trace is self-consistent.

## Dev Notes

### Architecture compliance (invariants that bind this story)

- **AD-3** (static SPA): the harness boots the BUILT SPA (`vite build && vite preview`) against a
  deterministic test backend — assertions must run against the real `global.css`/`components.css`,
  which is the whole point (jsdom can't). Do not add jsdom-style content-only checks here.
- **AD-2**: tests-only, `packages/web` only. No cross-service reach.
- **§3.4 (bmad-story-mandatory-steps)**: Playwright is MANDATORY when UI is affected; this story
  IS the §3.4 obligation 7.5 deferred. With a runner available, run all specs; without one, run
  what §3.3 allows and flag every unverified visual AC by name (fallback clause).
- **Epic 4 retro AI#6** (memorialized): *a visual AC is not done until the harness asserts it.*
  This story is that principle applied to the Epic 7 fields — the reason 7.6 exists as a separate
  story rather than being folded into 7.5.
- **English only** in test code/comments/commits; the asserted UI strings are Spanish (product
  copy) and the seed data is Spanish (user-visible) — assert them verbatim.

### Current state — verbatim anchors (verified 2026-07-09, main @ a0841ca, PR #49 merged)

**The rendering is DONE and merged. This story asserts it. Do not re-plumb, do not edit `src/`.**

- `packages/web/tests/` (4 spec files + `helpers/session.ts` + `README.md`):
  - `search.spec.ts` (2 tests): `describe('Story 4.3 …')`. Tokens declared: ACCENT_INK, SURFACE,
    TEXT_TERTIARY, BORDER_STRONG. Test 1 fills `'share2brain'`, takes `.kh-result-card`.first(), asserts
    channel badge / similarity bar / avatar / chips. **Nothing asserts the card body text today**
    → the new h3/description/links are additive and spec-safe. Both tests are non-mutating.
  - `docs.spec.ts` (2 tests): `describe('Story 4.4 …')`. Tokens: ACCENT_INK, DOT_READ, HOVER_ROW,
    TEXT_PRIMARY, TEXT_MUTED, TEXT_SUBTLE, BORDER_STRONG. `gotoDocs(page)` helper. Test 1
    (non-mutating) asserts grid `/^\d+(\.\d+)?px 130px 130px 96px$/`, header `getByText('recurso',
    {exact:true})`, `doc-row-dot` + `doc-row-content` read/unread colors+weights, row hover,
    sidebar badge. Test 2 (**MUTATING** — mark-all) is LAST and asserts the all-read empty state.
  - `chat.spec.ts` (7 tests): `describe('Story 5.3 …')` (4 tests) + `describe('Story 5.4 …')`
    (3 tests). Tokens: ACCENT_INK, BG, SURFACE, BORDER, BORDER_STRONG, LINE, AMBER. `gotoChat`
    helper. The **AC6 history-load test** (`:186-209`) already locates `page.getByTestId(
    'chat-citation').first()`, asserts `toContainText('#general')` + border-hover blurple — **this
    is where D4's title/href assertions go**. The STREAMING test (`:213-235`) is **MUTATING**
    (persists a conversation) and is LAST — do not add tests after it.
  - `interactions.spec.ts` (2 tests): nav/theme — untouched.
  - `helpers/session.ts`: `loginAs(page, code)` — fake-OAuth login that forces dark theme. Reuse
    it; do not add helpers.
- The rendered elements this story asserts (post-7.5, do NOT edit — read for selectors):
  - `SearchView.tsx:342-353` `<h3>` (Space Grotesk 600, `fontSize: 15.5`, `color:
    var(--text-primary)`, `overflowWrap: 'anywhere'`) → `{fragment.title}`; `:355-365` `<p>`
    description (`fontSize: 14`, `lineHeight: 1.6`, `color: var(--text-secondary)`); `:388-403`
    `<a className="kh-resource-link" href={fragment.link} target="_blank" rel="noopener
    noreferrer">` "ver recurso" + `ExternalLinkIcon`; `:404-420` UNCHANGED `.kh-discord-link`
    "ver en Discord" (`href = https://discord.com/channels/${guildId}/${channelId}/${messageId}`).
  - `DocsView.tsx:436-450` `<span data-testid="doc-row-content">` title (single-line: `overflow
    hidden`/`textOverflow ellipsis`/`whiteSpace nowrap`, read-state color/weight); `:451-466`
    `<span data-testid="doc-row-description">` (`display: '-webkit-box'`, `WebkitLineClamp: 2`,
    `WebkitBoxOrient: 'vertical'`, `color: var(--text-muted)`); `:467-484` `<a
    className="kh-resource-link" href={doc.link} target="_blank" …>` (IBM Plex Mono, `fontSize:
    11.5`); `handleRowClick` `:125-134` (optimistic mark-read, no-op if already read, no
    `stopPropagation` on the anchor → the click bubbles).
  - `ChatWidget.tsx:951-1005` `CitationChip`: `<a className="kh-chat-citation"
    data-testid="chat-citation" href={citation.link} …>` → avatar span (`:969-985`), `#{channel}`
    mono amber span (`:986-988`), **title span** (`:989-1000`: `fontSize: 11.5`, `color:
    var(--text-primary)`, `maxWidth: 180`, `overflow hidden`, `textOverflow ellipsis`,
    `whiteSpace nowrap`) → `{citation.title}`, author span (`:1001`), external icon (`:1002-1004`).
- `packages/web/src/styles/components.css:97-102` `.kh-resource-link { color: var(--text-muted) }`
  + `.kh-resource-link:hover { color: var(--accent-ink) }` — base color in the CLASS (7.5 cascade
  fix, Epic 4 retro AI#4). This is what AC1/AC2's hover assertions exercise.

### Seed data (the exact values the href/text assertions bind to)

[Source: packages/backend/src/e2e/seed.ts:82-86, :104-110]

- Search/documents embeddings (5 rows). Top search similarity = `unitVector(1)` = **`e2e-msg-g1`**
  in `e2e-ch-general`: title `'Cómo configurar los canales a indexar'`, link
  `https://example.com/e2e/configurar-canales-indexados`. Documents are ordered `created_at DESC,
  id DESC` [Source: documentRepository.drizzle.ts:55] and `g1` has the newest `createdAt`
  (`2026-06-06T10:00:00Z`) → **`g1` is also the first DocsView row** (same title + link).
- The other four (for reference, not asserted): `g2` Indexación con Redis Streams / `…/indexacion-redis-streams`;
  `g3` RBAC dentro de la query vectorial / `…/rbac-query-vectorial`; `r1` Similitud coseno con
  pgvector / `…/similitud-coseno-pgvector`; `r2` Sesiones en Redis, sin tabla propia / `…/sesiones-en-redis`.
- `CONVERSATION_CITATIONS[0]` (the seeded conversation the AC6 history-load test opens): title
  `'Cómo configurar los canales a indexar'`, link
  `https://example.com/e2e/configurar-canales-indexados`, channel `general`. **So the citation
  chip's title + href assert against these exact values.**
- The `e2e-member` documents fixture leaves a mix of read + unread rows (the 4.4 dots test proves
  it by locating both `[data-read="false"]` and `[data-read="true"]`) → AC3's first-unread-row
  click has a valid target and mark-all still has rows left to flip.

### Playwright ordering — the one thing that can go wrong (D3)

Playwright with `workers:1` runs spec files alphabetically (`chat` → `docs` → `interactions` →
`search`) and, within a file, tests in source order. The invariant the harness relies on: **each
file's mutations are terminal and touch tables no later file's non-mutating test reads.**

- `docs.spec.ts` gains a SECOND mutation (AC3 bubbling flips one row read). Required final source
  order in `docs.spec.ts`:
  1. 4.4 `grid, header cells, read/unread dots…` (non-mutating; needs both read+unread rows — runs first, before any mutation)
  2. 7.6 `DocsView description + resource link` (non-mutating)
  3. 7.6 `ver recurso bubbles to mark-read` (**MUTATING** — flips ONE unread row)
  4. 4.4 `all-read empty state + badge disappearance` (**MUTATING** — mark-all — stays terminal)
  To realize this with `describe` blocks (a describe can't be split mid-file), the simplest legal
  layout is: keep the 4.4 dots test in the `Story 4.4` describe, then add the `Story 7.6` describe
  (both its tests) AFTER it, then ensure the mark-all test is the LAST test in the file — if it
  currently sits inside the `Story 4.4` describe above the new `Story 7.6` describe, MOVE it into
  its own `describe('Story 4.4 — mark all (mutating, last)')` placed at the file bottom. Record
  the final order you chose in the completion notes.
- `chat.spec.ts`: AC4 extends an EXISTING non-mutating test (history-load) — no new test, so the
  streaming mutation stays terminal untouched. Do not reorder chat.spec.
- The AC3 bubbling test mutates `user_read_status` for `e2e-member`; the docs mark-all test also
  mutates it; no LATER file (`interactions`, `search`) reads it → the cross-file isolation the
  README documents is preserved. `search.spec` runs LAST alphabetically and is read-only.

### Test-writing conventions (harness, not jsdom)

- Assertions use Playwright `expect(locator).toHaveCSS(prop, value)` (auto-retrying) and
  `toHaveAttribute` / `getAttribute` — this is `@playwright/test`, NOT the jsdom unit suite, so
  `toHaveCSS`/`toHaveAttribute` ARE available here (unlike the unit tests, which lack jest-dom).
- Computed color values are `rgb(r, g, b)` strings (dark theme forced by `loginAs`); `font-size`
  serializes as e.g. `'15.5px'`; `-webkit-line-clamp` as `'2'`; `display` as `'-webkit-box'`.
  Copy exact rgb from the existing specs' token comments (D5).
- `font-family` assertions use a regex (`/Space Grotesk/`, `/IBM Plex Mono/`) like the neighbors —
  the computed value is the full font stack.
- Locate scoped: `card.locator('.kh-resource-link')`, `row.getByTestId('doc-row-description')`,
  `citation.locator(...)` — never a bare page-wide selector that could match another card/row.
- Every new test ends with `page.screenshot({ path: testInfo.outputPath('<name>.png'), fullPage:
  true })` per the file convention.
- The hover tests: `await locator.hover()` then `await expect(locator).toHaveCSS('color',
  ACCENT_INK)` — auto-retry covers the transition. Assert the BASE color BEFORE hovering.

### Do-NOT-touch look-alikes

Any `src/` file (SearchView/DocsView/ChatWidget/components.css) · shared schemas · the e2e seed
· `playwright.config.ts` · `helpers/session.ts` · the existing assertions in the 4.3/4.4/5.3/5.4
tests (ADD only; the AC4 chat test keeps all its current assertions) · the `chat.spec.ts`
streaming test's terminal position · the `interactions.spec.ts` file · empty-state copy · the
`similarity-bar`/`doc-row-dot` geometry the 4.x tests own · `docs/*` and `deferred-work.md`
(no doc sync in this story — it's tests-only; note this explicitly so review doesn't expect §3.5).

### Previous story intelligence (7.5 + 4.5 + Epic 4/5 retros)

- **7.5** rendered every element this story asserts and, in its completion notes, NAMED the three
  visual ACs it could not verify in jsdom and handed them here — AC1/AC2/AC4 close exactly those,
  and F2 adds the remaining new elements + the bubbling behavior. 7.5's review dismissed
  "anchor re-marks already-read" as a false positive (`handleRowClick` early-returns on `isRead`)
  — so AC3 must click an UNREAD row for the mark-read transition to fire.
- **4.5** built this harness (fake-OAuth `loginAs`, `preview.proxy`, `workers:1` dark chromium,
  Playwright 1.61.1) and established the "retroactive visual verification" pattern these specs
  follow; it also surfaced a real 4.3 focus-ring defect — proof the harness catches regressions,
  so keep assertions strict (do not soften to green).
- **Epic 4 retro AI#4** (cascade rule): the `.kh-resource-link` base-in-class / hover-override is
  precisely the shape a bad inline `color` would silently break; AC1/AC2's hover assertions are
  the guard.
- **web inline-border cascade gotcha** (memory): an inline shorthand outranks a `:hover`/`:focus`
  pseudo-class — the harness hover assertions exist to catch a reintroduction of that bug.
- Standing DoD (`operational-backlog.md`): new tests must DISCRIMINATE — for each new assertion,
  sanity-check it would FAIL against the pre-7.5 render (e.g. an empty h3, a placeholder
  `discord.com/channels` href on the chip, a missing description span) so it isn't a tautology.

### Git intelligence

Main @ `a0841ca` (PR #49 merged — Story 7.5, resource rendering + `.trim().min(1)` title patch).
Branch: `feat/7-6-e2e-visual-new-fields`. Recent commits confirm 7.5's shape: `0ea3095
fix(shared): reject whitespace-only resource titles`, `d49cc9c docs(repo): resource wording for
UX-DRs and contract docs`. Suggested slices (Conventional Commits, English, ≤72 chars):
1. `test(web): assert resource title and link in search harness` — search.spec 7.6 describe + tokens.
2. `test(web): assert docs description, resource link, and bubbling mark-read` — docs.spec 7.6
   describe (non-mut) + mutating bubbling test + ordering fix.
3. `test(web): assert citation title and link in chat harness` — chat.spec AC6 additions + token.

### Project Structure Notes

- Files touched: `packages/web/tests/search.spec.ts`, `packages/web/tests/docs.spec.ts`,
  `packages/web/tests/chat.spec.ts` — ONLY. No new files, no new deps, no config, no `src/`.
- If compilation/lint demands touching anything outside `tests/`, STOP and re-check — that is a
  7.5 regression (report it) or a wrong selector (fix the test), not this story's scope.

### References

- [Source: _bmad-output/planning-artifacts/epics.md:1011 (Historia 7.6 · e2e), :109-113
  (UX-DR11), :111 (UX-DR12), :113 (UX-DR13), :129 (UX-DR21) — the visual reality being verified]
- [Source: _bmad-output/planning-artifacts/sprint-change-proposal-2026-07-09.md:199 (7.6 scope),
  :208 (seed title/description/link), :233 (inner-layers-first sequence)]
- [Source: _bmad-output/implementation-artifacts/7-5-…md:32-33 (7.6 owns new-field harness),
  :86-90 (D5 jsdom asserts rendering / harness asserts pixels), :437-443 (the three deferred
  visual ACs named), :514-517 (F2 middle-click gap stays deferred)]
- [Source: _bmad-output/implementation-artifacts/4-5-…md (harness build: loginAs, preview.proxy,
  workers:1, Playwright 1.61.1, retroactive-verification pattern)]
- [Source: packages/web/tests/{search,docs,chat}.spec.ts (existing describes, tokens, helpers,
  mutating-last ordering) + tests/README.md (harness boot, Redis note, isolation convention)]
- [Source: packages/web/src/components/{SearchView,DocsView,ChatWidget}.tsx +
  styles/components.css:97-102 (rendered selectors + the .kh-resource-link cascade rule)]
- [Source: packages/backend/src/e2e/seed.ts:82-86,104-110 (exact titles/links) +
  infrastructure/documentRepository.drizzle.ts:55 (docs order → first row = g1)]
- [Source: docs/bmad-story-mandatory-steps.md §3.1 (gate), §3.4 (Playwright mandatory + fallback)]
- [Source: docs/context/ARCHITECTURE-SPINE.md AD-2/AD-3; docs/frontend-standards.md]

## Dev Agent Record

### Agent Model Used

claude-opus-4-8 (Amelia, bmad-dev-story)

### Debug Log References

- Baseline `npm run test:e2e -w @share2brain/web` → 13 passed (pre-change).
- First full run after adding tests → 14 passed / 2 failed (both new docs.spec tests):
  1. **AC2 description**: `toHaveCSS('display', '-webkit-box')` received `flow-root`. Controlled
     browser experiment (bare `display:-webkit-box` → computes `-webkit-box`; full clamp idiom →
     computes `flow-root` with clientHeight 38 / scrollHeight 113) proved this is a **Chromium
     computed-value quirk** when `-webkit-line-clamp` is engaged, NOT a 7.5 defect — the clamp
     works (38px = exactly 2 lines). Fixed by asserting the clamp via `-webkit-line-clamp` (`2`),
     `-webkit-box-orient` (`vertical`), and `overflow-x` (`hidden`), which compute meaningfully.
  2. **AC3 bubbling**: `data-read` never observed as `true`. Root cause: the assertion targeted
     `.kh-doc-row[data-read="false"]`.first() — a DYNAMIC locator that, after the optimistic flip,
     re-resolves onto the NEXT still-unread row (log: "14× resolved to data-read=false"). Fixed by
     anchoring the row on its resource `href` (stable identity) before the click.
- Final full run → **16 passed** (13.5s).

### Completion Notes List

- **What this story is**: tests-only. It ASSERTS the pixel/CSS reality of the resource fields
  Story 7.5 rendered and explicitly deferred (jsdom resolves no CSS custom properties). No
  production, seed, config, or docs change (AC-6 verified via `git diff --stat`).
- **Traceability — the three 7.5-deferred visual ACs, now machine-asserted by name** (7.5 notes
  :437-443): (1) SearchView `<h3>` title typography (Space Grotesk 600 / 15.5px / `--text-primary`)
  → AC1; (2) the `.kh-resource-link` hover color transition (base `--text-muted` in the class →
  `--accent-ink` on `:hover`, the 7.5 cascade fix) → asserted in BOTH AC1 (search) and AC2 (docs);
  (3) the CitationChip title styling (`--text-primary`, ellipsis, `max-width 180px`) → AC4. F2 adds
  the remaining new elements (description clamp, both resource `href`s against exact seed values,
  the `#general` deep-link coexistence) and the F3 bubbling→mark-read behavior (AC3).
- **Chromium `-webkit-box` / line-clamp quirk (new gotcha)**: with `-webkit-line-clamp` active,
  Chromium's `getComputedStyle().display` reports `flow-root`, not `-webkit-box`, even though the
  specified/used value is `-webkit-box` and the clamp renders (verified: 2-line box clamps 113px of
  content to 38px). A jsdom unit test reading the style prop would see `-webkit-box` and pass — this
  is exactly the harness/jsdom gap this story exists to close. Asserting the clamp via
  `-webkit-line-clamp`/`-webkit-box-orient`/`overflow-x` is both correct and durable.
- **Discrimination (DoD)**: each new assertion binds to a 7.5-specific value that a pre-7.5 render
  would fail — the seeded resource title text, the exact `https://example.com/e2e/…` hrefs (the chip
  previously carried a placeholder `discord.com/channels` href), the description-span testid (absent
  pre-7.5), and the hover color transition (would not fire if the base color were inline).
- **Ordering invariant preserved**: `docs.spec.ts` now has TWO mutations; final source order is
  4.4 dots (non-mut, needs the seeded read/unread mix) → 7.6 description (non-mut) → 7.6 bubbling
  (MUT, flips one row) → 4.4 mark-all (MUT, terminal, in its own describe). `chat.spec.ts` streaming
  stays terminal (AC4 only extended the existing non-mutating history-load test). `workers:1`.
- **Integration NOT run (AC-7 reasoning)**: this story changes only `packages/web/tests/*.spec.ts`
  — no shared Zod contract, no backend, no DB schema, no seed. `npm run test:integration` exercises
  the SQL/contract layer, which is untouched here. (Contrast Story 7.5, which DID re-run integration
  because it tightened a shared schema.) Full e2e (the §3.4 Playwright obligation this story fulfils)
  is the relevant regression surface and is green.
- **Verification gate (AGENT-run)**: `npm run lint` → 0 · `npm run build` → clean (5 pkgs) ·
  `npm run test` (unit+web) → 813 passed / 1 skipped (unchanged) · `npm run test:e2e -w @share2brain/web`
  → 16 chromium passed (search 3 / docs 4 / chat 7 / interactions 2).

### File List

- `packages/web/tests/search.spec.ts` (modified — 7.6 describe + tokens/seed constants)
- `packages/web/tests/docs.spec.ts` (modified — 7.6 describe + bubbling test + mark-all re-homed to terminal describe + seed constant)
- `packages/web/tests/chat.spec.ts` (modified — AC6 test extended + TEXT_PRIMARY/citation constants)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (status tracking: 7-6 → in-progress → review)
- `_bmad-output/implementation-artifacts/7-6-e2e-extender-harness-visual-campos-nuevos.md` (this story file)

## Change Log

- 2026-07-09 — Story created (bmad-create-story). FINAL story of Epic 7. Tests-only: extend the
  Playwright visual harness to assert the resource fields 7.5 rendered but deferred. 4 forks
  confirmed with Borja: F1 extend the 3 existing specs (no new file; chat additions fold into the
  existing AC6 history-load test); F2 full coverage of all new 7.5 elements across the 3 views
  with exact seed href values; F3 add a MUTATING e2e test for the DocsView "ver recurso"
  bubbling→mark-read (popup handled + external host route-blocked), ordered before the terminal
  mark-all mutation. No production/seed/config/docs change. Gate skips integration (no shared/
  backend/seed change) with recorded reasoning. Status: ready-for-dev.
- 2026-07-09 — Story implemented (bmad-dev-story). Extended `search.spec.ts` (+7.6 describe),
  `docs.spec.ts` (+7.6 describe with a non-mutating description/link test and a MUTATING
  bubbling→mark-read test; mark-all re-homed to a terminal describe), and `chat.spec.ts` (AC6
  history-load test extended with citation title/href assertions). **AC2/D2 amended:** the
  DocsView description clamp is asserted via `-webkit-line-clamp '2'` / `-webkit-box-orient
  'vertical'` / `overflow-x`+`overflow-y 'hidden'`, NOT `display '-webkit-box'` — Chromium
  serializes computed `display` as `flow-root` when `-webkit-line-clamp` is engaged (the clamp
  still works; verified empirically). The literal `display '-webkit-box'` in AC2/D2 is superseded
  by this substitution. e2e 13→16 chromium (search 3 /
  docs 4 / chat 7 / interactions 2). Two defects found+fixed in the NEW tests during dev: (1) the
  AC2 `display: -webkit-box` assertion hit a Chromium computed-value quirk (`flow-root` when
  line-clamp is engaged — the clamp works; verified empirically) → re-asserted via
  line-clamp/box-orient/overflow-x; (2) the AC3 dynamic `[data-read="false"]` locator followed onto
  a different unread row after the flip → re-anchored on the resource `href`. NOT a 7.5 regression:
  both were test-authoring bugs, no `src/` touched. Gate green: lint 0 / build clean (5 pkgs) /
  unit+web 813 pass (unchanged) / 16 e2e chromium. Integration skipped (tests-only, no shared/
  backend/seed change). Status: review.
