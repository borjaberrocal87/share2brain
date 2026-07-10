---
baseline_commit: 3f5201be2ff8778651cfd18c69b8b249eb912fc1
---

# Story 2.2: Main layout, sidebar and login screen

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a community member,
I want to see the Share2Brain login screen and, once authenticated, the main interface with a sidebar and header,
so that I can navigate between the sections of the application.

## Acceptance Criteria

1. **Login screen (unauthenticated).** When the user is not authenticated and opens the web app, they see a full-screen login: amber + Discord-purple radial-gradient background with **4 decorative hexagons** animated via `kh-float`; a centered **card** (`max-width:430px` / `92vw`, `padding:48px 44px 36px`, `border-radius:20px`, `background:var(--card)`, `border:1px solid var(--border-strong)`, deep box-shadow); a **74px hexagon logo** (reuse `<Hexagon size={74} />`); title "Share2Brain" (Space Grotesk 700, 30px); a mono uppercase subtitle; a descriptive paragraph; a **"Continuar con Discord"** button (`#5865F2`, `height:52px`, `border-radius:12px`) with a **loading state** (spinner `kh-spin` + "Conectando con Discord…"); a security note with a lock icon; and a footer row with the OAuth2 scopes + version. Exact markup/values in Dev Notes → Login spec.

2. **Authenticated app shell.** When authenticated, the user sees the app layout: an outer flex container (`display:flex; height:100vh; width:100vw; overflow:hidden`) with a **sidebar** (`width:236px`, `background:var(--bg-deep)`, `border-right:1px solid var(--line)`) and a **content column** (`flex:1; min-width:0`).

3. **Sidebar contents.** The sidebar shows: a **32px hexagon logo** (`<Hexagon size={32} innerBg="bg-deep" />`) + wordmark "Share2Brain" (Space Grotesk 700, 17px); **2 nav items** — Búsqueda (magnifier icon) and Documentos (grid icon); a flexible spacer; a **system-status panel** (border, `border-radius:12px`, `background:var(--surface)`) with a green dot + `share2brain.config.yml` and three rows — `indexer / running`, `redis stream / ok`, `pgvector / ok` (green values); and a footer `self-hosted · open source` (mono 10px, `--text-subtle`).

4. **Header (62px).** The header shows, left→right: [Discord icon `#5865F2` (17px) + community name (font-weight 600, 15px) | 1px vertical separator | statsLine (mono 11.5px, `--text-muted`)] and, on the right: [an "indexando en vivo" badge with an amber dot animated via `kh-pulse` | a circular 30px user avatar (`#5865F2`) + name | a theme-toggle button (30px) | a logout button (30px, hover color `#ED4245`)]. Bottom border `--line`.

5. **Active vs inactive nav item.** The active nav item has `background:rgba(245,166,35,0.12)` and `color:var(--accent-ink)`; the inactive item has `background:transparent` and `color:var(--text-tertiary)`. Clicking a nav item switches which content pane is shown.

6. **Persistent theme toggle.** Clicking the header theme-toggle button flips the root element's `data-kh` between `"dark"` and `"light"`, persists the choice to `localStorage('share2brain-theme')`, and swaps the toggle icon (sun when dark is active / moon when light is active). **On reload, the saved theme is applied before the first visible paint** (no flash of the wrong theme).

7. **Auth transitions (client-side, mock).** Clicking "Continuar con Discord" shows the loading state, then reveals the authenticated shell. Clicking the header logout button returns to the login screen (and resets the active pane to Búsqueda). In this story the auth state is **local/client-side only** — there is no backend call yet; Story 2.3/2.4 replace the mock with the real Discord OAuth2 flow and `GET /api/auth/me`. See Dev Notes → Scope boundary.

## Tasks / Subtasks

- [x] **Task 1 — FOUC-free theme init + `useTheme` hook (AC: 6)**
  - [x] Add a tiny **blocking inline script** to `packages/web/index.html` `<head>` (before the stylesheet `<link>`s) that reads `localStorage('share2brain-theme')` and sets `document.documentElement.setAttribute('data-kh', saved === 'light' ? 'light' : 'dark')` synchronously — this guarantees the saved theme is applied before the first paint (AC6). See Dev Notes → Theme init.
  - [x] Create `packages/web/src/hooks/useTheme.ts`: a hook returning `{ theme, toggleTheme }`. It initializes `theme` from the current `document.documentElement.dataset.kh` (already set by the inline script), and `toggleTheme` flips dark↔light, writes `data-kh` on `document.documentElement`, and persists to `localStorage('share2brain-theme')` (wrap `localStorage` access in `try/catch` — private-mode Safari throws). Copy the exact toggle logic from Dev Notes.
  - [x] Remove the unconditional `document.documentElement.setAttribute('data-kh', 'dark')` currently in `main.tsx` (Story 2.1) — the inline script now owns default + restore.

