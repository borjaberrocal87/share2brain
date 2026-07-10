---
baseline_commit: 2359adfec85b3f1ee7e637fdc2ff16ec0d5f485d
---

# Story 2.1: Design system in packages/web

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a community member,
I want the Share2Brain interface to have a consistent visual identity with light/dark theme support,
so that the experience is professional and adaptable to my preferences.

## Acceptance Criteria

1. **Design tokens (both themes).** The global stylesheet in `packages/web` defines all CSS custom properties for both `[data-kh="dark"]` and `[data-kh="light"]`: `--bg`, `--bg-deep`, `--surface`, `--card`, `--hover-row`, `--track`, `--line`, `--border`, `--border-strong`, `--border-hover`, `--dot-read`, `--tx` through `--tx5`, `--hover`, `--on-accent`, `--accent-ink`. (AC set explicitly names a subset; implement the **full** vocabulary above — later Epic 2/4/5 stories consume every one of these and must not have to re-touch global CSS. See Dev Notes → Token table for exact values.)

2. **Typography — 3 families from Google Fonts.** The app loads Space Grotesk (500/600/700), IBM Plex Sans (400/500/600), and IBM Plex Mono (400/500/600) from Google Fonts. The `body` `font-family` is `'IBM Plex Sans', system-ui, sans-serif`.

3. **Hexagonal brand component.** A reusable React component renders the Share2Brain hexagon: `clip-path: polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)` with `linear-gradient(150deg, #FFCB6B, #F5A623)`, in a **nested structure** (outer amber gradient → inner bg-color hexagon → amber dot hexagon). It supports at least the 3 size variants this epic needs: **74px** (login), **32px** (sidebar / chat header), **30px** (agent avatar in messages). See Dev Notes → Hexagon spec for exact inner dimensions per size.

4. **Six `@keyframes`.** The stylesheet defines all six animations: `kh-spin` (0.7s linear rotate), `kh-blink` (1s step-end opacity toggle), `kh-up` (translateY 10px fade-in), `kh-float` (translateY + rotate loop), `kh-pop` (translateY 6px + scale 0.98 entrance, 0.2s), `kh-pulse` (scale 0.85→1 + opacity 0.35→1, 1.4–1.6s). Copy the exact definitions from Dev Notes → Keyframes.

5. **Theme values resolve correctly.** With `data-kh="dark"` on the root, `--accent-ink` resolves to `#F5A623` and `--on-accent` to `#0E1116`. With `data-kh="light"`, `--accent-ink` resolves to `#9A5B00` (and `--on-accent` stays `#0E1116`). The root element defaults to `data-kh="dark"`.

## Tasks / Subtasks

- [x] **Task 1 — Global stylesheet with design tokens (AC: 1, 5)**
  - [x] Create `packages/web/src/styles/global.css` (new).
  - [x] Add base reset: `* { box-sizing: border-box; }`, `html, body { margin:0; padding:0; }`, `body { background: var(--bg); color: var(--tx); font-family: 'IBM Plex Sans', system-ui, sans-serif; -webkit-font-smoothing: antialiased; }`, `textarea, input, button { font-family: inherit; }`, and the scrollbar / `::selection` rules (see Dev Notes → Base reset).
  - [x] Add the `:root, [data-kh="dark"]` and `[data-kh="light"]` token blocks **verbatim** from Dev Notes → Token table.
  - [x] Do NOT hardcode any UI color outside these token blocks (raw hex is allowed only for the fixed brand colors documented in Dev Notes: amber `#F5A623`/`#FFCB6B`, Discord `#5865F2`, positive `#3BA55D`, danger `#ED4245`).

- [x] **Task 2 — Load the 3 Google Font families (AC: 2)**
  - [x] Add the preconnect + stylesheet `<link>` tags to `packages/web/index.html` `<head>` (see Dev Notes → Fonts). Prefer `<link>` over CSS `@import` for a single non-render-blocking request with `display=swap`.
  - [x] Verify the `body` `font-family` fallback chain in `global.css` is exactly `'IBM Plex Sans', system-ui, sans-serif`.

