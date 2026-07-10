---
baseline_commit: 889c11e5a4a41a12a41cc6ac0af7823fdba9de77
---

<!-- Powered by BMAD-CORE™ -->

<!-- story_key: 7-5-web-searchview-docsview-citas-title-description-link -->

# Story 7.5: web — SearchView/DocsView/citas render de title/description/link + UX

Status: done

<!-- Ultimate context engine analysis completed - comprehensive developer guide created
     (2 parallel deep-dives: web current-state + UX/prototype/prior-story intel from 4.3/4.4/5.4/7.4). -->

## Story

As a **community member using Share2Brain's web app**,
I want **search results, the documents list and chat citations to render each curated resource's
AI-generated title, its description and a working link to the resource itself (FR16/FR17/FR18)**,
so that **the Epic 7 pivot is finally visible where I live — I can scan resources by title, open
them directly, and trust that a cited source links to the real thing**.

**Scope**: `packages/web` (SearchView result card, DocsView row + stale copy, CitationChip
redesign, unit tests) + `packages/shared` (`title` tightened to `.min(1)` — a contract change is
scoped `shared` even when a consumer motivates it, AD-6) + UX-DR11/12/13/21 revision in
`epics.md` (assigned to this story by the sprint change proposal §4.7) + minimal text-anchor
patches to existing Playwright specs + docs sync. Epic line: *"Historia 7.5 · web:
SearchView/DocsView/citas render de title/description/link + UX"*
[Source: _bmad-output/planning-artifacts/epics.md:1010].

**Out of scope**: NEW harness visual/CSS assertions for the new fields (Story 7.6 extends the
harness — this story only keeps the existing 13 specs green, patching stale text anchors);
the UX-DR20 execution-trace panel (deferred-work F1 — backend has no `tool_exec`); the DocsView
offset-pagination skip/dup under `unreadOnly` (deferred-work, design change); any backend,
workers or bot change; any new endpoint; any DDL/migration.

**Critical context — what 7.4 already did**: the contracts and the data are DONE. On `main @
889c11e` every fragment/citation that reaches the web is schema-parsed and carries a real
`title`, `description` and a **guaranteed-valid http(s) `link`** (strict `isHttpUrl`, `''`
rejected). The SSE handler in `ChatWidget.tsx:300-313` already captures all five citation
fields; the e2e seed has 5 realistic Spanish resources with `https://example.com/e2e/<slug>`
links; unit fixtures already carry the new fields. What nothing does yet is RENDER them:
`SearchView.tsx:351` and `DocsView.tsx:448` show only `description`, `CitationChip`
(`ChatWidget.tsx:951-998`) ignores `citation.title`/`citation.link` and hardcodes the
placeholder `href="https://discord.com/channels"` behind a stale comment. 7.5 is rendering +
copy + one small contract guarantee, not plumbing.

## Decisions confirmed with Borja (2026-07-09, story creation)

| # | Fork | Decision |
|---|---|---|
| F1 | `title: z.string()` accepts `''` (7.4 review deferral) | **Tighten to `.min(1)`.** `CitationSchema.title`, `SearchFragmentSchema.title` and `DocumentFragmentSchema.title` become `z.string().min(1)`. Closes deferred-work "Citation/fragment title accepts ''". Safe: the enrichment pipeline treats an empty LLM result as failure (7.2 D1) so production rows always have a title; 7.4 flipped every active fixture/seed to real values; pre-7.4 data is already unparseable via strict `link` and covered by the ratified clean-slate runbook. Ripple: schema + new reject-empty test cases only. |
| F2 | DocsView resource link vs click-to-mark-read | **Anchor that bubbles.** A small "ver recurso" anchor (with `ExternalLinkIcon`) inside the main cell, `target="_blank" rel="noopener noreferrer"`, **NO `stopPropagation`**: the click opens the resource AND bubbles to the row's existing `handleRowClick` → optimistic mark-read (opening the resource is the strongest read signal). Row grid `1fr 130px 130px 96px` unchanged. |
| F3 | Citation-chip redesign | **Title + metadata.** The chip gains the resource `title` as its primary text (truncated) and keeps the avatar + `#channel` amber mono badge + author + external icon; `href` swaps from the placeholder `https://discord.com/channels` to `citation.link`. Keeps `data-testid="chat-citation"`, the `kh-chat-citation` class, the `#channel` text and the blurple hover — `chat.spec.ts` stays green untouched. |
| F4 | Stale "chunk" copy in DocsView | **Rename now.** Table header `chunk` → `recurso`; the intro copy drops "mensajes agrupados por autor y ventana temporal" for curated-resource wording. `docs.spec.ts` is patched ONLY on those stale text anchors (`getByText('chunk')`); empty-state texts stay verbatim (specs assert them). |

### Design decisions embedded in the ACs (recommended defaults — veto at review)

- **D1 — SearchView card layout**: header row (channel badge + date / similarity bar + pct)
  UNCHANGED → NEW `<h3>` title (Space Grotesk 600, `fontSize: 15.5`, `color: 'var(--text-primary)'`,
  `margin: '12px 0 0'`, `overflowWrap: 'anywhere'`, no clamp — enrichment bounds title ≤200) →
  description `<p>` moves under it (`margin: '6px 0 0'`, `fontSize: 14`, `lineHeight: 1.6`,
  `color: 'var(--text-secondary)'`, keep `overflowWrap: 'anywhere'`) → footer row keeps
  avatar+name left and gains a links group right: **"ver recurso" (href = `fragment.link`) +
  "ver en Discord" (unchanged deep link)**, both `target="_blank" rel="noopener noreferrer"`
  with trailing `ExternalLinkIcon`. The prototype (`Share2Brain Web.dc.html`) is pre-pivot and has
  NO authority over the new title/link elements — these values are the ratified defaults.