- [x] **Task 2 — Shared inline-SVG icon set (AC: 1, 3, 4)**
  - [x] Create `packages/web/src/components/icons.tsx` exporting small presentational SVG components: `DiscordIcon`, `SearchIcon`, `DocsIcon`, `SunIcon`, `MoonIcon`, `LockIcon`, `LogoutIcon`. Use the exact SVG paths from Dev Notes → Icons (extracted from the prototype). Each accepts `size?: number` and inherits `currentColor`. Dependency-free — do NOT add an icon library.

- [x] **Task 3 — LoginScreen component (AC: 1, 7)**
  - [x] Create `packages/web/src/components/LoginScreen.tsx`. Props: `loggingIn: boolean`, `onLogin: () => void`. Render the full-screen gradient background, the 4 `kh-float` decorative hexagons (raw `clip-path` divs — NOT the `Hexagon` component; they are flat-tint shapes, not the nested brand mark), the card, `<Hexagon size={74} />`, title/subtitle/paragraph, the Discord button (loading vs default state), the lock security note, and the scopes/version footer. Copy structure + values from Dev Notes → Login spec.
  - [x] The button label/spinner switches on `loggingIn`. Keep the Spanish UI copy verbatim (see Dev Notes → Language rule).

- [x] **Task 4 — Sidebar component (AC: 3, 5)**
  - [x] Create `packages/web/src/components/Sidebar.tsx`. Props: `activeScreen: 'search' | 'docs'`, `onNavigate: (screen) => void`, and (optional) `unreadCount?: number` for the Documentos badge (default 0 → no badge; real count arrives in Epic 4). Render logo+wordmark, the 2 nav items with active/inactive styling (AC5), spacer, system-status panel, and footer. Copy `navStyle` + panel markup from Dev Notes → Sidebar spec.

- [x] **Task 5 — Header component (AC: 4, 6, 7)**
  - [x] Create `packages/web/src/components/Header.tsx`. Props: `communityName: string`, `statsLine: string`, `user: { name: string; initials: string }`, `theme: 'dark' | 'light'`, `onToggleTheme: () => void`, `onLogout: () => void`. Render the left group (Discord icon + community name + separator + statsLine), and the right group (live badge, user avatar+name, theme toggle showing `SunIcon` when `theme==='dark'` else `MoonIcon`, logout). Copy values from Dev Notes → Header spec.

- [x] **Task 6 — AppLayout + content placeholders (AC: 2, 5)**
  - [x] Create `packages/web/src/components/AppLayout.tsx`: the authenticated shell (`flex; height:100vh`) composing `Sidebar` + a content column (`flex:1; min-width:0; display:flex; flex-direction:column`) with `Header` on top and a scrollable content area below (`flex:1; overflow-y:auto`).
  - [x] Render a **placeholder** for the active pane — a simple centered heading matching the prototype's Search/Documents titles (e.g. "Búsqueda de conocimiento" / "Documentos indexados") with a one-line description. The **real** Search/Documents views are Epic 4 — do NOT build the search bar, result cards, or document table here. Keep the placeholders minimal.

- [x] **Task 7 — App root: auth + screen state wiring (AC: 1, 2, 5, 6, 7)**
  - [x] Create `packages/web/src/App.tsx` holding client-side state: `authed: boolean` (default `false`), `loggingIn: boolean`, `screen: 'search' | 'docs'` (default `'search'`), plus `useTheme()`. Implement `login()` (set `loggingIn`, then after ~1100ms set `authed=true; loggingIn=false` — mirrors the prototype and lets the loading state be seen/tested) and `logout()` (`authed=false; screen='search'`). Render `LoginScreen` when `!authed`, else `AppLayout`.
  - [x] Provide placeholder constants for data not yet backed by an API: `communityName` (e.g. `'Aurora Labs'`), `statsLine` (e.g. `'12.847 mensajes · 4 canales · pgvector'`), `user` (`{ name: 'Vos', initials: 'VO' }`). Add a code comment that these are wired to real data in Story 2.4 / Epic 4.
  - [x] Update `packages/web/src/main.tsx`: replace the Story 2.1 smoke render (`<Hexagon size={74} />`) with `<App />`. Keep the `#root` null-guard and `import './styles/global.css'`.

- [x] **Task 8 — Component styling (hover/focus states) (AC: 1, 3, 4, 5)**
  - [x] Static styling that needs `:hover` / `:focus` / `:focus-within` (nav hover, Discord button hover, theme/logout button hover, login card) **cannot be expressed with React inline styles** — use CSS classes. Add the needed classes to a co-located stylesheet (either extend `global.css` or add component `.css` / `.module.css` imports; Vite supports CSS Modules out of the box). Drive dynamic/state values (e.g. active nav) with conditional class names or inline style. Reference tokens only — no new raw hex outside the documented brand colors. See Dev Notes → Styling approach.