- [x] **Task 3 — Define the six keyframes (AC: 4)**
  - [x] Add all six `@keyframes` (`kh-spin`, `kh-blink`, `kh-up`, `kh-float`, `kh-pop`, `kh-pulse`) to `global.css`, verbatim from Dev Notes → Keyframes.

- [x] **Task 4 — Reusable Hexagon component (AC: 3)**
  - [x] Create `packages/web/src/components/Hexagon.tsx` (new; PascalCase per naming convention).
  - [x] Props: `size: number` (outer px); optional `innerBg?: 'bg' | 'bg-deep'` (default `'bg'`, controls the inner hexagon fill via the corresponding CSS var); optional `showDot?: boolean` (default `true`, the amber center dot); optional `children?` and `className?`/`style?` passthrough for the login/chat contexts that place an icon inside.
  - [x] Render three nested `<div>`s each carrying the shared clip-path polygon. Outer = `linear-gradient(150deg,#FFCB6B,#F5A623)`; middle = `var(--bg)` or `var(--bg-deep)`; inner dot = `#F5A623`. Use the size→dimension mapping in Dev Notes → Hexagon spec (74→42/14, 32→18/6, 30→15/—) and interpolate proportionally for other sizes.
  - [x] Keep it presentational and dependency-free — no `@share2brain/shared` import needed (and the web ESLint guard bans the root barrel / `/db` / `/config` anyway).

- [x] **Task 5 — Wire global styles + default theme into the app entry (AC: 1, 5)**
  - [x] In `packages/web/src/main.tsx`: `import './styles/global.css';`.
  - [x] Ensure the root element carries `data-kh="dark"` by default. Set it on `document.documentElement` at startup (`document.documentElement.setAttribute('data-kh', 'dark')`) — the persistent toggle + `localStorage` logic is **Story 2.2**, not here.
  - [x] Keep the entry minimal: the full App shell (sidebar/header/login/router) is Story 2.2. A minimal placeholder render is fine; you may drop the old `HealthResponseSchema` contract-stub div (it was a scaffold proof from Story 1.3, no longer needed once real UI begins). Optionally render one `<Hexagon size={74} />` as a smoke check.

- [x] **Task 6 — Verification (mandatory gate)**
  - [x] Add a minimal Vitest + jsdom setup to `packages/web` (config + `jsdom` + `@testing-library/react` devDeps) and one `Hexagon.test.tsx` asserting the nested structure: three elements, the clip-path polygon present, and that `showDot={false}` omits the dot. (Register the web project in the root Vitest `test.projects` array — the Epic 1 retro established `test.projects`, NOT the removed `vitest.workspace.ts`.)
  - [x] Tokens, fonts, and keyframes are **verified manually** (jsdom does not apply external CSS or resolve custom properties from a stylesheet via `getComputedStyle`): the exact selectors and values were confirmed present in the compiled `dist` CSS (`[data-kh=dark]`/`[data-kh=light]` blocks; `accent-ink` dark `#f5a623` / light `#9a5b00`; `on-accent` `#0e1116`; all six `kh-*` keyframes) and the three font `<link>`s in the built `index.html`. Live `getComputedStyle`/Network confirmation via `npm run dev` remains a reviewer browser check — see Completion Notes.
  - [x] Run and paste output for: `npm run lint && npm run test && npm run build`. Never commit red. (Output pasted in Completion Notes; also ran `npm run typecheck`.)

## Dev Notes