- **D2 — `.kh-resource-link` CSS class** (new, in `components.css`): base
  `color: var(--text-muted)`, `:hover { color: var(--accent-ink) }`. Used by BOTH the SearchView
  "ver recurso" anchor and the DocsView anchor. Blurple `#5865F2` stays Discord-only
  (`.kh-discord-link`, `.kh-chat-citation`). Cascade rule (Epic 4 retro AI#4): the base color
  lives in the class, never inline, or the hover dies.
- **D3 — DocsView main cell structure**: dot (unchanged) + a column: **title span** (single
  line, `textOverflow: 'ellipsis'`, keeps `data-testid="doc-row-content"` AND the read-state
  styling — unread `--text-primary`/500, read `--text-muted`/400, `fontSize: 13.5` — so
  `docs.spec.ts` read/unread assertions stay green on it) → **description span** (NEW
  `data-testid="doc-row-description"`, 2-line `-webkit-line-clamp` exactly like today's block,
  `fontSize: 12.5`, `color: 'var(--text-muted)'` in both read states) → **"ver recurso" anchor**
  (mono `fontSize: 11.5`, `.kh-resource-link`, `ExternalLinkIcon size={12}`, bubbles per F2).
- **D4 — CitationChip layout (F3)**: avatar 20px (unchanged) + `#channel` mono amber
  (unchanged) + **title span** (`fontSize: 11.5`, `color: 'var(--text-primary)'`,
  `maxWidth: 180`, single-line ellipsis) + author (`--text-tertiary`, unchanged) + external
  icon (unchanged). `href={citation.link}`. DELETE the stale 5.4 comment block ("CitationSchema
  is {channel, author, date} with NO message URL…") — it is factually false since 7.4.
- **D5 — jsdom unit tests assert rendering, the harness asserts pixels**: new unit assertions
  use `.textContent` / `getAttribute('href')` (NO jest-dom in this repo). Visual/CSS
  (`getComputedStyle`) verification of the NEW elements is Story 7.6 by design — this story's
  §3.4 obligation is running the existing 13 chromium specs green (with the F4 anchor patches)
  and flagging the new elements' visual ACs as covered-by-7.6.
- **D6 — jsdom anchor-click caveat**: clicking an `<a>` in jsdom logs a "Not implemented:
  navigation" error but does not throw — the F2 bubbling test clicks the DocsView anchor and
  asserts `markRead` was called (and may silence the jsdom console noise). Follow the existing
  `vi.mock('../api/documents')` pattern.
- **D7 — No new deps, no DDL, no migration, no new endpoints, no new icons**
  (`ExternalLinkIcon` exists at `icons.tsx:133`). No router, no data library, no
  Sidebar/Header/AppLayout prop changes.
- **D8 — Spanish UI copy verbatim, English identifiers/comments** (repo rule). New copy is
  specified exactly in the ACs — do not improvise wording.

## Acceptance Criteria

1. **Shared `title` non-empty guarantee (F1)** — `CitationSchema`, `SearchFragmentSchema` and
   `DocumentFragmentSchema` `title` become `z.string().min(1)`; `citation.test.ts`,
   `search.test.ts`, `documents.test.ts` and `sse.test.ts` gain reject-empty-title cases (and
   keep their accept cases with real titles); the bidirectional `satisfies` guards in
   `citation.ts` still compile (interface `Citation` needs no change — `''` is a runtime value);
   repo-wide grep shows no `title: ''` in active (non-reject-test) fixtures/seeds; the
   deferred-work.md entry "Citation/fragment `title: z.string()` accepts `''`" is marked
   resolved by this story.
2. **SearchView renders the resource (FR16, D1, D2)** — each result card shows the `title` as
   an `<h3>` heading (Space Grotesk 600, 15.5px) above the `description` body, and the footer
   gains a "ver recurso" anchor → `fragment.link` (`target="_blank" rel="noopener noreferrer"`,
   `.kh-resource-link`, `ExternalLinkIcon`) alongside the UNCHANGED "ver en Discord" deep link.
   PRESERVED: `.kh-result-card` class + hover, channel badge text/format `#{channelName}`,
   `similarity-bar` testid + 54×5 geometry + gradient, avatar initials block, date format,
   count row, empty/loading/error states and their exact copy, client-side chip filtering,
   250ms debounce. `SearchView.test.tsx` gains assertions: title text rendered, "ver recurso"
   href equals the fixture's `link`, "ver en Discord" href unchanged.
3. **DocsView renders the resource (FR17, F2, D3)** — the main cell shows title (single-line
   ellipsis, keeps `data-testid="doc-row-content"` + read/unread color/weight semantics),
   description (NEW `data-testid="doc-row-description"`, 2-line clamp, `--text-muted`), and a
   "ver recurso" anchor that opens `doc.link` in a new tab AND bubbles to the row's
   mark-read handler (NO `stopPropagation`). PRESERVED: grid `1fr 130px 130px 96px`, dot
   testid/geometry/read-state, channel/author/date cells, optimistic mark-read + revert,
   server-side `channelId`/`unreadOnly` filters, "Cargar más", mark-all snapshot revert,
   sidebar badge bubbling via `onUnreadChange`. `DocsView.test.tsx` gains assertions: title +
   description rendered separately, anchor href equals `doc.link`, **anchor click calls
   `markRead` (bubbling, D6)**, read-state styling still switches on `doc-row-content`.
4. **DocsView copy de-chunked (F4)** — table header labels become `recurso / canal / autor /
   indexado`; the intro description becomes exactly: *"Cada recurso es un link compartido en la
   comunidad, enriquecido con título y descripción por IA. El punto ámbar marca los recursos
   sin leer — tocá una fila para marcarla como leída."* UNCHANGED: both empty-state texts, the
   "Sin leer · N" toggle, "Marcar todas como leídas", "mostrando X de Y" (specs assert them).
   `docs.spec.ts` is patched ONLY on the stale anchors (`getByText('chunk', { exact: true })` →
   `'recurso'`); no other spec line changes.
5. **CitationChip cites the real resource (FR18, F3, D4)** — the chip renders `citation.title`
   (truncated, `--text-primary`) between the channel badge and the author, and links to
   `citation.link` (`target="_blank" rel="noopener noreferrer"`); the stale placeholder href +
   comment are deleted. PRESERVED: `data-testid="chat-citation"`, `.kh-chat-citation` class +
   blurple hover, avatar initials, `#channel` amber mono badge, author, `ExternalLinkIcon`,
   "Fuentes" label block, flex-wrap chips row. `ChatWidget.test.tsx` gains assertions on BOTH
   citation paths (streamed frame + history load): chip shows the fixture title and
   `href === citation.link`.
6. **UX-DRs speak resources (SCP §4.7)** — `epics.md` UX-DR11, UX-DR12, UX-DR13 and UX-DR21
   are rewritten to describe the new reality: DR11 card = title heading + description body +
   "ver recurso" + "ver en Discord"; DR12 header/intro wording per AC-4; DR13 column
   `recurso` = dot + title (ellipsis) + description clamp-2 + link anchor, click-marks-read
   preserved incl. bubbling anchor; DR21 chip = avatar + #canal + **título del recurso** +
   autor + icono externo, href = link del recurso. Keep the pixel values that did not change
   (they are the 4.3/4.4/5.4 implemented reality).
7. **Docs sync (§3.5)** — `docs/api-spec.yml`: `title` fields documented as non-empty
   (`minLength: 1`) on search/documents fragments + Citation; `docs/context/ARCHITECTURE-SPINE.md`
   AD-6 note: title non-empty since 7.5; `docs/context/TECHNICAL-DESIGN.md` §12 citation-frame
   note gains "title es no-vacío (7.5)" and §5.5's view descriptions mention title/description/
   link rendering; `deferred-work.md` title-`''` entry marked resolved (AC-1). No
   `operational-backlog.md` runbook change needed — the 7.4 clean-slate note already covers all
   pre-pivot data (record this reasoning in the story on completion).
8. **Verification gate + §3.4 harness run (AGENT-run)** — `npm run lint` (0) && `npm run test`
   (unit+web, new SearchView/DocsView/ChatWidget/schema cases green) && `npm run build`
   (5 pkgs) && `npm run test:integration` (backend suites untouched but MUST re-run — a shared
   contract changed; expected 120 pass, no fixture uses an empty title) &&
   `npm run test:e2e -w @share2brain/web` (13 chromium, pass-count unchanged, only the AC-4 anchor
   patches) + screenshots captured. Explicitly flag in the completion notes that the NEW
   elements' visual/CSS ACs (title typography, link hovers, chip title styling) are deferred to
   the 7.6 harness extension per the epic plan — named, not silently passed.

## Tasks / Subtasks

- [x] Task 0 — Branch + preconditions (AC: all)
  - [x] `git branch --show-current` → if `main`, `git switch -c feat/7-5-web-resource-rendering`.
  - [x] Baseline sanity: `npm run test -w @share2brain/web` green before touching anything.
- [x] Task 1 — Shared `title: .min(1)`, tests-first (AC: 1)
  - [x] Flip `citation.test.ts` / `search.test.ts` / `documents.test.ts` / `sse.test.ts` red
        with reject-empty-title cases, then add `.min(1)` in `citation.ts` / `search.ts` /
        `documents.ts`. Refresh each schema's doc comment (title: AI-generated, non-empty).
  - [x] Grep: no active `title: ''` fixture survives; `satisfies` guards compile.
- [x] Task 2 — `.kh-resource-link` class (AC: 2, 3)
  - [x] Add to `packages/web/src/styles/components.css` with base color in the class + amber
        hover (D2, cascade rule comment like the neighbors).
- [x] Task 3 — SearchView card (AC: 2)
  - [x] Insert the `<h3>` title + demote description per D1; add the footer links group
        ("ver recurso" + existing "ver en Discord").
  - [x] `SearchView.test.tsx`: title-rendered, resource-href, discord-href-unchanged cases.
- [x] Task 4 — DocsView row + copy (AC: 3, 4)
  - [x] Restructure the main cell per D3 (testid placement is load-bearing for docs.spec);
        anchor bubbles (F2, no stopPropagation).
  - [x] Header label + intro copy per AC-4 (exact Spanish strings).
  - [x] `DocsView.test.tsx`: title/description split, anchor href, bubbling-mark-read (D6),
        read-state styling still on `doc-row-content`.
- [x] Task 5 — CitationChip (AC: 5)
  - [x] Redesign per D4; delete the stale comment + placeholder href.
  - [x] `ChatWidget.test.tsx`: title + href assertions on streamed AND history-loaded citations.
- [x] Task 6 — e2e anchor patches + full run (AC: 4, 8)
  - [x] Patch `docs.spec.ts` `'chunk'` anchor → `'recurso'`; run all 13 chromium specs; fix
        NOTHING else unless a spec broke on a stale text anchor this story changed (then patch
        minimally and record it).
- [x] Task 7 — UX-DR revision + docs sync (AC: 6, 7)
  - [x] Rewrite UX-DR11/12/13/21 in `epics.md`; sync api-spec.yml / SPINE AD-6 /
        TECHNICAL-DESIGN §5.5+§12; mark the deferred-work entry resolved.
- [x] Task 8 — Gate + finish (AC: 8)
  - [x] Full gate (lint / unit+web / build / integration / e2e), paste evidence; flag the
        7.6-deferred visual ACs by name; flip sprint-status to review; commit in slices; PR.

## Dev Notes

### Architecture compliance (invariants that bind this story)

- **AD-3**: static SPA — no SSR, no server code in web. API types come ONLY from `z.infer<>`
  of `@share2brain/shared/schemas` (ESLint `no-restricted-imports` bans the root barrel and `/db`).
- **AD-6**: the `.min(1)` change is scoped `shared`; web consumes it by inference. Never
  redefine request/response shapes in web.
- **AD-2**: no cross-service imports. This story touches `shared` + `web` + docs only.
- **Epic 4 retro AI#4 (cascade rule)**: any border/color/background that changes on
  `:hover`/`:focus` must have its BASE value in the `kh-*` class in `components.css`, never
  inline — an inline shorthand outranks the stylesheet pseudo-class (memorialized at
  `ChatWidget.tsx:1009-1011` and `components.css:64-68`).
- **English only** in code/comments/tests/commits; UI copy is Spanish (existing convention);
  seed data stays Spanish (user-visible product data).

### Current state — verbatim anchors (verified 2026-07-09, main @ 889c11e)

**Contracts + data are done (7.1/7.4). Rendering is the only gap. Do not re-plumb.**

- `packages/web/src/components/SearchView.tsx` (views live in `components/`, no `views/` dir):
  debounce 250ms `:22`, min length 2 `:23`, AbortController per keystroke `:62-82`,
  client-side chip filter `:86`. ResultCard `:281-394`: card `kh-result-card` + inline
  padding/bg/radius (base border in class, comment `:292-293`); channel pill `:301-313`; date
  `Intl.DateTimeFormat('es', { dateStyle: 'medium' })` `:282-284`; similarity bar testid +
  gradient `:317-335` + `.toFixed(2)` `:336-338`; **body renders ONLY `fragment.description`**
  `:342-352` (14.5px/1.6/`--text-primary`/`overflowWrap:'anywhere'`); footer avatar
  (`authorColor`/`initialsFromUsername` libs) `:355-373`; "ver en Discord" `:374-390` with
  `link = https://discord.com/channels/${guildId}/${fragment.channelId}/${fragment.messageId}`
  `:286` — this deep link SURVIVES unchanged next to the new resource link.
- `packages/web/src/components/DocsView.tsx`: fetch + filters `:58-89` (PAGE_SIZE 20,
  server-side `channelId`/`unreadOnly`); `handleRowClick` `:125-134` (one-way optimistic
  `markRead`, no-op if read, revert on failure, `onUnreadChange()` bubbles to App);
  mark-all snapshot revert `:136-152`; header grid + labels `chunk / canal / autor / indexado`
  `:305-324` (label "chunk" at `:320` — F4 target); stale intro "Cada chunk proviene de
  mensajes agrupados por autor y ventana temporal…" `:179-180` (F4 target). DocRow `:403-499`:
  `kh-doc-row` + `data-read` + grid + `cursor:'pointer'`; dot `:423-432`; **main cell = ONE
  clamped span rendering `doc.description`** `:434-449` with `data-testid="doc-row-content"`
  (13.5px, clamp 2, read-state color/weight — docs.spec asserts THESE on THIS testid);
  channel `:452-454`; author `:456-485`; date from `indexedAt` `:404,487-496`. **No anchor
  exists anywhere in DocsView today.**
- `packages/web/src/components/ChatWidget.tsx`: SSE citation handler ALREADY captures all 5
  fields `:300-313`; history path passes `citations: m.citations` through `:218`; Citations
  block ("Fuentes" label + flex-wrap) `:927-949` with `key={`${c.channel}-${c.author}-${i}`}`;
  **CitationChip `:951-998`** — stale comment `:953-954` + placeholder
  `href="https://discord.com/channels"` + renders avatar/`#channel`/author/icon, **neither
  `citation.title` nor `citation.link`**; `authorInitials` `:1004-1007` (Unicode-aware).
- API clients (`packages/web/src/api/`): all four parse responses through the shared Zod
  schemas (`SearchResponseSchema` / `DocumentsResponseSchema` / `SSEFrameSchema` /
  `ConversationDetailSchema`) — the new fields already FLOW into components; no client change
  needed in this story.
- Shared schemas (post-7.4): `search.ts` fragment `{ id, title, description,
  link(strict isHttpUrl), channelId, channelName, authorId, authorName, createdAt, similarity,
  messageId }`; `documents.ts` = same minus similarity plus `indexedAt`+`isRead`; `citation.ts`
  `{ title, channel, author, date, link(strict) }` + bidirectional `satisfies` guards vs the
  `Citation` interface; `sse.ts` citation frame extends `CitationSchema.shape`;
  `linkRefine.ts` `isHttpUrl` rejects `''`/whitespace/non-parseable/non-http(s)/empty-host —
  **a parsed link is always a safe href**. `authorName` = `authorId` fallback (D2 Epic 4) —
  do NOT "fix".
- Icons: `packages/web/src/components/icons.tsx` — 14 exports incl. `ExternalLinkIcon`
  (`:133`, default size 13, `stroke="currentColor"`, `aria-hidden`). No new icon needed.
- External-link convention (only 2 sites today, both `target="_blank" rel="noopener noreferrer"`,
  `textDecoration:'none'`, trailing icon): `kh-discord-link` (hover blurple) and
  `kh-chat-citation` (hover border blurple). The new `.kh-resource-link` joins this family
  with the amber hover (D2).

### CSS tokens + classes (real names — the prototype's `--tx*` are STALE)

- Dark `:root` tokens (`styles/global.css:19-30`): `--surface #12161D`, `--card`, `--track`,
  `--line`, `--border #20262F`, `--border-strong`, `--border-hover`, `--dot-read #272E39`,
  `--text-primary #E6E9EF`, `--text-secondary #C7CDD8`, `--text-tertiary #9AA3B2`,
  `--text-muted #7C8494`, `--text-subtle #646C7C`, `--accent-ink #F5A623`, `--on-accent`.
  Light theme swaps all (`--accent-ink #9A5B00`). Allowed raw hex outside tokens: `#F5A623`/
  `#FFCB6B` amber, `#5865F2` Discord, `#3BA55D` positive, `#ED4245` danger.
- Existing hover classes in `components.css`: `.kh-result-card`, `.kh-chip`,
  `.kh-discord-link`, `.kh-doc-row`, `.kh-load-more`, `.kh-mark-all`, `.kh-unread-toggle`,
  `.kh-chat-citation`, `.kh-search-input:focus`. Mimic their structure/comments for
  `.kh-resource-link`.
- Typography (UX-DR2): Space Grotesk 500/600/700 = titles/brand; IBM Plex Sans = body;
  IBM Plex Mono = metadata/badges.

### Playwright landscape — what must stay green vs what 7.6 owns

- 13 chromium specs, `workers:1`, dark theme forced by `loginAs`; mutating tests LAST per file.
- `search.spec.ts`: asserts heading "Búsqueda de conocimiento" typography, `.kh-search-input`
  focus ring, first `.kh-result-card`'s `#general` badge CSS, `similarity-bar` 54×5 geometry +
  gradient, avatar "E2" 24px round, chips active/inactive CSS, `search-empty-state` + exact
  empty copy. **Nothing asserts the card body text** → D1's title/description restructure is
  spec-safe. Do not rename testids/classes it anchors.
- `docs.spec.ts`: asserts `.kh-doc-row` grid `/^\d+(\.\d+)?px 130px 130px 96px$/` (grid must
  survive), header cell `getByText('chunk', { exact: true })` CSS (**the ONE anchor F4
  patches** → `'recurso'`), `doc-row-dot` + `doc-row-content` read/unread colors+weights
  (**keep the testid on the element that carries the read-state styling — the title span,
  D3**), row hover, sidebar badge, mark-all + empty-state exact copy ("¡Estás al día! No te
  quedan fuentes sin leer." / "Quitá el filtro…" — UNCHANGED by F4 on purpose).
- `chat.spec.ts`: `chat-citation` first chip `toContainText('#general')` + border hover
  blurple (`:199-203`), streamed citations `count >= 1` (`:228-229`), and the EXACT seeded
  assistant answer text (`:39`) — none of these break under D4 as long as `#channel` text,
  testid, class and hover survive; the seeded answer is backend data, untouched.
- `interactions.spec.ts`: nav/theme — unaffected.
- e2e seed data (7.4): 5 resources with realistic Spanish titles + `https://example.com/e2e/…`
  links; `CONVERSATION_CITATIONS` carries a real title+link → the history-load chip will show
  a real title in e2e. 7.6 will assert it; this story only must not crash on it.
- §3.4 fallback clause: if this session has no browser runner, run what §3.3 allows, flag every
  unverified visual AC by name in notes + PR body. With the runner available: run all 13.

### Test landscape — unit (jsdom, NO jest-dom)

- Patterns: `vi.mock` the api module per view; `cleanup()` + `vi.clearAllMocks()` in
  `afterEach`; assertions via `toBeTruthy()`/`toBeNull()`/`.textContent`/`getAttribute` —
  **never `toHaveTextContent`/`toHaveAttribute`** (no jest-dom installed; 5.4 gotcha).
- Fixtures ALREADY carry the new fields: `SearchView.test.tsx:21-47` (`FRAGMENT_GENERAL`
  title 'The Answer to Everything', link `https://example.com/e2e/the-answer`),
  `DocsView.test.tsx:25-54` (`DOC_UNREAD`/`DOC_READ` with title+link),
  `ChatWidget.test.tsx:320-326` (streamed) + `:459-466` (history) citation with title+link.
  Only ASSERTIONS are missing — add them, don't rebuild fixtures.
- The F2 bubbling test: `fireEvent.click` on the anchor → assert the mocked `markRead` was
  called with the doc id (D6 jsdom navigation-noise caveat).
- Shared: `npm run test -w @share2brain/shared` covers the AC-1 flips fast during TDD.

### Do-NOT-touch look-alikes

Row-click mark-read semantics + optimistic revert logic (only ADD the anchor) · offset
pagination + "Cargar más" (deferral stands) · `similarity-bar` geometry/gradient ·
`kh-doc-row` grid template · empty-state copy in BOTH views (specs assert verbatim) · seeded
assistant answer text (chat.spec:39) · `authorName = authorId` fallback · SSE frame handling /
`streamChat` parser · `config` `base_url` refines (different convention from `isHttpUrl`) ·
`unreadOnly` `z.stringbool()` · anything in `packages/backend`/`workers`/`bot`.

### Previous story intelligence (4.3/4.4/5.4 + 7.4)

- 7.4 delivered the strict contracts + real data everywhere and left ONE deferral this story
  closes (title `''`); its review dismissed the read-back-parse blast radius as ratified D3 —
  don't reopen it here.
- 4.3/4.4 reviews: error-copy exactness, `activeChannelId` reset on query change,
  `overflowWrap:'anywhere'` (long URLs in descriptions!), mark-all Map-based snapshot revert —
  all present in current code; preserve through the restructure.
- 5.4 review round-3 focus-trap learnings live in ChatWidget — the chip redesign touches ONLY
  `CitationChip` + its tests; do not disturb the focus/overlay logic.
- web inline-border cascade gotcha (Epic 4 defect): base border/color in the class, inline only
  for deliberate active states.
- Standing DoD (`operational-backlog.md`): new tests must discriminate (revert-and-rerun when
  in doubt); never log content; review patches are re-reviewed as new code.

### Git intelligence

Main @ `889c11e` (PR #48 merged — 7.4). Branch: `feat/7-5-web-resource-rendering`.
Suggested slices (Conventional Commits, English, ≤72 chars):
1. `feat(shared): require non-empty resource titles` — `.min(1)` + schema tests.
2. `feat(web): render resource title and link in search and docs` — SearchView + DocsView +
   `.kh-resource-link` + unit tests + docs.spec anchor patch.
3. `feat(web): citation chips cite the resource title and link` — CitationChip + tests.
4. `docs(repo): resource wording for UX-DRs and contract docs` — epics.md UX-DRs + api-spec +
   SPINE + TECHNICAL-DESIGN + deferred-work.

### Project Structure Notes

- NO new files except test additions inside existing suites; one new CSS class in
  `components.css`. No new packages/deps/migrations, no root `src/`.
- Views live in `packages/web/src/components/` (SearchView/DocsView/ChatWidget) — there is no
  `views/` directory; don't create one.
- If compilation demands touching a file outside this story's lists, STOP and re-check —
  that's 7.6 (harness) or backend scope leaking in.

### References

- [Source: _bmad-output/planning-artifacts/epics.md:30-36 (FR16/FR17/FR18), :87-133 (UX-DR2/10/11/12/13/14/21), :992-1011 (Épico 7)]
- [Source: _bmad-output/planning-artifacts/sprint-change-proposal-2026-07-09.md §4.7 (Frontend: title heading + "ver recurso" + DocsView title+clamp + citation chip), §4.2 (contracts), Resolved item 1 (citation link v1)]
- [Source: _bmad-output/implementation-artifacts/7-4-…md (strict contracts, Citation.title F3 "so the 7.5 sources chip can show the resource title", seed realism, review deferral title '')]
- [Source: _bmad-output/implementation-artifacts/deferred-work.md:141 (pagination deferral), :145 (trace panel), :153 (isHttpUrl caveats), :172 (title '' — CLOSED by AC-1)]
- [Source: _bmad-output/implementation-artifacts/4-3-web-app-vista-busqueda.md (card spec :163-174, token table :141-151, review patches :123-127)]
- [Source: _bmad-output/implementation-artifacts/4-4-…md (row/table spec, token table :156-168, optimistic patterns)]
- [Source: _bmad-output/implementation-artifacts/5-4-…md:439-445 (chip geometry), :454-460 (obsolete placeholder-href note)]
- [Source: docs/context/TECHNICAL-DESIGN.md §5.5:345-373 (SPA/views), §12 (citation frame title REQUIRED "permite renderizar el título del recurso en el chip de fuentes")]
- [Source: docs/context/ARCHITECTURE-SPINE.md AD-2/AD-3/AD-6]
- [Source: docs/api-spec.yml:112,156 (search/documents resource wording), Citation schema]
- [Source: docs/bmad-story-mandatory-steps.md §3.1 (gate), §3.4 (Playwright mandatory when UI affected + fallback clause), §3.5 (docs)]
- [Source: docs/frontend-standards.md + packages/web/src/styles/{global,components}.css (tokens, cascade rule)]
- [Source: packages/web/tests/{search,docs,chat,interactions}.spec.ts (anchored testids/classes/copy)]

## Dev Agent Record

### Agent Model Used

Claude Sonnet 5

### Debug Log References

None — no blocking issues; all tests went red-then-green on first implementation per task.

### Completion Notes List

- AC-1: `CitationSchema`/`SearchFragmentSchema`/`DocumentFragmentSchema` `title` tightened to
  `z.string().min(1)`; reject-empty-title cases added to `citation.test.ts`, `search.test.ts`,
  `documents.test.ts` and `sse.test.ts` (6 new/extended assertions, all red-then-green). Grep
  confirmed no active `title: ''` fixture survives outside test files — the one hit
  (`packages/workers/src/enrichment/htmlText.ts:110`) is an unrelated internal `PageHints.title`
  used only as an enrichment input hint, not the `Citation`/fragment contract. The
  `Citation`/`CitationType` bidirectional `satisfies` guards in `citation.ts` compile unchanged
  (`''` is a runtime value, not a type). Closes the deferred-work.md entry (marked RESOLVED).
- AC-2/AC-3/AC-5: SearchView gained an `<h3>` title heading (Space Grotesk 600 15.5px) above the
  description and a "ver recurso" footer link (new `.kh-resource-link` class, D2) alongside the
  unchanged "ver en Discord" deep link; DocsView's main cell now shows title (kept
  `data-testid="doc-row-content"` + read-state styling) → description (new
  `data-testid="doc-row-description"`, 2-line clamp) → a bubbling "ver recurso" anchor (no
  `stopPropagation`, F2 — opening the resource also marks the row read); CitationChip now shows
  the resource `title` and links to `citation.link` (deleted the stale 5.4 placeholder-href
  comment). All per the ratified D1/D3/D4 layouts.
- AC-4: DocsView table header `chunk` → `recurso`; intro copy replaced with the exact ratified
  Spanish string. `docs.spec.ts` patched only on the `getByText('chunk', ...)` anchor.
- `.kh-resource-link` (D2): base color `var(--text-muted)` lives in the CSS class (not inline),
  amber hover — avoids the Epic 4 inline-cascade gotcha that silently kills a hover when the same
  property is set inline (as `.kh-discord-link`'s pre-existing `color` already does, untouched
  per the do-not-touch list).
- AC-6/AC-7: UX-DR11/12/13/21 rewritten in `epics.md` to describe title/description/link
  rendering (pixel values that didn't change were preserved); `docs/api-spec.yml` documents
  `title` as `minLength: 1` on the SSE citation frame and the `Citation` component schema, plus
  the search/documents endpoint descriptions; `ARCHITECTURE-SPINE.md` AD-6 gained a note on the
  non-empty guarantee; `TECHNICAL-DESIGN.md` §5.5's view table and the §9 citation-frame note
  (referenced as "§12" in the story's Dev Notes — the actual prose lives in §9, "Agente RAG:
  LangGraph StateGraph"; no separate §12 citation-title note exists to update) both mention the
  new rendering/non-empty guarantee. No `operational-backlog.md` runbook change was needed — the
  existing 7.4 clean-slate note already covers all pre-pivot data, and this story adds no new
  persisted-data caveat (AC-7 reasoning, recorded here per the story's explicit instruction).
- AC-8 (verification gate, full evidence below): `npm run lint` → 0 errors. `npm run test` → 809
  passed, 1 skipped (unit+web; +8 vs. the 4.4/5.4-era baseline story mentions, exact count driven
  by this story's new/extended assertions). `npm run build` → clean across all 5 packages
  (backend/bot/shared/workers `tsc --noEmit`, web `vite build`). `npm run test:integration` → 120
  passed across 19 files (backend/bot/workers; unchanged count — no fixture used an empty title).
  `npm run test:e2e -w @share2brain/web` → 13/13 chromium specs passed (pass-count unchanged), only the
  `docs.spec.ts` anchor patch. Screenshots captured by the harness under
  `packages/web/test-results/` (not committed, per existing convention).
- **Explicitly flagged per AC-8**: the NEW elements' visual/CSS acceptance criteria — the
  SearchView `<h3>` title typography (Space Grotesk 600 15.5px), the `.kh-resource-link` hover
  color transition, and the CitationChip title styling (`--text-primary`, ellipsis/max-width) —
  are **NOT** asserted by any `getComputedStyle` Playwright check in this story. They render
  correctly (all 13 existing specs pass unchanged, and jsdom unit tests assert the text/href
  content) but their *pixel-level* verification is deliberately deferred to Story 7.6 (harness
  extension), per the epic plan. Named here, not silently passed.
- No new dependencies, no DDL/migration, no new endpoints, no new icons (`ExternalLinkIcon`
  already existed at `icons.tsx:133`), no router/data-library/AppLayout changes — matches D7.

### File List

- `packages/shared/src/schemas/citation.ts` — `title: z.string().min(1)` + doc comment
- `packages/shared/src/schemas/citation.test.ts` — reject-empty-title case
- `packages/shared/src/schemas/search.ts` — `title: z.string().min(1)` + doc comment
- `packages/shared/src/schemas/search.test.ts` — reject-empty-title case
- `packages/shared/src/schemas/documents.ts` — `title: z.string().min(1)` + doc comment
- `packages/shared/src/schemas/documents.test.ts` — reject-empty-title case
- `packages/shared/src/schemas/sse.test.ts` — reject-empty-title citation-frame case
- `packages/web/src/styles/components.css` — new `.kh-resource-link` class (base + hover)
- `packages/web/src/components/SearchView.tsx` — title heading, demoted description, "ver
  recurso" footer link
- `packages/web/src/components/SearchView.test.tsx` — title/resource-link assertions
- `packages/web/src/components/DocsView.tsx` — main-cell restructure (title/description/anchor),
  header label + intro copy rename
- `packages/web/src/components/DocsView.test.tsx` — title/description/anchor/bubbling/read-state
  assertions; `'chunk'` → `'recurso'` anchor updates
- `packages/web/src/components/ChatWidget.tsx` — CitationChip redesign (title span, `href` =
  `citation.link`, stale comment removed)
- `packages/web/src/components/ChatWidget.test.tsx` — citation title/href assertions (streamed +
  history paths)
- `packages/web/tests/docs.spec.ts` — `'chunk'` → `'recurso'` header-cell anchor patch
- `_bmad-output/planning-artifacts/epics.md` — UX-DR11/12/13/21 rewritten
- `docs/api-spec.yml` — `title` documented as `minLength: 1` (Citation + SSE citation frame),
  search/documents endpoint descriptions updated
- `docs/context/ARCHITECTURE-SPINE.md` — AD-6 note on non-empty `title`
- `docs/context/TECHNICAL-DESIGN.md` — §5.5 view table + §9 citation-frame note updated
- `_bmad-output/implementation-artifacts/deferred-work.md` — title `''` entry marked RESOLVED
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — status transitions
  (ready-for-dev → in-progress → review)

## Change Log

- 2026-07-09 — Story created (bmad-create-story). 4 forks confirmed with Borja: F1 `title`
  tightened to `.min(1)` in shared (closes the 7.4 review deferral), F2 DocsView "ver recurso"
  anchor bubbles to mark-read (no stopPropagation), F3 citation chip shows the resource title +
  links to `citation.link` (keeps chat.spec anchors), F4 "chunk" header/copy renamed to
  resource wording now (docs.spec anchor patched minimally). Scope: rendering + copy + UX-DR
  revision + one shared guarantee; no new deps, no DDL, no backend change. New-field visual
  harness assertions stay Story 7.6. Status: ready-for-dev.
- 2026-07-09 — Story implemented (bmad-dev-story), branch `feat/7-5-web-resource-rendering`,
  baseline `889c11e`. Shared `title` tightened to `.min(1)` (F1, closes the review deferral);
  SearchView gained an `<h3>` title + "ver recurso" link (D1/D2); DocsView main cell restructured
  into title/description/bubbling-anchor (D3/F2) with de-chunked copy (F4); CitationChip now
  shows the resource title and links to `citation.link` (D4/F3). UX-DR11/12/13/21 + api-spec +
  ARCHITECTURE-SPINE AD-6 + TECHNICAL-DESIGN synced; deferred-work title-`''` entry resolved. Gate
  green: lint 0 / 809 unit+web (+8) / build clean (5 pkgs) / 120 integration (unchanged) / 13 e2e
  chromium (unchanged, only the `docs.spec.ts` anchor patch). New-field visual/CSS ACs (title
  typography, link hovers, chip title styling) explicitly flagged as deferred to Story 7.6 per
  the epic plan — not silently passed. Status: review.

### Review Findings

Code review 2026-07-09 (bmad-code-review, 3 adversarial layers @ Opus: Blind Hunter /
Edge Case Hunter / Acceptance Auditor). Acceptance Auditor: all 8 ACs satisfied, 0 violations,
no do-not-touch breach, tests discriminating. 3 findings dismissed as noise (anchor-re-marks
already-read = false positive, handleRowClick early-returns on isRead; `doc-row-content` testid
carrying title = intentional per D3, no consumer breaks; §12→§9 spec-ref drift = self-noted,
content correct).

- [x] [Review][Patch] Harden resource `title` to `.trim().min(1)` [citation.ts / search.ts /
  documents.ts] — APPLIED (Borja, 2026-07-09). `.min(1)` accepted `" "`, `"\n"`, zero-width-space
  → blank `<h3>`/`doc-row-content`/chip. Made the "non-empty" doc-comment promise structural in the
  shared contract instead of relying solely on the enrichment write-path guard. Added whitespace-
  only reject cases to citation/search/documents/sse tests. Gate re-run: lint 0 / 813 unit+web
  (+4) / build clean (5 pkgs) / shared typecheck clean (satisfies guards compile). Integration+e2e
  not re-run (whitespace-only tightening; no fixture/seed carries such a title — risk nil).
- [x] [Review][Defer] "ver recurso" mark-read misses middle-click / context-menu open-in-new-tab
  [DocsView.tsx] — deferred (Borja, 2026-07-09): accepted as a known F2 limitation. The context
  menu fires no event at all, so covering only middle-click (`auxclick`) would be partial anyway;
  primary/modifier click + keyboard cover the main interaction (row click / link click).
- [x] [Review][Defer] `.min(1)` widens the whole-response parse-poison blast radius — deferred,
  pre-existing (ratified D3). `searchService.ts:52` / `documentService.ts:75` `.parse()` the whole
  response (one empty-title row → 500 for the entire page) while `ragRetriever.drizzle.ts:30`
  `safeParse`s per row and skips-and-warns. Only theoretical given the write-path guard; Story 7.4
  review ratified this fail-fast asymmetry — spec says don't reopen.
- [x] [Review][Defer] New per-card `<h3>` title may skip heading hierarchy (a11y) [SearchView.tsx]
  — deferred, minor. If the page has no `<h2>` ancestor the result cards emit orphan h3s; a
  screen-reader-navigation nit, not a functional break. Low value.
- [x] [Review][Defer] Completion-note AC-1 grep under-reports [sync.integration.test.ts:589,633]
  — deferred, doc-accuracy only. Two more `title: ''` raw-DB seeds exist (`seedEmbedding` for the
  soft/hard-delete path tests, in `workers` do-not-touch, never contract-parsed, ratified pre-pivot
  seeds). AC-1's substantive guarantee holds; only the note's literal "no `title: ''` in active
  fixtures/seeds" phrasing is imprecise.