- [x] **Task 9 — Tests (behavior-level, jsdom) (AC: 1, 5, 6, 7)**
  - [x] Add tests under `packages/web/src/**/*.test.tsx` (the `web` Vitest project already exists — jsdom + `@vitejs/plugin-react`). Cover: (a) `App` renders `LoginScreen` when unauthenticated; (b) clicking "Continuar con Discord" transitions to the shell (use Vitest fake timers for the ~1100ms mock — `vi.useFakeTimers()` + `vi.advanceTimersByTime`); (c) logout returns to the login screen; (d) clicking a nav item changes the active pane; (e) `useTheme.toggleTheme` flips `document.documentElement` `data-kh` and writes `localStorage('share2brain-theme')`. Behavior-driven names (`should <behavior> when <condition>`), AAA. See Dev Notes → Testing.
  - [x] Do NOT assert CSS color/token values — jsdom does not apply `global.css` or resolve custom properties (same limitation documented in Story 2.1). Visual/color ACs are a browser check.

- [x] **Task 10 — Verification (mandatory gate)**
  - [x] Run and paste output for: `npm run lint && npm run test && npm run build`. Also run `npm run typecheck`. Never commit red. — All green (see Completion Notes → Verification evidence).
  - [x] Browser check via `npm run dev` (`packages/web` on :5173): dev server boots clean (HTTP 200, module transforms OK); FOUC-free ordering confirmed in built `dist/index.html` (inline theme script precedes stylesheet links); behavior covered by jsdom tests (login→shell w/ spinner, logout→login, nav switch, theme flip+persist). **Visual color/token confirmation + reload-persistence with real localStorage is a manual browser step for the reviewer — the agent cannot inspect pixels.** See Completion Notes.

## Dev Notes

### Scope boundary — what this story IS and is NOT
This story is **UI + layout only**. It builds the login screen, the authenticated shell (sidebar + header + content column), the persistent theme toggle, and client-side navigation between two content **placeholders**.