### Scope boundary — what this story is NOT
This story delivers **only** the design-system foundation: tokens, fonts, keyframes, and the Hexagon primitive. It does **NOT** build the login screen, sidebar, header, router, theme toggle, or `localStorage` persistence — all of that is **Story 2.2** (which consumes this foundation). Do not build layout or app chrome here. [Source: epics.md#Historia 2.2]

### Authoritative source of truth for all values
The exact palette, fonts, keyframes, and hexagon structure below are extracted **verbatim** from the design prototype `docs/context/design/Share2Brain Web.dc.html` (the "kh"/Share2Brain prototype — origin of the `data-kh` attribute and `kh-*` animation names). When any doubt arises about a concrete value, that file is authoritative. The `_bmad-output` UX requirements UX-DR1–UX-DR4 and UX-DR23 describe the same system in prose. [Source: docs/context/design/Share2Brain Web.dc.html; epics.md#Requisitos de Diseño UX (UX-DR1–DR4, DR23)]

### Token table — copy verbatim into `global.css`
```css
:root, [data-kh="dark"] {
  --bg:#0E1116; --bg-deep:#0B0E13; --surface:#12161D; --card:#161B22; --hover-row:#141922; --track:#222934;
  --line:#181D25; --border:#20262F; --border-strong:#2A313D; --border-hover:#3A4250; --dot-read:#272E39;
  --tx:#E6E9EF; --tx2:#C7CDD8; --tx3:#9AA3B2; --tx4:#7C8494; --tx5:#646C7C;
  --hover:rgba(255,255,255,0.04); --on-accent:#0E1116; --accent-ink:#F5A623;
}
[data-kh="light"] {
  --bg:#F4F5F7; --bg-deep:#ECEEF1; --surface:#FFFFFF; --card:#FFFFFF; --hover-row:#EDEFF2; --track:#E2E5EA;
  --line:#ECEEF1; --border:#E2E5EA; --border-strong:#D3D8DF; --border-hover:#C2C8D1; --dot-read:#C7CCD4;
  --tx:#1B1F27; --tx2:#39414D; --tx3:#5C6573; --tx4:#79828F; --tx5:#99A1AD;
  --hover:rgba(0,0,0,0.05); --on-accent:#0E1116; --accent-ink:#9A5B00;
}
```
**Fixed brand colors** (not theme-dependent, referenced directly by later stories): amber accent `#F5A623` / highlight `#FFCB6B`; Discord `#5865F2`; positive/active `#3BA55D`; error/danger `#ED4245`. [Source: Share2Brain Web.dc.html:23-31; UX-DR1]

### Base reset — copy into `global.css`
```css
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { background: var(--bg); color: var(--tx); font-family: 'IBM Plex Sans', system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
::selection { background: rgba(245,166,35,0.3); }
*::-webkit-scrollbar { width: 10px; height: 10px; }
*::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 8px; border: 2px solid var(--bg); }
*::-webkit-scrollbar-thumb:hover { background: var(--border-hover); }
textarea, input, button { font-family: inherit; }
```
[Source: Share2Brain Web.dc.html:15-22]

### Fonts — add to `index.html` `<head>`
```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
```
Role of each family (informs later stories, not a 2.1 deliverable): Space Grotesk → titles / brand wordmark / section headers; IBM Plex Sans → body + general UI; IBM Plex Mono → metadata, timestamps, counts, channel badges, status labels, OAuth scopes, versions. [Source: Share2Brain Web.dc.html:11-13; UX-DR2]

### Keyframes — copy verbatim into `global.css`
```css
@keyframes kh-spin  { to { transform: rotate(360deg); } }
@keyframes kh-blink { 0%,49% { opacity: 1; } 50%,100% { opacity: 0; } }
@keyframes kh-up    { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
@keyframes kh-float { 0%,100% { transform: translateY(0) rotate(0deg); } 50% { transform: translateY(-14px) rotate(4deg); } }
@keyframes kh-pop   { from { opacity: 0; transform: translateY(6px) scale(0.98); } to { opacity: 1; transform: none; } }
@keyframes kh-pulse { 0%,100% { opacity: 0.35; transform: scale(0.85); } 50% { opacity: 1; transform: scale(1); } }
```
[Source: Share2Brain Web.dc.html:35-40; UX-DR23]

### Hexagon spec — exact nested dimensions per size
Shared polygon for every layer: `polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)`. Structure = 3 nested hexagons: **outer** `linear-gradient(150deg,#FFCB6B,#F5A623)` → **middle** background hexagon (`--bg` or `--bg-deep`) → **inner** amber dot `#F5A623`. Centered via `display:flex; align-items:center; justify-content:center`.

| Outer size | Middle (bg) hexagon | Dot | Middle fill | Context | Prototype ref |
|---|---|---|---|---|---|
| 74px | 42px | 14px | `--bg` | Login (shadow `0 12px 30px -8px rgba(245,166,35,0.6)`) | line 53-55 |
| 32px | 18px | 6px | `--bg-deep` | Sidebar logo | line 92-94 |
| 32px | 17px | — (no dot) | `--bg-deep` | Chat header (Epic 5) | line 298-299 |
| 30px | 15px | — | `--bg` | Agent avatar in messages | line 356-357 |
| 60px | 34px | — | `--bg` | Chat empty-state (Epic 5, "large" variant) | line 337-338 |

Design the component so `size` drives dimensions (74/32/30 required now; 60 and the no-dot chat variants land with Epic 5). Because inner-fill differs (`--bg` vs `--bg-deep`) and the dot is sometimes absent, expose `innerBg` and `showDot` props rather than hardcoding. A reasonable proportional rule if you don't special-case each size: middle ≈ 0.55 × outer, dot ≈ 0.19 × outer — but prefer the exact table values for the three required sizes. [Source: Share2Brain Web.dc.html:53-55,92-94,298-299,356-357; UX-DR3]

### Architecture compliance (non-negotiable)
- **AD-3 — static SPA only.** No Node server, no SSR. Vite builds to `dist/`, nginx serves it. Everything here is browser-side. [Source: project-context.md#Frontend rules; TECHNICAL-DESIGN.md §5.5]
- **Web import guard (Epic 1 retro action item #3).** `packages/web/**` may import only browser-safe `@share2brain/shared/schemas` / `@share2brain/shared/types/events`. The root barrel `@share2brain/shared` and `@share2brain/shared/db` / `@share2brain/shared/config` are banned by the `no-restricted-imports` rule in the root `eslint.config.js` (they pull in `pg` + Node built-ins and blew the bundle from 408 KB → 252 KB when removed). This story needs **no** shared import at all — keep it that way. [Source: eslint.config.js:32-47; epic-2-ac-verification-2026-07-04.md#Web/bundle prerequisite]
- **English only** in all code, comments, tests, commits. The Spanish strings in the prototype are UI copy for later stories, not 2.1 deliverables. [Source: project-context.md#Code quality & naming]

### Naming & file locations
- New: `packages/web/src/styles/global.css` (single stylesheet — tokens + reset + keyframes; splitting into `tokens.css`/`animations.css` is acceptable but unnecessary).
- New: `packages/web/src/components/Hexagon.tsx` (`PascalCase.tsx` for React components).
- Modify: `packages/web/index.html` (font links), `packages/web/src/main.tsx` (import CSS + set default `data-kh`).
- Modify: root `vitest` config `test.projects` + `packages/web/package.json` (add test setup for Task 6). [Source: project-context.md#Code quality & naming; #Testing rules]

### Testing standards
- Vitest, tests co-located as `*.test.ts(x)`; behavior-driven names (`should <behavior> when <condition>`), AAA. The Hexagon is a reusable primitive used across Epics 2/5 — worth a small structure test. [Source: project-context.md#Testing rules]
- Honest verification: token/font/keyframe ACs are CSS the test runner can't meaningfully assert under jsdom — verify them in the browser via `npm run dev` and DevTools, and say so in the completion notes. Do not fake a passing CSS assertion. [Source: project-context.md#Critical don't-miss]

### Project Structure Notes
- `packages/web/tsconfig.json` already sets `jsx: "react-jsx"` and `rootDir: "src"` — the Hexagon `.tsx` compiles without changes.
- `packages/web` currently has no Vitest config or test deps (only backend was set up in the Epic 1 retro). Task 6 adds a minimal one. If the team prefers to defer web unit testing until there is more UI (Story 2.2), that is a legitimate call — but then AC-level confidence for the Hexagon rests entirely on manual browser checks; flag it in completion notes. Recommendation: add the small setup now, since the primitive is reused everywhere.
- No conflicts with existing structure. `main.tsx`'s current `HealthResponseSchema` stub was a Story 1.3 scaffold proof and is safe to remove.

### References
- [Source: docs/context/design/Share2Brain Web.dc.html] — authoritative prototype (tokens L23-31, reset L15-22, fonts L11-13, keyframes L35-40, hexagons L53-55/92-94/298-299/337-338/356-357]
- [Source: _bmad-output/planning-artifacts/epics.md#Historia 2.1] — story + acceptance criteria
- [Source: _bmad-output/planning-artifacts/epics.md#Requisitos de Diseño UX] — UX-DR1 (tokens), UX-DR2 (fonts), UX-DR3 (hexagon), UX-DR4 (dual theme), UX-DR23 (animations)
- [Source: _bmad-output/project-context.md#Frontend rules, #Testing rules, #Code quality & naming]
- [Source: _bmad-output/planning-artifacts/architecture/architecture-share2brain-2026-06-30/TECHNICAL-DESIGN.md §5.5] — packages/web SPA
- [Source: eslint.config.js:32-47] — web browser-safe import guard
- [Source: _bmad-output/implementation-artifacts/epic-2-ac-verification-2026-07-04.md] — Epic 2 AC consistency + bundle prerequisite

## Review Findings

### patch
- [x] [Review][Patch] Renombrar variables CSS a nomenclatura semántica [global.css] — `--tx`→`--text-primary`, `--tx2`→`--text-secondary`, `--tx3`→`--text-tertiary`, `--tx4`→`--text-muted`, `--tx5`→`--text-subtle`. Resuelve también el gap `--tx1`.
- [x] [Review][Patch] Separar `:root` como bloque de tema oscuro por defecto [global.css] — elimina el selector compuesto `:root, [data-kh="dark"]`; ahora `:root` contiene los valores dark (fallback) y `[data-kh="light"]` los sobreescribe.
- [x] [Review][Patch] Conflicto `showDot` + `children` [Hexagon.tsx] — el dot no se renderiza cuando hay `children` presentes (preferencia a `children`).
- [x] [Review][Patch] Validación de `size` inválido [Hexagon.tsx] — clamp a `Math.max(1, Math.round(size))` con warning en dev. El valor clampado se usa para todas las dimensiones.
- [x] [Review][Patch] Runtime guard para `innerBg` [Hexagon.tsx] — warning en dev si el valor no es `'bg'` | `'bg-deep'`.
- [x] [Review][Patch] Cobertura de tests ampliada [Hexagon.test.tsx] — tests para `children`, `innerBg="bg-deep"`, `className`/`style`, `size=0`, fallback `size=100`.
- [x] [Review][Patch] Fallback visual si falta `#root` [main.tsx] — añade texto al body además del console.error.

### defer
- [x] [Review][Defer] Respetar `prefers-color-scheme` [main.tsx:12] — el tema oscuro se fuerza sin consultar la preferencia del SO. La lógica de detección y toggle persistente con `localStorage` vive en Story 2.2, donde tiene sentido añadirlo.
- [x] [Review][Defer] `@media (prefers-reduced-motion: reduce)` — las 6 animaciones no tienen variante reduced-motion. Es una preocupación válida de accesibilidad pero aplica a todo el sistema de diseño, no solo a esta story.

## Dev Agent Record

### Agent Model Used

claude-opus-4-8[1m] (bmad-dev-story)

### Debug Log References

- `npm run typecheck -w @share2brain/web` initially failed after the new relative + CSS imports: `tsc` inherits `NodeNext` module resolution from `tsconfig.base.json`, which requires `.js` extensions on relative imports and has no ambient type for `import './styles/global.css'`. (`vite build` uses esbuild and did not catch this.) Fixed by overriding the web `tsconfig.json` to `module: ESNext` + `moduleResolution: Bundler` (Vite's recommended setting) and `types: ["vite/client"]`.

### Completion Notes List

Implemented the design-system foundation only (tokens, fonts, keyframes, Hexagon primitive) — no login/sidebar/header/router/theme-toggle (those are Story 2.2).

- **AC1/AC5 (tokens + theme resolution):** `global.css` carries both token blocks verbatim (`:root, [data-kh="dark"]` and `[data-kh="light"]`). Verified in the compiled `dist` CSS: dark `--accent-ink:#f5a623` / `--on-accent:#0e1116`; light `--accent-ink:#9a5b00` / `--on-accent:#0e1116`; both `[data-kh=dark]`/`[data-kh=light]` selectors present (hex lowercased by Vite's minifier). Root defaults to `data-kh="dark"` via `main.tsx`.
- **AC2 (fonts):** three `<link>`s (2 preconnect + 1 stylesheet) with Space Grotesk 500/600/700, IBM Plex Sans 400/500/600, IBM Plex Mono 400/500/600, `display=swap`; `body` font-family is `'IBM Plex Sans', system-ui, sans-serif`. Confirmed in built `index.html`.
- **AC3 (Hexagon):** `Hexagon.tsx` renders three nested clip-path layers (amber gradient → `--bg`/`--bg-deep` → amber dot). `size` drives dimensions with exact prototype values for 74/32/30 and a proportional fallback (middle ≈0.55×, dot ≈0.19×) for others. Props: `size`, `innerBg`, `showDot`, `children`, `className`, `style`. Dependency-free (no `@share2brain/shared` import — respects the web browser-safe import guard).
- **AC4 (keyframes):** all six `kh-*` keyframes present verbatim; confirmed in `dist` CSS.
- **Testing:** added a `web` Vitest project (jsdom + `@vitejs/plugin-react`) in `packages/web/vitest.config.ts`, registered in the root `test.projects`, and wired into `npm run test` (`--project unit --project web`). `Hexagon.test.tsx` asserts the 3-layer structure + clip-path polygon, and that `showDot={false}` drops the dot (2 layers).
- **Honest verification limits:** jsdom does not apply external stylesheets or resolve CSS custom properties via `getComputedStyle`, so token/font/keyframe ACs are NOT asserted in unit tests. They were verified against the compiled `dist` artifacts (strong automated proxy). A final live `npm run dev` browser check (flip `data-kh` on `<html>`, watch fonts load in the Network tab, eyeball the Hexagon in both themes) is left for the reviewer.
- **Bonus:** dropping the Story 1.3 `HealthResponseSchema` scaffold stub removed zod from the web bundle — JS dropped ~252 KB → 191 KB (gzip 60 KB).

Verification gate output (all green):

```
> npm run lint      → eslint . (clean, no output)
> npm run test      → Test Files 7 passed (7) | Tests 31 passed (31)
                       (web project alone: 1 file, 2 tests passed)
> npm run typecheck → tsc --noEmit clean across backend, bot, shared, web, workers
> npm run build     → all 5 packages build; web: dist/index.html 1.06 kB,
                       CSS 1.62 kB, JS 191.16 kB (gzip 60.38 kB)
```

### File List

New:
- `packages/web/src/styles/global.css`
- `packages/web/src/components/Hexagon.tsx`
- `packages/web/src/components/Hexagon.test.tsx`
- `packages/web/vitest.config.ts`

Modified:
- `packages/web/index.html` (Google Font `<link>`s)
- `packages/web/src/main.tsx` (import global.css, set default `data-kh="dark"`, render Hexagon smoke check, drop 1.3 stub)
- `packages/web/tsconfig.json` (Bundler module resolution + `vite/client` types)
- `packages/web/package.json` (jsdom, @testing-library/react, @testing-library/dom devDeps)
- `vitest.config.ts` (register the `web` project)
- `package.json` (`test` script runs `--project unit --project web`)

## Change Log

| Date | Version | Description |
|---|---|---|
| 2026-07-04 | 0.1 | Implemented design-system foundation: tokens (dark/light), 3 Google Font families, six kh-* keyframes, reusable Hexagon component; added web Vitest (jsdom) project. Status → review. |