It does **NOT**:
- Call any backend or implement real auth — there is no `/api` yet. Auth state is a local React boolean; the "Continuar con Discord" button runs a **mock** login (setTimeout), and logout just flips the boolean. **Story 2.3** implements Discord OAuth2 (`GET /api/auth/login` redirect, callback, Redis session) and **Story 2.4** replaces the mock with a real `GET /api/auth/me` check on mount + route protection + wiring the community name from config. Design the auth state so 2.4 can swap the mock for a real fetch without restructuring the components (keep `authed`/`login`/`logout` in `App`, pass display data as props). [Source: epics.md#Historia 2.3, #Historia 2.4]
- Build the Search or Documents views (search bar, result cards, document table, read-tracking) — those are **Epic 4** (Historia 4.3/4.4). Render only minimal titled placeholders. [Source: epics.md#Historia 4.3, #Historia 4.4]
- Build the Chat widget/FAB — that is **Epic 5**. Chat is a floating widget, not a nav item. [Source: epics.md#Historia 5.3; UX-DR5, UX-DR15]

### 🚨 CRITICAL — CSS variable names were renamed in Story 2.1 review
The design prototype and the epic ACs use short token names (`--tx`, `--tx2`…`--tx5`). **These do NOT exist in the code.** Story 2.1's code review renamed the text tokens to semantic names. When copying values from the prototype, **translate every text token** using this table. Using a prototype name (`--tx3`) will silently render `initial`/black text — a real visual bug.

| Prototype / epic name | **Actual CSS variable (use this)** | Dark value | Light value |
|---|---|---|---|
| `--tx` / `--tx1` | `--text-primary` | `#E6E9EF` | `#1B1F27` |
| `--tx2` | `--text-secondary` | `#C7CDD8` | `#39414D` |
| `--tx3` | `--text-tertiary` | `#9AA3B2` | `#5C6573` |
| `--tx4` | `--text-muted` | `#7C8494` | `#79828F` |
| `--tx5` | `--text-subtle` | `#646C7C` | `#99A1AD` |

All **other** tokens keep their prototype names and already exist in `global.css`: `--bg`, `--bg-deep`, `--surface`, `--card`, `--hover-row`, `--track`, `--line`, `--border`, `--border-strong`, `--border-hover`, `--dot-read`, `--hover`, `--on-accent`, `--accent-ink`. **Fixed brand colors** (raw hex allowed): amber `#F5A623` / highlight `#FFCB6B`; Discord `#5865F2`; positive/active `#3BA55D`; danger `#ED4245`; white `#fff`. [Source: packages/web/src/styles/global.css:19-30; 2-1-...md#Review Findings]

### Language rule — code English, UI copy Spanish
`project-context.md` mandates **English-only for code, comments, identifiers, tests, and commits**. But the product's **user-facing UI text is Spanish** (this is a Spanish-language product; the prototype copy is authoritative). So: component/prop/variable names, comments and commit messages in English; visible strings ("Continuar con Discord", "Búsqueda", "Documentos", "indexando en vivo", "self-hosted · open source", etc.) stay **Spanish, verbatim from the prototype**. Do not translate the UI. [Source: project-context.md#Code quality & naming; docs/context/design/Share2Brain Web.dc.html]

### Reuse the existing Hexagon — do not reinvent
`packages/web/src/components/Hexagon.tsx` (Story 2.1) already renders the nested brand hexagon. Use it:
- **Login logo:** `<Hexagon size={74} />` (default `innerBg="bg"`, dot shown). The prototype adds `box-shadow:0 12px 30px -8px rgba(245,166,35,0.6)` on the outer shape — pass it via the `style` prop.
- **Sidebar logo:** `<Hexagon size={32} innerBg="bg-deep" />` (dot shown; middle fill is the deeper bg to match the sidebar background).

The **4 decorative login hexagons** are NOT brand marks — they are single flat-tint `clip-path` divs with `kh-float`. Do NOT use the `Hexagon` component for them; render raw divs (values below). [Source: packages/web/src/components/Hexagon.tsx; Share2Brain Web.dc.html:46-49,53-55,92-94]

### Theme init (FOUC-free) — `index.html` inline script
Add this **before** the font `<link>`s in `<head>` so it runs synchronously before any paint. With the empty `#root` body, this guarantees AC6's "saved theme applied before first visible paint":
```html
<script>
  try {
    var t = localStorage.getItem('share2brain-theme');
    document.documentElement.setAttribute('data-kh', t === 'light' ? 'light' : 'dark');
  } catch (e) {
    document.documentElement.setAttribute('data-kh', 'dark');
  }
</script>
```
`useTheme` toggle logic (English identifiers; mirrors prototype `toggleTheme`, lines 526-532):
```ts
const toggleTheme = () => {
  const next = theme === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-kh', next);
  try { localStorage.setItem('share2brain-theme', next); } catch { /* private mode */ }
  setTheme(next);
};
```
[Source: Share2Brain Web.dc.html:526-532; UX-DR4]

### Login spec — copy structure + values (translate tokens per the table above)
Full-screen container: `position:fixed; inset:0; display:flex; align-items:center; justify-content:center; overflow:hidden; color:var(--text-primary);` background =
`radial-gradient(1200px 700px at 50% -10%, rgba(245,166,35,0.10), transparent 60%), radial-gradient(900px 600px at 85% 110%, rgba(88,101,242,0.10), transparent 55%), var(--bg-deep)`.

4 decorative hexagons (`position:absolute`, `clip-path:polygon(25% 0%,75% 0%,100% 50%,75% 100%,25% 100%,0% 50%)`, `animation:kh-float …`):
| w/h | left | top | background | animation |
|---|---|---|---|---|
| 180px | 8% | 18% | `rgba(245,166,35,0.05)` | `kh-float 9s ease-in-out infinite` |
| 120px | 80% | 24% | `rgba(88,101,242,0.06)` | `kh-float 11s ease-in-out infinite 1.5s` |
| 90px | 18% | 70% | `rgba(245,166,35,0.05)` | `kh-float 10s ease-in-out infinite 0.7s` |
| 140px | 72% | 66% | `rgba(245,166,35,0.04)` | `kh-float 13s ease-in-out infinite 2.2s` |

Card: `position:relative; width:430px; max-width:92vw; padding:48px 44px 36px; background:var(--card); border:1px solid var(--border-strong); border-radius:20px; box-shadow:0 40px 90px -30px rgba(0,0,0,0.8), inset 0 1px 0 rgba(255,255,255,0.03)`.
Inside (centered column): `<Hexagon size={74} style={{ boxShadow:'0 12px 30px -8px rgba(245,166,35,0.6)' }} />` → `<h1>` "Share2Brain" (`font-family:'Space Grotesk',sans-serif; font-size:30px; font-weight:700; letter-spacing:-0.02em; margin:22px 0 0`) → subtitle (`margin-top:6px; font-family:'IBM Plex Mono',monospace; font-size:11.5px; letter-spacing:0.08em; color:var(--text-tertiary); text-transform:uppercase`) "Agente de conocimiento · self-hosted" → paragraph (`margin:20px 2px 0; font-size:14.5px; line-height:1.55; color:var(--text-secondary)`) "El conocimiento de tu comunidad de Discord, indexado y consultable. Iniciá sesión para buscar y chatear con el agente."

Discord button: `margin-top:28px; width:100%; height:52px; display:flex; align-items:center; justify-content:center; gap:11px; border:none; border-radius:12px; cursor:pointer; font-size:15px; font-weight:600; color:#fff; background:#5865F2; box-shadow:0 10px 24px -10px rgba(88,101,242,0.8)`. Hover (needs a CSS class): `background:#4853e0; transform:translateY(-1px)`.
- `loggingIn` true → spinner (`width:18px; height:18px; border:2px solid rgba(255,255,255,0.4); border-top-color:#fff; border-radius:50%; animation:kh-spin 0.7s linear infinite`) + "Conectando con Discord…".
- else → `<DiscordIcon size={22} />` + "Continuar con Discord".

Security note: `margin-top:16px; display:flex; align-items:center; gap:8px; justify-content:center; color:var(--text-muted); font-size:12.5px` → `<LockIcon size={13} />` + "Solo miembros del guild pueden acceder".
Footer: `margin-top:26px; padding-top:18px; border-top:1px solid var(--border); display:flex; justify-content:space-between; font-family:'IBM Plex Mono',monospace; font-size:10.5px; color:var(--text-subtle); letter-spacing:0.04em` → `<span>scope: identify · guilds.members.read</span><span>v4.0</span>`.
[Source: Share2Brain Web.dc.html:44-84; UX-DR9]

### Sidebar spec
`aside`: `width:236px; flex-shrink:0; display:flex; flex-direction:column; background:var(--bg-deep); border-right:1px solid var(--line); padding:18px 14px`.
Logo row: `display:flex; align-items:center; gap:11px; padding:6px 8px 18px` → `<Hexagon size={32} innerBg="bg-deep" />` + `<div>` "Share2Brain" (`font-family:'Space Grotesk',sans-serif; font-weight:700; font-size:17px; letter-spacing:-0.01em`).
Nav: `display:flex; flex-direction:column; gap:3px; margin-top:6px`. Each item is a `<button>` with base style `display:flex; align-items:center; gap:12px; width:100%; padding:10px 12px; border:none; border-radius:10px; cursor:pointer; font-size:14px; font-weight:500; text-align:left; transition:background .12s ease` **plus**:
- active: `background:rgba(245,166,35,0.12); color:var(--accent-ink)`
- inactive: `background:transparent; color:var(--text-tertiary)`; hover (CSS class): `background:var(--hover)`
Item = icon span (`display:flex; width:18px; justify-content:center`) + label. Documentos gets an amber count badge only when `unreadCount > 0`: `margin-left:auto; min-width:18px; height:18px; padding:0 5px; display:flex; align-items:center; justify-content:center; font-family:'IBM Plex Mono',monospace; font-size:10.5px; font-weight:600; color:var(--on-accent); background:#F5A623; border-radius:9px`.
Spacer: `<div style={{ flex:1 }} />`.
Status panel: `padding:13px; border:1px solid var(--border); border-radius:12px; background:var(--surface)`. Top row: `display:flex; align-items:center; gap:8px` → dot (`width:8px; height:8px; border-radius:50%; background:#3BA55D; box-shadow:0 0 0 3px rgba(59,165,93,0.18)`) + "share2brain.config.yml" (`font-family:'IBM Plex Mono',monospace; font-size:11px; color:var(--text-tertiary)`). Rows wrapper: `margin-top:9px; display:flex; flex-direction:column; gap:5px; font-size:11.5px; color:var(--text-muted)`; each row `display:flex; justify-content:space-between` with label + value where value has `color:#3BA55D`: `indexer→running`, `redis stream→ok`, `pgvector→ok`.
Footer: `margin-top:12px; text-align:center; font-family:'IBM Plex Mono',monospace; font-size:10px; color:var(--text-subtle); letter-spacing:0.05em` → "self-hosted · open source".
[Source: Share2Brain Web.dc.html:90-126; UX-DR6, UX-DR7]

### Header spec
`header`: `height:62px; flex-shrink:0; display:flex; align-items:center; justify-content:space-between; padding:0 26px; border-bottom:1px solid var(--line); background:var(--bg)`.
Left group (`display:flex; align-items:center; gap:14px; min-width:0`): [`<DiscordIcon size={17} />` (fill `#5865F2`) + community name (`font-weight:600; font-size:15px`)] wrapped in `display:flex; align-items:center; gap:9px`; then separator `width:1px; height:18px; background:var(--border-strong)`; then statsLine (`font-family:'IBM Plex Mono',monospace; font-size:11.5px; color:var(--text-muted)`).
Right group (`display:flex; align-items:center; gap:12px`):
- Live badge: `display:flex; align-items:center; gap:7px; padding:5px 11px; border:1px solid var(--border); border-radius:999px; background:var(--surface)` → amber dot `width:7px; height:7px; border-radius:50%; background:#F5A623; animation:kh-pulse 1.6s ease-in-out infinite` + "indexando en vivo" (`font-size:11.5px; color:var(--text-tertiary)`).
- User cluster (`display:flex; align-items:center; gap:9px`): avatar `width:30px; height:30px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:12px; font-weight:600; color:#fff; background:#5865F2` (initials) + name (`font-size:13.5px; color:var(--text-secondary)`) + theme button + logout button.
- Icon buttons (theme + logout) share: `display:flex; align-items:center; justify-content:center; width:30px; height:30px; border:1px solid var(--border); border-radius:8px; background:transparent; color:var(--text-tertiary); cursor:pointer`. Theme hover (CSS): `color:var(--accent-ink); border-color:var(--border-hover)`; icon = `<SunIcon />` when `theme==='dark'` else `<MoonIcon />`; `title` = e.g. "Cambiar a tema claro/oscuro". Logout hover (CSS): `color:#ED4245; border-color:#ED4245`; icon = `<LogoutIcon size={15} />`; `title="Cerrar sesión"`; `onClick={onLogout}`.
[Source: Share2Brain Web.dc.html:129-152; UX-DR8]

### Icons — SVG paths (from prototype)
All stroke icons: `viewBox="0 0 24 24"`, unless noted `fill:none; stroke:currentColor; stroke-width:2` (or `1.8` for nav), `stroke-linecap:round`.
- **Discord** (fill `currentColor`): path `d="M19.27 5.33C17.94 4.71 16.5 4.26 15 4a.09.09 0 0 0-.07.03c-.18.33-.39.76-.53 1.09a16.09 16.09 0 0 0-4.8 0c-.14-.34-.35-.76-.54-1.09-.01-.02-.04-.03-.07-.03-1.5.26-2.93.71-4.27 1.33-.01 0-.02.01-.03.02-2.72 4.07-3.47 8.03-3.1 11.95 0 .02.01.04.03.05 1.8 1.32 3.53 2.12 5.24 2.65.03.01.06 0 .07-.02.4-.55.76-1.13 1.07-1.74.02-.04 0-.08-.04-.09-.57-.22-1.11-.48-1.64-.78-.04-.02-.04-.08-.01-.11.11-.08.22-.17.33-.25.02-.02.05-.02.07-.01 3.44 1.57 7.15 1.57 10.55 0 .02-.01.05-.01.07.01.11.09.22.17.33.26.04.03.04.09-.01.11-.52.31-1.07.56-1.64.78-.04.01-.05.06-.04.09.32.61.68 1.19 1.07 1.74.03.02.06.03.09.02 1.72-.53 3.45-1.33 5.25-2.65.02-.01.03-.03.03-.05.44-4.53-.73-8.46-3.1-11.95-.01-.01-.02-.02-.04-.02zM8.52 14.91c-1.03 0-1.89-.95-1.89-2.12 0-1.17.84-2.12 1.89-2.12 1.06 0 1.9.96 1.89 2.12 0 1.17-.84 2.12-1.89 2.12zm6.97 0c-1.03 0-1.89-.95-1.89-2.12 0-1.17.84-2.12 1.89-2.12 1.06 0 1.9.96 1.89 2.12 0 1.17-.83 2.12-1.89 2.12z"`
- **Search** (nav, stroke 1.8): `<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>`
- **Docs** (nav, stroke 1.8): `<path d="M4 4h16v5H4z"/><path d="M4 13h16M4 18h10"/>`
- **Lock** (stroke 2): `<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>`
- **Logout** (stroke 2): `<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>`
- **Sun** (theme, dark active) — standard sun: `<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>`
- **Moon** (theme, light active): `<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>`
[Source: Share2Brain Web.dc.html:69,132,147-148,164,656-661]

### Styling approach — inline styles vs CSS classes
Story 2.1 used React inline styles (`CSSProperties`) for the Hexagon. Continue that for **static, stateless** layout. BUT React inline styles **cannot express `:hover`, `:focus`, `:focus-within`** — and the prototype relies on hover states (nav, buttons, card, logout `#ED4245`). Put those in **CSS classes** (extend `global.css`, or add co-located `.css` / `.module.css` — Vite supports CSS Modules natively). Drive active/inactive nav with a conditional class or inline style. Do NOT add a CSS-in-JS library (styled-components/emotion) — it isn't in the stack and would be speculative. Reference design tokens; the only raw hex permitted are the documented brand colors. [Source: 2-1-...md#Dev Notes; project-context.md#Frontend rules]

### Architecture compliance (non-negotiable)
- **AD-3 — static SPA only.** No Node server, no SSR. Everything is browser-side; Vite → `dist/`, nginx serves it. [Source: project-context.md#Frontend rules; TECHNICAL-DESIGN.md §5.5]
- **Web import guard.** `packages/web/**` may import only browser-safe `@share2brain/shared/schemas` / `@share2brain/shared/types/events`; the root barrel `@share2brain/shared` and `/db` / `/config` are banned by `no-restricted-imports` in the root `eslint.config.js` (they pull `pg` + Node built-ins). **This story needs no shared import** (no API types until 2.4) — keep it zero. [Source: eslint.config.js; epic-2-ac-verification-2026-07-04.md]
- **No router dependency.** No AC requires URL-based routing; the prototype and UX-DR5 use in-app state to switch panes (2 nav items; chat is a floating widget, not a route). Use `screen` state, not `react-router`. If deep-linking is needed later it's a separate, deliberate addition. [Source: UX-DR5; Share2Brain Web.dc.html:807-809]
- **English identifiers / Spanish UI copy** (see Language rule above).

### Naming & file locations
- New: `packages/web/src/App.tsx`; `packages/web/src/hooks/useTheme.ts`; `packages/web/src/components/{LoginScreen,Sidebar,Header,AppLayout,icons}.tsx` (`PascalCase.tsx` for components; `icons.tsx` exports multiple components — fine). Any CSS you add: `packages/web/src/styles/*.css` or co-located `*.module.css`.
- Modify: `packages/web/index.html` (theme inline script in `<head>`); `packages/web/src/main.tsx` (render `<App />`, drop the smoke Hexagon + the unconditional `data-kh` set).
- Tests: `packages/web/src/**/*.test.tsx` (the `web` Vitest project + `npm run test` wiring already exist from Story 2.1 — no config change needed). [Source: project-context.md#Code quality & naming; packages/web/vitest.config.ts; vitest.config.ts]

### Testing standards
- Vitest + jsdom + `@testing-library/react` (already set up). Behavior-driven names, AAA. Use `@testing-library/user-event` or `fireEvent` for clicks; `vi.useFakeTimers()` for the mock login's `setTimeout`; `afterEach(cleanup)`.
- jsdom does NOT apply `global.css` or resolve CSS custom properties via `getComputedStyle` — assert **behavior and DOM structure/text**, not computed colors. The `data-kh` attribute IS assertable (it's a plain attribute set via JS), so the theme-toggle test is meaningful. Color/spacing ACs are the browser check (Task 10). [Source: 2-1-...md#Testing standards; packages/web/vitest.config.ts]

### Previous-story intelligence (Story 2.1 — done)
- `global.css` exists with both token blocks (`:root` = dark default, `[data-kh="light"]` overrides) and all six `kh-*` keyframes. Text tokens are the semantic names in the table above.
- `main.tsx` currently: `import './styles/global.css'`, unconditionally sets `data-kh="dark"`, renders `<Hexagon size={74} />` with a `#root` null-guard fallback. Replace the render + drop the `data-kh` line (inline script owns it now); keep the CSS import + null-guard.
- `Hexagon.tsx` props: `size`, `innerBg?: 'bg'|'bg-deep'`, `showDot?`, `children?`, `className?`, `style?`. Exact sizes 74/32/30 are special-cased. When `children` is passed the dot is suppressed. Use `style` to add the login box-shadow.
- `tsconfig.json` (web) uses `moduleResolution:"Bundler"` — relative imports need **no** `.js` extension; CSS side-effect imports are typed via `vite/client`. Don't reintroduce `.js` extensions.
- Deferred from 2.1 review, now in scope here: **`prefers-color-scheme`** — 2.1 deferred honoring the OS preference to this story. Optional enhancement: when `localStorage('share2brain-theme')` is absent, the inline script MAY default to `window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'` instead of hardcoding dark. AC6 only requires persistence + dark default when nothing is stored; honoring OS preference is a nice-to-have — implement if cheap, else leave dark default. [Source: deferred-work.md#2-1 review; 2-1-...md#defer]
- Also deferred (system-wide, NOT required here): `@media (prefers-reduced-motion: reduce)` for the `kh-*` animations. Out of scope for 2.2.

### Project Structure Notes
- No conflicts. `packages/web` already has React 19.2, Vite 8.1, the `web` Vitest project, and `@testing-library/react`. No new dependencies are needed (icons are inline SVG; no router; no CSS-in-JS).
- The `web` project is already registered in root `vitest.config.ts` `test.projects` and run by `npm run test` — new `*.test.tsx` files are picked up automatically.

### References
- [Source: _bmad-output/planning-artifacts/epics.md#Historia 2.2] — story + acceptance criteria
- [Source: _bmad-output/planning-artifacts/epics.md#Requisitos de Diseño UX] — UX-DR4 (dual theme + persistent toggle), UX-DR5 (layout, 2 nav, chat floating), UX-DR6 (sidebar), UX-DR7 (status panel), UX-DR8 (header), UX-DR9 (login)
- [Source: docs/context/design/Share2Brain Web.dc.html] — authoritative prototype (login L44-84, app shell L87-88, sidebar L90-126, header L129-152, auth/theme logic L521-532, navStyle L637-642, icons L656-661)
- [Source: packages/web/src/styles/global.css:19-30] — actual token names (post-2.1-review rename)
- [Source: packages/web/src/components/Hexagon.tsx] — reusable brand hexagon (props + size handling)
- [Source: packages/web/src/main.tsx] — current entry to modify
- [Source: _bmad-output/implementation-artifacts/2-1-sistema-de-diseno-en-packages-web.md] — Story 2.1 (tokens/fonts/keyframes/Hexagon), Review Findings (var rename), deferred items
- [Source: _bmad-output/implementation-artifacts/deferred-work.md] — 2.1 deferred: prefers-color-scheme (in scope now), prefers-reduced-motion (out of scope)
- [Source: _bmad-output/project-context.md#Frontend rules, #Testing rules, #Code quality & naming] — AD-3, web import guard, English-code rule
- [Source: _bmad-output/planning-artifacts/architecture/architecture-share2brain-2026-06-30/TECHNICAL-DESIGN.md §5.5] — packages/web SPA (4 views; Search/Documents bodies are Epic 4)

## Dev Agent Record

### Agent Model Used

claude-opus-4-8[1m] (Opus 4.8, 1M context) — bmad-dev-story

### Debug Log References

- **jsdom test discovery split.** `useTheme` needs jsdom (`document`). Initially named `useTheme.test.ts`, but the root `unit` Vitest project globs `packages/*/src/**/*.test.ts` (node env) and picked it up → `document is not defined`. Repo convention (per root `vitest.config.ts` comment) is `.ts` = unit/node, `.tsx` = web/jsdom. Renamed to `useTheme.test.tsx` so only the `web` project (jsdom) runs it.
- **No Web Storage under Node 24 + jsdom 29.** Neither bare `localStorage` nor `window.localStorage` is defined in the test env — Node 24 ships an experimental global `localStorage` that is `undefined` without `--localstorage-file`, and jsdom 29 does not expose its own. The hook's `try/catch` around `localStorage` silently no-ops there. Fix scoped to the test: `vi.stubGlobal('localStorage', <in-memory Storage>)` in `useTheme.test.tsx` so the AC6 persistence assertion is real. No config/dependency change. Real browsers have working `localStorage` (Task 10 browser check).

### Completion Notes List

Implemented Story 2.2 — login screen, authenticated app shell (sidebar + header + content column), persistent FOUC-free theme toggle, and client-side navigation + mock auth. **UI + layout only** per the scope boundary: no backend, no router, no shared import (web bundle stays browser-only). UI copy Spanish verbatim; identifiers/comments English.

Key decisions:
- **FOUC-free theme (AC6):** blocking inline script in `index.html` stamps `<html data-kh>` before the stylesheet links (order preserved through the Vite build — verified in `dist/index.html`). `useTheme` reads that back and owns the runtime toggle + `localStorage` persistence. Bonus (Story 2.1 deferred item): when nothing is stored the inline script honors `prefers-color-scheme`, else dark.
- **Styling split:** static layout via React inline styles (as in Story 2.1); `:hover` states (Discord button, nav items, theme/logout buttons) in a co-located `styles/components.css`. Active nav wins over `:hover` via a paired `.kh-nav-item--active, .kh-nav-item--active:hover` selector. Only documented brand hex used raw.
- **CSS-var rename honored:** text tokens use the semantic Story-2.1 names (`--text-primary`…`--text-subtle`), not the prototype `--tx*` names.
- **Auth shaped for 2.4:** `authed`/`login`/`logout` live in `App`; display data passed as props — 2.4 can swap the `setTimeout` mock for a real `GET /api/auth/me` fetch without restructuring components. Login timer is cleared on logout to avoid a late setState.

**Verification evidence (all green):**
- `npm run lint` → clean (eslint ., no output).
- `npm run test` → **9 files / 44 tests passed** (adds 5 `App` behavior tests + 3 `useTheme` tests to Story 2.1's suite).
- `npm run typecheck` → clean across all 5 workspaces (`tsc --noEmit`).
- `npm run build` → web bundle built (index 205.03 kB / gzip 64.26 kB; CSS 2.21 kB); no server-only deps leaked.
- `npm run dev` (web :5173) → boots in ~170ms, HTTP 200, `main.tsx` module transforms OK, no runtime errors. `dist/index.html` confirms inline theme script precedes the font/CSS `<link>`s (FOUC-free ordering survives the build).

**Manual browser check still recommended for the reviewer** (the agent cannot inspect pixels): confirm the login gradient + 4 floating hexagons, card values, spinner→shell transition, active-nav amber tint, and that setting light then reloading stays light with no dark flash (real-`localStorage` persistence). These are the pixel-level color/token ACs that jsdom cannot assert.

### File List

New:
- `packages/web/src/App.tsx`
- `packages/web/src/App.test.tsx`
- `packages/web/src/hooks/useTheme.ts`
- `packages/web/src/hooks/useTheme.test.tsx`
- `packages/web/src/components/icons.tsx`
- `packages/web/src/components/LoginScreen.tsx`
- `packages/web/src/components/Sidebar.tsx`
- `packages/web/src/components/Header.tsx`
- `packages/web/src/components/AppLayout.tsx`
- `packages/web/src/styles/components.css`

Modified:
- `packages/web/index.html` (FOUC-free inline theme script in `<head>`)
- `packages/web/src/main.tsx` (render `<App />`; dropped the smoke Hexagon + the unconditional `data-kh` set)

## Review Findings

### Review Findings detail

- [x] [Review][Patch] Timer leak on unmount — loginTimer not cleared in useEffect cleanup [App.tsx]
- [x] [Review][Patch] Tests hardcode magic number 1100 instead of importing MOCK_LOGIN_DELAY_MS [App.test.tsx]
- [x] [Review][Patch] No test for unmount-during-login timer cleanup [App.test.tsx]
- [x] [Review][Patch] Missing :focus-visible styles — keyboard users lack visible focus indicators [components.css]
- [x] [Review][Patch] Pulsing dot in "indexando en vivo" badge not aria-hidden [Header.tsx:86-93]
- [x] [Review][Defer] Side effects inside setState updater in useTheme — deferred, pre-existing [useTheme.ts:22-33]
- [x] [Review][Defer] login() has no internal guard against concurrent calls — deferred, pre-existing [App.tsx:35-42]

## Change Log

| Date | Version | Description |
|---|---|---|
| 2026-07-04 | 0.1 | Story drafted: login screen, app shell (sidebar + header + content column), persistent theme toggle, client-side nav + mock auth. Status → ready-for-dev. |
| 2026-07-04 | 0.2 | Implemented all 10 tasks: `useTheme` + FOUC-free inline theme init, icon set, `LoginScreen`/`Sidebar`/`Header`/`AppLayout`/`App`, hover CSS, 8 new tests. Verification gate green (lint/test/build/typecheck). Status → review. |
