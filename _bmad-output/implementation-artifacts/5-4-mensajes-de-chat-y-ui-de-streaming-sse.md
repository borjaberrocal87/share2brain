---
baseline_commit: 5f75fd1fddb93f4ef13721bd7863a77299aa45c8
---

# Story 5.4: Mensajes de Chat y UI de Streaming SSE

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **user of the chat**,
I want **to send messages and watch the agent's answer stream in with its cited sources**,
so that **I get real-time, source-backed answers from my community's knowledge without leaving my context**.

> **Scope boundary (read first).** This story turns the Story 5.3 chat **shell** into a working
> chat: the message **composer** (textarea + send button + privacy footer), **message-bubble**
> rendering (user + agent), **SSE streaming** of `token` frames with the blinking cursor, **citation
> chips**, wiring the empty-state **suggestions** to send, and **loading a conversation's messages**
> when a history row is selected. It is **frontend-only** (package `@hivly/web`) — like Story 5.3.
>
> **The "loop de ejecución" execution-trace panel (UX-DR20 — `tool_call`/`observation` steps) is
> explicitly OUT OF SCOPE and DEFERRED** (decision **D1**). The backend `POST /api/chat` contract
> (frozen since Story 5.1) emits **only** `token`/`citation`/`done`/`error` frames — there is **no
> `tool_exec` node and no `tool_call`/`observation` frame anywhere in the codebase** (only a
> future-extension comment at `agent/graph.ts:110`). The prototype's trace steps are **hardcoded
> `setTimeout` fakes**, not real stream data. Building it for real is a substantial *backend+shared*
> feature (LLM tool-use + configurable tools in `Hivly.config.yml` + a conditional `tool_exec` loop
> in the StateGraph + widening `SSEFrameSchema`) and belongs to its own future story. **Do NOT add
> the trace panel, do NOT widen `SSEFrameSchema`, do NOT touch the agent graph in this story.**

## Acceptance Criteria

Derived from epics.md §Historia 5.4, UX-DR15/19/21/22, and the pixel-exact prototype
`docs/context/design/KeepHive Web.dc.html` (lines 350–426, 578–629). The prototype is the source of
truth for exact px/color values; **its `--tx*` token names are stale** — use the real names (Dev
Notes §Token mapping, unchanged from 5.3). Amber text/borders use `var(--accent-ink)`; message
bubble text/cursor and the send button hardcode `#F5A623` exactly where the prototype does.

1. **Composer (UX-DR22)** — Below the message area the panel shows a composer:
   - an input row (`display:flex; align-items:flex-end; gap:9px; padding:7px 7px 7px 14px;
     background:var(--surface); border-radius:14px`) whose **base** `border: 1px solid
     var(--border-strong)` lives in a CSS class and turns `border-color: var(--accent-ink)` on
     `:focus-within`;
   - a `<textarea rows={1}>` (`resize:none; max-height:120px; border:none; outline:none;
     background:transparent; color:var(--text-primary); font-size:14px; line-height:1.5;
     padding:8px 0`) with placeholder **"Preguntá al agente…"** that auto-grows with content up to
     120px, then scrolls;
   - **Enter** (without Shift) sends; **Shift+Enter** inserts a newline;
   - a **footer** (`margin-top:8px`, centered, `font-size:10.5px; color:var(--text-subtle)`) with a
     lock icon + the text **"Respuestas con fuente verificable · tools de hivly.config.yml"**.

2. **Send button reflects draft + sending state (UX-DR22 + epic AC)** — The 40×40px send button
   (`border-radius:11px`) is **disabled** (`background: var(--line)`; icon `color: var(--text-subtle)`;
   `cursor: not-allowed`) when the trimmed draft is empty **or** a send is in flight; it is
   **enabled** (`background: #F5A623`; icon `color: var(--on-accent)`; `cursor: pointer`) when there
   is non-blank text and no send is in flight. It renders a 17px paper-plane icon.

3. **Sending streams the answer (UX-DR19)** — Submitting appends a **user bubble** then an **agent
   bubble**, then streams:
   - user bubble: 30px **Discord-purple** (`#5865F2`) circle avatar with the user's initials
     (`font-size:11px; 600; color:#fff`), a name label (`12.5px; 600; color:var(--text-tertiary);
     margin-bottom:8px`), and the message text (`15px; line-height:1.7; color:var(--text-primary);
     white-space:pre-wrap`);
   - agent bubble: 30px **amber hexagon** avatar (`linear-gradient(150deg,#FFCB6B,#F5A623)` +
     `clip-path` polygon, with a 15px `var(--bg)` inner hexagon), name label **"Hivly"**, and the
     answer text in the same 15px/1.7 style;
   - each `token` frame **appends** to the current agent bubble's text in real time;
   - while the agent bubble is streaming, an **amber blinking cursor** (`display:inline-block;
     width:8px; height:17px; margin-left:2px; background:#F5A623; animation:kh-blink 1s step-end
     infinite`) trails the text; it disappears when the `done` frame arrives.

4. **Citations (UX-DR21)** — After streaming, the `citation` frames (which arrive **after** all
   `token` frames — Dev Notes §Wire order) render under the agent bubble as a **"Fuentes"** section
   (`font-family:'IBM Plex Mono'; font-size:10px; letter-spacing:0.06em; text-transform:uppercase;
   color:var(--text-subtle)`) with a `flex-wrap` row of chips. Each chip is an `<a target="_blank"
   rel="noopener noreferrer">` (`padding:6px 11px 6px 6px; border-radius:9px; background:var(--surface)`)
   whose **base** `border: 1px solid var(--border)` lives in a CSS class and turns `border-color:
   #5865F2` on `:hover`; it contains a 20px author-initials avatar, the channel as `#{channel}`
   (mono, `color:var(--accent-ink)`), the author name (`11.5px; color:var(--text-tertiary)`), and a
   12px external-link icon.

5. **Suggestions send; FAB launcher dot (UX-DR15/18)** — Clicking an empty-state suggestion chip
   **sends that suggestion's text** as a message (same flow as AC3). While a send is in flight and
   the panel is **closed**, the FAB shows the pulsing green `launcherActive` dot (`kh-pulse`) — the
   in-flight stream is **not** aborted when the panel closes (Dev Notes §D6).

6. **Load a conversation's messages (closes Story 5.3's deferral)** — Selecting a history row (and
   selecting **"nueva conversación"** to reset) now affects the message area:
   - clicking a history row calls `GET /api/conversations/:conversationId`, renders its messages
     (user/assistant bubbles + citations, chronological), sets it active, and closes the overlay;
   - **"nueva conversación"** clears the messages and active id back to the empty state;
   - the **empty state** (5.3) is shown **iff** there are no messages; otherwise the message list
     renders (auto-scrolled to the newest message).

7. **Error + lifecycle are non-crashing** — A mid-stream `error` frame, or a pre-stream non-OK
   response (400/404/500 JSON), surfaces a short inline error in the agent bubble (e.g. a
   `var(--text-tertiary)` note) and stops the cursor — it never throws out of render or leaves a
   permanently-spinning cursor. Closing the panel mid-stream keeps the widget mounted and the
   message state intact; the stream is aborted only on component unmount.

8. **Execution-trace panel is DEFERRED (D1)** — The "loop de ejecución" panel (UX-DR20) is **not**
   built. `SSEFrameSchema`, `agent/graph.ts`, and any `@hivly/shared`/`@hivly/backend` file are
   **not** modified. A one-line deferred-work note records the follow-up backend story.

9. **E2E harness coverage (Epic 4 retro AI#6 — critical path)** — `packages/web/tests/chat.spec.ts`
   is extended (reusing the existing `loginAs`/`gotoChat` helpers and the already-seeded
   conversation) to verify via `getComputedStyle`/`toHaveCSS`, real DOM, and screenshots:
   - **composer**: send button disabled look when empty → enabled amber look after typing (AC2);
     footer text present (AC1);
   - **streaming**: type a message + send → the agent bubble accumulates to **"Hola desde Hivly."**
     (the harness `fakeChatModel`'s fixed tokens), ≥1 citation chip renders under it, and the
     blinking cursor is gone after `done` (AC3, AC4);
   - **history load**: click the seeded history row → a user bubble shows the seeded title and an
     agent bubble shows the seeded answer with a `#general` citation chip (AC6).
   The streaming test **mutates** (persists a new conversation), so it is ordered **last** in the
   file and 5.4 tests **avoid exact-conversation-count assertions** (Dev Notes §D9).

10. **Verification gate green** — `npm run lint && npm run test && npm run build` all clean, plus
    `npm run test:e2e -w @hivly/web` passing on chromium; output pasted in the Dev Agent Record. No
    secrets/behavior mixing; English-only code/identifiers; Spanish UI copy verbatim.

## Tasks / Subtasks

- [x] **Task 1 — SSE chat client `api/chat.ts`** (AC: 3, 4, 7)
  - [x] Create `packages/web/src/api/chat.ts` exporting an **async generator**
        `streamChat(body: ChatRequest, signal?: AbortSignal): AsyncGenerator<SSEFrame>` that
        `POST`s to `/api/chat` with `credentials:'include'`, JSON body, `signal`. Consume the
        response via `res.body.getReader()` + `TextDecoder`, buffer, split on `\n\n`, strip the
        `data: ` prefix, `JSON.parse`, then `SSEFrameSchema.parse(...)` each frame and `yield` it
        (Dev Notes §SSE client template). Handle a partial frame left in the buffer across chunk
        boundaries. **AD-4: use `fetch` streaming, NOT `EventSource`** (EventSource can't POST a body
        and is ESLint-banned by convention).
  - [x] On a **pre-stream non-OK** response (the endpoint returns `{ error, code }` JSON for
        400/404/500 before the stream starts), throw a typed error carrying the `code` — do NOT try
        to read it as a stream.
  - [x] Import types **only** from `@hivly/shared/schemas` (`SSEFrameSchema`, `ChatRequest`) — never
        the root barrel or `/db` (AD-3 ESLint ban).
  - [x] Create `packages/web/src/api/chat.test.ts`: mock `fetch` returning a `ReadableStream` of
        `data: <json>\n\n` chunks (incl. a frame split across two chunks); assert the yielded frame
        sequence, the `SSEFrameSchema.parse` rejection on a malformed frame, and the throw-on-!ok
        path.

- [x] **Task 2 — Conversation detail client** (AC: 6)
  - [x] In `packages/web/src/api/conversations.ts`, add
        `fetchConversation(id: string, signal?: AbortSignal): Promise<ConversationDetail>` modeled on
        the existing `fetchConversations` (`credentials:'include'`, `!res.ok` throw,
        `ConversationDetailSchema.parse(...)`). Import `ConversationDetailSchema`/`ConversationDetail`
        from `@hivly/shared/schemas` (already exists — Story 5.2; do **not** add a shared schema).
  - [x] Extend `packages/web/src/api/conversations.test.ts` with cases for `fetchConversation`
        (URL `/api/conversations/:id`, parse, throw-on-!ok).

- [x] **Task 3 — Two new icons** (AC: 1, 2, 3)
  - [x] In `packages/web/src/components/icons.tsx`, add `SendIcon` (paper plane, paths
        `M22 2L11 13` + `M22 2l-7 20-4-9-9-4 20-7z`) and `LockIcon` (`<rect x="5" y="11" width="14"
        height="9" rx="2"/>` + `<path d="M8 11V8a4 4 0 0 1 8 0v3"/>`), following the existing
        `IconProps`/`viewBox="0 0 24 24"`/`stroke="currentColor"` pattern.

- [x] **Task 4 — Pass user identity into `ChatWidget`** (AC: 3, D4)
  - [x] Add a `user: { name: string; initials: string }` prop to `ChatWidget` (the user-bubble
        avatar needs it — UX-DR19). In `App.tsx`, pass
        `user={{ name: user.username, initials: initialsFromUsername(user.username) }}` (both already
        available). This is the only `App.tsx` change; keep it to the prop.
  - [x] Update `App.test.tsx` for the new required prop.

- [x] **Task 5 — Message state + send flow in `ChatWidget`** (AC: 3, 4, 5, 6, 7)
  - [x] Add a `messages: ChatMessage[]` state (Dev Notes §Message state model) and a `sending`
        boolean. On send: append a `user` message, then a streaming `assistant` message; `for await`
        over `streamChat({ message, conversationId: activeConversationId }, signal)`, accumulating
        `token` → text, pushing `citation` → citations, capturing `done.conversationId` →
        `activeConversationId` (so a brand-new conversation's next turn appends correctly), and on
        `error` marking the assistant bubble errored. `finally` clears `sending`. Catch a thrown
        pre-stream error → errored assistant bubble.
  - [x] Keep an `AbortController` for the in-flight stream; abort **only on unmount** (cleanup), not
        on panel close (D6). Block a second send while `sending` (also drives AC2's disabled state).
  - [x] Wire the empty-state suggestion `onClick` to `send(text)`; wire `launcherActive = sending &&
        !chatOpen`.

- [x] **Task 6 — Render message bubbles** (AC: 3)
  - [x] Replace the "empty state only" message area with: empty state when `messages.length === 0`,
        else the message list (`display:flex; flex-direction:column; gap:22px; padding:22px 18px`).
        Gate the whole message-area content on `!chatHistoryOpen` (D10 — same focus-trap reason as
        5.3 round-3: overlay-covered interactive elements must not become Tab-trap boundaries).
  - [x] User bubble: `data-testid="chat-msg-user"`. Agent bubble: `data-testid="chat-msg-agent"`.
        Reuse the exact prototype avatar markup (Dev Notes §Bubbles). The agent avatar is a **single
        amber hexagon with an inner `var(--bg)` hexagon** (inline, like the FAB — reuse `CLIP_PATH`
        and `AMBER_GRADIENT` from `Hexagon.tsx`, do **not** re-inline the polygon).
  - [x] Blinking cursor `data-testid="chat-cursor"` shown only while that assistant bubble is
        streaming.
  - [x] Auto-scroll the message list to the bottom on new content (a ref + effect on
        `messages`/streaming text).

- [x] **Task 7 — Render citation chips** (AC: 4)
  - [x] Under an agent bubble with citations, render the "Fuentes" section + chips
        (`data-testid="chat-citation"`), each an `<a target="_blank" rel="noopener noreferrer">`.
        For the link href, use a stable, safe value — the citation shape is `{channel, author, date}`
        with **no message URL** (Dev Notes §Citation link). Author-avatar initials from the author
        string; avatar background may be a fixed neutral (no per-author color map is in scope).

- [x] **Task 8 — Composer** (AC: 1, 2)
  - [x] Add the composer as a `flex-shrink:0` element **after** the message-area div, inside the
        panel (`padding:12px 16px 16px; border-top:1px solid var(--line); background:var(--bg)`).
  - [x] Input row `data-testid="chat-input-row"` with the class-based `:focus-within` amber border
        (D7/cascade rule). Textarea `data-testid="chat-input"` with auto-resize (reset height then
        set to `scrollHeight` capped at 120px on input). Send button `data-testid="chat-send"` with
        the state-driven inline background (disabled/enabled per AC2 — inline is correct here because
        the state is React-driven, not a CSS pseudo-class).
  - [x] Footer with `LockIcon` + the verbatim Spanish string.
  - [x] `onKeyDown`: Enter (no Shift) → `preventDefault()` + send; Shift+Enter → default newline.
        Note: the panel's existing `onKeyDown` handles Escape/Tab-trap — make sure the textarea's
        Enter handling does not conflict (the textarea is inside the panel; Escape/Tab still bubble
        to the panel handler, which is fine).

- [x] **Task 9 — CSS classes for the new hover/focus states** (AC: 1, 4)
  - [x] In `packages/web/src/styles/components.css`, add `.kh-chat-input-row` (base
        `border:1px solid var(--border-strong)`) + `.kh-chat-input-row:focus-within { border-color:
        var(--accent-ink) }`; `.kh-chat-citation` (base `border:1px solid var(--border)`) +
        `:hover { border-color:#5865F2 }`; `.kh-chat-send:focus-visible` (the established amber ring).
  - [x] **Cascade rule (Epic 4 AI#4, unchanged from 5.3 Task 6):** any element whose
        border/background/color changes on `:hover`/`:focus-within` declares its **base** value in
        the CSS class, never inline — an inline shorthand outranks a stylesheet pseudo-class rule and
        the state silently dies.

- [x] **Task 10 — Unit tests (jsdom / Testing Library)** (AC: 1–7)
  - [x] Extend `packages/web/src/components/ChatWidget.test.tsx` (mock `./api/chat` and
        `./api/conversations`): typing enables/disables the send button; Enter sends and Shift+Enter
        does not; a mocked `streamChat` async generator drives token accumulation, a citation chip,
        and cursor removal on `done`; an `error` frame / a thrown pre-stream error shows the error
        state without crashing; clicking a suggestion sends it; selecting a history row calls
        `fetchConversation` and renders its messages; "nueva conversación" returns to the empty
        state; `launcherActive` dot logic (sending && closed).
  - [x] jsdom applies **no external CSS** — do NOT claim any visual/CSS AC "verified" from unit tests
        alone; those are the Playwright spec's job (Epic 4 lesson).

- [x] **Task 11 — Extend E2E spec `chat.spec.ts`** (AC: 9)
  - [x] Add a `Story 5.4` describe block after the existing `Story 5.3` block. Reuse `gotoChat`.
        Tests: composer button states + footer; streaming (type "…" + send → agent bubble text ==
        "Hola desde Hivly.", ≥1 `chat-citation`, `chat-cursor` count 0 after done); history load
        (click the seeded row → `chat-msg-user` contains the seeded title,
        `chat-msg-agent` contains the seeded answer, a `#general` citation chip). End each with a
        `fullPage` screenshot.
  - [x] **Ordering (D9):** the streaming test persists a new conversation. Place it **last** in the
        file; do **not** assert an exact conversation count anywhere in 5.4 (the 5.3 AC5
        `toHaveCount(1)` test must run before any mutation — it already sorts first within the file).
        Update `tests/README.md`: `chat.spec.ts` is **no longer read-only** — its final streaming
        test mutates; document that it still sorts before `docs.spec.ts`, whose own mutating test
        runs last, and that conversation mutations don't touch the documents/read-status tables
        `docs.spec.ts` asserts on.

- [x] **Task 12 — Deferred-work note (D1)** (AC: 8)
  - [x] Append one entry to `_bmad-output/implementation-artifacts/deferred-work.md`: the
        execution-trace panel (UX-DR20) + `tool_call`/`observation` frames + `tool_exec` node are a
        future *backend+shared* story (LLM tool-use, configurable tools, conditional graph loop,
        widen `SSEFrameSchema`).

- [x] **Task 13 — Verification gate** (AC: 10)
  - [x] Run and paste: `npm run lint && npm run test && npm run build`, then
        `npm run test:e2e -w @hivly/web` (chromium; `npx playwright install chromium` if needed).
        For the streaming path, also do a manual `curl -N` sanity check against a dev/e2e backend if
        convenient (optional — the E2E spec is the gate).

### Review Findings

- [x] [Review][Patch] In-flight stream not aborted/guarded on newChat or conversation switch — a stale `done` frame silently reassigns `activeConversationId` back to an abandoned conversation, misattributing the next sent message [packages/web/src/components/ChatWidget.tsx:193,211,272] — fixed: `streamAbortRef.current?.abort()` at the top of both `selectConversation`/`newChat`.
- [x] [Review][Patch] `selectConversation` has no AbortSignal/sequencing on `fetchConversation` — rapid double-clicks on two history rows race and the later-resolving (not later-clicked) response wins [packages/web/src/components/ChatWidget.tsx:193-208] — fixed: monotonic `conversationLoadIdRef` sequencing token, stale responses ignored.
- [x] [Review][Patch] History-load failures are swallowed silently with zero user feedback, inconsistent with the streaming error path a few lines away [packages/web/src/components/ChatWidget.tsx:205-208] — fixed: appends an errored assistant bubble with a dedicated `errorNote` on failure.
- [x] [Review][Patch] `send()`'s re-entrancy guard reads `sending` from render-scope state, not a ref — a fast double-trigger (e.g. Enter key-repeat) can start two concurrent streams [packages/web/src/components/ChatWidget.tsx:220-221] — fixed: guard now reads a synchronous `sendingRef`.
- [x] [Review][Patch] `onComposerKeyDown` has no IME-composition guard — Enter during IME candidate confirmation prematurely sends the partial draft [packages/web/src/components/ChatWidget.tsx:297-302] — fixed: `!e.nativeEvent.isComposing` added to the Enter check.
- [x] [Review][Patch] `authorInitials` strips all non-ASCII characters — accented/non-Latin author names produce wrong initials or the `"?"` fallback [packages/web/src/components/ChatWidget.tsx:954-957] — fixed: Unicode-aware `\p{L}\p{N}` regex.
- [x] [Review][Patch] `streamChat` silently drops a leftover unterminated frame when the stream closes without a trailing `\n\n` — no `done`/`error` is ever yielded, risking a permanently-blinking cursor (AC7) [packages/web/src/api/chat.ts:55-58] — fixed: throws on a non-empty leftover buffer at stream end.
- [x] [Review][Patch] Clicking an empty-state suggestion unconditionally clears the composer draft via `send()`'s `setDraft('')`, silently discarding unsent typed text [packages/web/src/components/ChatWidget.tsx:220-221,633] — fixed: `send(text, clearDraft)` param, suggestion click passes `false`.

All 8 patches applied 2026-07-08 (bmad-code-review). Gate re-run green: lint 0 / 517 unit+web (unchanged — no test asserted the exact old behavior) / build clean (5 pkgs) / 13 e2e chromium (unchanged pass count).

## Dev Notes

### D1 — Execution-trace panel DEFERRED (the headline decision)
The epic AC 5.4 and UX-DR20 describe a "loop de ejecución" panel with `tool_call` (`#F5A623`) and
`observation` (`#3BA55D`) steps. **The backend does not produce these.** Confirmed in code:
- `SSEFrameSchema` (`packages/shared/src/schemas/sse.ts:7-14`) is a 4-variant union:
  `token`/`citation`/`done`/`error`. Nothing else.
- The StateGraph (`packages/backend/src/agent/graph.ts:112-120`) is `START → retrieve → reason →
  respond → END`. **No `tool_exec` node** — line 110-111 is only a comment ("a future tool-call node
  would be added here"). The only node that streams is `respond`, and it emits `token` only.
- `citation` frames are appended by the `runChat` generator after the graph settles
  (`graph.ts:166-175`), then a single `done`. On failure the controller writes one `error` frame.
- Repo-wide, `tool_call`/`observation`/`tool_exec` appear **only** in that one comment.
- The prototype's trace steps are **hardcoded `setTimeout` fakes** in its `send()` (lines 597-604),
  not real stream data.

Building it for real = LLM tool-use + tools defined in `Hivly.config.yml` + a conditional
`tool_exec` loop in the graph + widening `SSEFrameSchema` — a *backend+shared* feature spanning 3
packages, its own story. **This story is frontend-only and does not touch that surface.** Recorded so
review does not flag the missing panel as an omission (mirrors 5.3's D3 reconciliation).

### D2 — SSE consumed via `fetch` streaming (AD-4), not EventSource
The wire format written by the backend is `data: ${JSON.stringify(frame)}\n\n` with **no `event:`
line** (`chatController.ts:76`) — the discriminator is the JSON `type` field. So the client parses
each `data:` payload as JSON and validates with `SSEFrameSchema.parse`. `EventSource` cannot POST a
body and is banned by convention — use `fetch` + a `ReadableStream` reader (AD-4, project-context
frontend rules).

### D3 — Wire order: `token*` → `citation*` → `done`
Citations arrive **after** all tokens (they are yielded post-graph in `runChat`), not interleaved
(the integration test asserts exactly this: `chat.integration.test.ts:182-186`). So the UI must
**attach citations to the just-finished agent bubble** — do not expect them mid-stream. The blinking
cursor is driven by the bubble's `streaming` flag, which flips false on `done` (or `error`).

### D4 — `ChatWidget` gains a `user` prop
The user-bubble avatar (UX-DR19) needs the user's initials/name, which live in `App.tsx`
(`user.username` + `initialsFromUsername`). Add a `user: { name; initials }` prop — a small,
justified break of 5.3's "no props" design (5.3 explicitly said the launcher dot + composer are
5.4's triggers). Agent label is **"Hivly"**; the user label is **"Vos"** (prototype convention,
line 716) with the avatar initials from the real username.

### D5 — Message state model
```ts
interface ChatMessage {
  id: string;                 // client-generated (crypto.randomUUID()) for React keys
  role: 'user' | 'assistant';
  content: string;
  citations: CitationType[];  // from @hivly/shared/schemas (CitationSchema): {channel, author, date}
  streaming?: boolean;        // assistant only, true while tokens arrive
  errored?: boolean;          // assistant only, set on an error frame / pre-stream throw
}
```
Send flow: append user msg → append `{role:'assistant', content:'', citations:[], streaming:true}` →
`for await` the frames, mutating the **last** message immutably (map + replace last). `done` →
`streaming:false` + capture `conversationId`. `error`/throw → `streaming:false, errored:true` and a
short inline note. The **empty state renders iff `messages.length === 0`**.

### D6 — Launcher dot + stream lifecycle (UX-DR15)
`launcherActive = sending && !chatOpen`. The in-flight stream is **not aborted on panel close** — the
widget stays mounted (only `chatOpen` toggles), so the stream keeps writing to `messages` and the FAB
shows the pulsing dot; reopening shows the completed answer. Abort the stream **only on unmount**
(effect cleanup). A second send is blocked while `sending` (also AC2's disabled state). `newChat`
clears `messages` + `activeConversationId` (the current turn, if any, is abandoned in state — keep it
simple; do not attempt mid-turn cancellation UX in this story).

### D7 — Token mapping (unchanged from 5.3 D2) + amber usage
Prototype `--tx*` → real names (map every occurrence): `--tx`→`--text-primary`
(`rgb(230,233,239)`), `--tx2`→`--text-secondary` (`rgb(199,205,216)`), `--tx3`→`--text-tertiary`
(`rgb(154,163,178)`), `--tx4`→`--text-muted` (`rgb(124,132,148)`), `--tx5`→`--text-subtle`
(`rgb(100,108,124)`). Other dark computed values (for `toHaveCSS`): `--bg`/`--on-accent`
`rgb(14,17,22)`, `--surface` `rgb(18,22,29)`, `--line` `rgb(24,29,37)`, `--border` `rgb(32,38,47)`,
`--border-strong` `rgb(42,49,61)`, `--accent-ink` (dark) `rgb(245,166,35)`. Brand hex
(theme-independent): amber `#F5A623`, gradient light stop `#FFCB6B`, Discord `#5865F2`, green
`#3BA55D`. The message-bubble text/cursor and the send button **hardcode `#F5A623`** exactly where
the prototype does; the citation `#channel` uses `var(--accent-ink)` (adapts to light theme). The
harness forces dark → assert the dark `rgb`.

### D8 — History load closes 5.3's deferral
`fetchConversation(id)` hits `GET /api/conversations/:conversationId` → `ConversationDetail`
(`{ id, createdAt, updatedAt, messages: [{ id, role, content, citations, createdAt }] }`, chronological,
`role` ∈ `user|assistant|system`). Map each into a `ChatMessage` (a `system` role, if ever present,
can be skipped or rendered as agent — none are seeded). Selecting a row loads + closes the overlay;
`newChat` clears. On open with an already-active id but no loaded messages, you may lazily load — but
the simplest correct behavior is: history-row click is the load trigger; opening the panel fresh
shows whatever is in `messages` (empty for a new session).

### D9 — E2E determinism + spec ordering
The harness backend injects a **deterministic** `fakeChatModel` (`test-helpers.ts:36`) that streams
`['Hola',' desde',' Hivly','.']` → the agent bubble ends at **"Hola desde Hivly."**. `retrieve` uses
the `fakeQueryEmbedder` + the seeded embeddings scoped to the member's channels (general+random,
`RETRIEVE_TOP_K=5`), so ≥1 `citation` frame is emitted — the streaming test can assert citation chips
deterministically. **The streaming test PERSISTS a new conversation** (mutating): it must be the
**last** test in `chat.spec.ts`, and no 5.4 test may assert an exact conversation count (the 5.3 AC5
`toHaveCount(1)` history test sorts first and must keep passing). Cross-spec safety: conversation
rows don't touch the `documents`/`user_read_status` tables `docs.spec.ts` asserts on, and Playwright
reseeds on each backend boot (`resetAndSeed` at `e2e/server.ts` boot) so runs stay idempotent. The
**already-seeded** conversation (no seed change needed):
- title (derived from first user msg) = **"¿Cómo configuro las notificaciones externas?"**
- assistant answer = **"Las notificaciones externas se configuran en Hivly.config.yml bajo la
  sección notifications."**
- one citation: channel **`general`**, author `e2e-author-ada`.

### D10 — Focus-trap interaction (mirror 5.3 round-3)
`getFocusableElements` queries the whole panel; the history overlay covers only the message area
(`position:absolute; inset:0` of the relative message-area div). Render the **message-area content**
(messages **and** empty state) only when `!chatHistoryOpen`, so overlay-covered citation links /
suggestion buttons can't become the Tab-trap's `first`/`last` boundary. The **composer** is a sibling
below the message area (not covered by the overlay), so it stays mounted and is a legitimate,
visible trap boundary — no change needed there. The panel's existing Escape/Tab `onKeyDown` is kept.

### SSE client template (`api/chat.ts`)
```ts
import { SSEFrameSchema, type SSEFrame, type ChatRequest } from '@hivly/shared/schemas';

export async function* streamChat(
  body: ChatRequest,
  signal?: AbortSignal,
): AsyncGenerator<SSEFrame> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    // Pre-stream failure: the endpoint sent { error, code } JSON, not a stream.
    let code = 'INTERNAL';
    try { code = (await res.json())?.code ?? code; } catch { /* keep default */ }
    throw new ChatStreamError(code, res.status);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, sep).trim(); // "data: {...}"
      buffer = buffer.slice(sep + 2);
      if (!raw.startsWith('data:')) continue;
      const json = JSON.parse(raw.slice(raw.indexOf(':') + 1).trim());
      yield SSEFrameSchema.parse(json);
    }
  }
}
```
(`ChatStreamError` — a tiny local `Error` subclass carrying `code`. Keep the parser tolerant of a
trailing partial frame in `buffer`; the backend always ends with a `done`/`error` frame + `res.end()`.)

### Bubbles, cursor, citations, composer — prototype geometry (authoritative)
Source: `KeepHive Web.dc.html` lines 350–426 (markup) + 578–629 (JS). Verbatim values:
- **Row/list:** message row `display:flex; gap:14px`; list gap between messages `22px`.
- **User avatar:** `30×30; border-radius:50%; background:#5865F2; color:#fff; font-size:11px; 600`.
- **Agent avatar:** `30×30` amber hexagon (`linear-gradient(150deg,#FFCB6B,#F5A623)` +
  `clip-path:polygon(25% 0%,75% 0%,100% 50%,75% 100%,25% 100%,0% 50%)`) with an inner `15×15
  var(--bg)` hexagon (outline effect). Reuse `CLIP_PATH`/`AMBER_GRADIENT` from `Hexagon.tsx`.
- **Name label:** `font-size:12.5px; font-weight:600; color:var(--text-tertiary); margin-bottom:8px`.
- **Message text:** `font-size:15px; line-height:1.7; color:var(--text-primary); white-space:pre-wrap`.
- **Cursor:** `display:inline-block; width:8px; height:17px; margin-left:2px; vertical-align:-2px;
  background:#F5A623; animation:kh-blink 1s step-end infinite`.
- **Fuentes label:** mono `font-size:10px; letter-spacing:0.06em; text-transform:uppercase;
  color:var(--text-subtle); margin-bottom:8px`. Chips row `display:flex; flex-wrap:wrap; gap:8px`.
- **Citation chip `<a>`:** `gap:8px; padding:6px 11px 6px 6px; border-radius:9px;
  background:var(--surface); text-decoration:none`; base `border:1px solid var(--border)` (in class),
  `:hover border-color:#5865F2`. Avatar `20×20; border-radius:50%; font-size:9.5px; 600;
  color:var(--on-accent)`. Channel `#{channel}` mono `11.5px; color:var(--accent-ink)`. Author
  `11.5px; color:var(--text-tertiary)`. External icon `12×12`, paths `M7 17L17 7` + `M8 7h9v9`.
- **Composer container:** `flex-shrink:0; padding:12px 16px 16px; border-top:1px solid var(--line);
  background:var(--bg)`. Input row `display:flex; align-items:flex-end; gap:9px; padding:7px 7px 7px
  14px; background:var(--surface); border-radius:14px`; base `border:1px solid var(--border-strong)`
  (in class), `:focus-within border-color:var(--accent-ink)`. Textarea as in AC1, placeholder
  "Preguntá al agente…". Send button `40×40; border-radius:11px; transition:all .12s ease` +
  state-driven bg/color/cursor (AC2), 17px paper-plane icon. Footer `margin-top:8px; centered;
  gap:6px; font-size:10.5px; color:var(--text-subtle)`, 11px lock icon + verbatim string.

### Citation link (be careful)
`CitationSchema` is `{channel, author, date}` — there is **no message URL** in the shape (the
prototype hardcodes `'https://discord.com/channels'`). Do not fabricate a Discord deep link from data
you don't have. Use a stable, safe href (e.g. `#` with `onClick preventDefault`, or omit `href` and
render a non-navigating element) OR a plain `https://discord.com/channels` placeholder consistent
with the prototype. Keep `target="_blank" rel="noopener noreferrer"` if it's an anchor. Note this
choice in a code comment; a richer link needs a message-id on the citation (out of scope, backend).

### Suggested Spanish copy
- Composer placeholder: **"Preguntá al agente…"** · footer: **"Respuestas con fuente verificable ·
  tools de hivly.config.yml"** (verbatim from the prototype).
- Inline error note (AC7): a short line in `var(--text-tertiary)`, e.g. **"No se pudo completar la
  respuesta. Intentá de nuevo."** (dev discretion, Spanish).
- User bubble name label: **"Vos"** (prototype); agent name: **"Hivly"**.

### Testing standards
- Vitest + Testing Library (jsdom); AAA + behavior-driven names. Mock `./api/chat` and
  `./api/conversations` in `ChatWidget.test.tsx`. For `streamChat`, return an async generator you
  control so token/citation/done/error ordering is deterministic.
- jsdom applies **no external CSS** — visual/CSS ACs are verified **only** by the Playwright spec
  (Epic 4 lesson: a visual AC is not done until the harness asserts it).
- Mandatory-steps §3.4: touching the UI requires the E2E run in the gate.

### Project Structure Notes
- **New:** `packages/web/src/api/chat.ts` (+ `.test.ts`).
- **Modified:** `packages/web/src/api/conversations.ts` (+ `.test.ts`) — add `fetchConversation`;
  `packages/web/src/components/icons.tsx` (SendIcon, LockIcon); `packages/web/src/components/
  ChatWidget.tsx` (+ `.test.tsx`) — composer, bubbles, streaming, citations, history-load;
  `packages/web/src/App.tsx` (+ `App.test.tsx`) — pass `user` prop; `packages/web/src/styles/
  components.css` (3 new class rules); `packages/web/tests/chat.spec.ts` (5.4 describe block);
  `packages/web/tests/README.md` (chat spec now mutates — ordering note);
  `_bmad-output/implementation-artifacts/deferred-work.md` (trace-panel deferral).
- **NOT touched:** any `@hivly/shared` or `@hivly/backend` file, `SSEFrameSchema`, `agent/graph.ts`,
  `e2e/seed.ts` (the seeded conversation already suffices), DB schema/migrations, the router
  (in-app state; the widget is not a screen). No new npm deps.
- Naming: `kh-` class prefix; `PascalCase.tsx` components; Spanish UI copy, English identifiers.
- AD-3: `web` imports only `@hivly/shared/schemas` (browser-safe), never the root barrel or `/db`.
- AD-4: chat streams over `fetch`/SSE, never `EventSource`/WebSocket.

### References
- [Source: _bmad-output/planning-artifacts/epics.md#Historia 5.4] — story + ACs.
- [Source: _bmad-output/planning-artifacts/epics.md#Requisitos de Diseño UX] — UX-DR15 (launcher
  dot), UX-DR19 (bubbles), UX-DR20 (**trace panel — DEFERRED, D1**), UX-DR21 (citations), UX-DR22
  (composer), UX-DR23 (kh-blink/kh-spin/kh-pulse).
- [Source: docs/context/design/KeepHive Web.dc.html:350-426,578-629] — pixel-exact bubbles/trace/
  citations/composer markup + streaming JS (stale `--tx*`; map per §D7).
- [Source: _bmad-output/implementation-artifacts/5-3-widget-flotante-fab-panel-base.md] — the shell
  this story extends (state handlers, cascade rule, focus-trap history, token table, harness notes).
- [Source: packages/web/src/components/ChatWidget.tsx] — current shell (empty state, history overlay,
  focus trap, `selectConversation`/`newChat` stubs to flesh out).
- [Source: packages/shared/src/schemas/sse.ts] — `SSEFrameSchema` (token/citation/done/error only).
- [Source: packages/shared/src/schemas/chat.ts] — `ChatRequestSchema` (`{message, conversationId?}`,
  `CHAT_MESSAGE_MAX_LENGTH=4000`), `CHAT_ERROR` codes.
- [Source: packages/shared/src/schemas/conversations.ts] — `ConversationDetailSchema` /
  `ConversationMessageSchema` (already exist, 5.2).
- [Source: packages/shared/src/schemas/citation.ts] — `CitationSchema` `{channel, author, date}`.
- [Source: packages/backend/src/presentation/controllers/chatController.ts:76] — wire format
  `data: <json>\n\n` (no `event:` line); pre-stream JSON errors vs mid-stream `error` frame.
- [Source: packages/backend/src/agent/graph.ts:112-176] — graph nodes + `token→citation→done` order;
  no `tool_exec` (D1/D3).
- [Source: packages/backend/src/test-helpers.ts:36] — `fakeChatModel` fixed tokens (E2E determinism).
- [Source: packages/backend/src/e2e/seed.ts:91-104] — the seeded conversation (title/answer/citation).
- [Source: packages/web/src/api/documents.ts, api/conversations.ts] — client templates.
- [Source: packages/web/tests/chat.spec.ts, tests/helpers/session.ts, tests/README.md] — harness
  spec + `loginAs`/`gotoChat` to reuse; ordering invariant to update.
- [Source: _bmad-output/project-context.md] — AD-3 subpath import, AD-4 SSE-not-EventSource, static
  SPA, cascade rule, English-only code.

## Dev Agent Record

### Agent Model Used

claude-opus-4-8 (bmad-dev-story, 2026-07-08).

### Debug Log References

- `npm run lint` → 0 errors (one caught + fixed mid-run: an unused `name` param in
  `UserBubble` — now used as the avatar `title` tooltip, since the label is the
  literal "Vos" per D4).
- `npm run test` → 517 passed (64 files); web project 101 passed (+ the new
  `chat.test.ts`, `conversations.test.ts` detail cases, and the 5.4 `ChatWidget`
  behavior tests).
- `npm run build` → clean (5 packages); web bundle 313.27 kB / 91.29 kB gzip.
- `npm run test:e2e -w @hivly/web` → 13 passed (chromium), incl. the 3 new 5.4 tests
  (composer AC1/AC2, history-load AC6, streaming AC3/AC4). Infra: OrbStack started,
  `docker compose up -d postgres redis`, `drizzle-kit migrate` applied.
- Unit-test matcher note: this repo does NOT wire `@testing-library/jest-dom`, so
  `toHaveTextContent` is unavailable — bubble-content assertions use
  `.textContent).toContain(...)` (matches the existing suite's conventions).

### Completion Notes List

- **Task 1 — SSE client (`api/chat.ts`):** `streamChat` async generator over `fetch`
  streaming (AD-4, not EventSource); parses `data:<json>\n\n` frames with a buffer
  that survives chunk-boundary splits, validates each with `SSEFrameSchema.parse`, and
  throws a typed `ChatStreamError(code, status)` on a pre-stream non-OK response.
  Ignores non-`data:` lines (SSE keep-alive comments). Imports only from
  `@hivly/shared/schemas` (AD-3).
- **Task 2 — `fetchConversation`:** added to `api/conversations.ts` mirroring
  `fetchConversations` (`credentials:'include'`, `!res.ok` throw,
  `ConversationDetailSchema.parse`). No shared-schema change (5.2 already exports it).
- **Task 3 — icons:** added `SendIcon` (paper plane). `LockIcon` already existed
  (Story 2.2) with the exact paths the story specified — reused as-is, not duplicated.
- **Task 4 — `user` prop:** `ChatWidget` gains `user: { name; initials }`; `App.tsx`
  passes the same `userIdentity` object it already builds for `AppLayout` (the only
  App change). `App.test.tsx` renders `<App />` (not `ChatWidget` directly), so the
  prop flows through unchanged — no test edit needed; App session tests still green.
- **Tasks 5–8 — `ChatWidget` chat:** message state model (D5), send flow consuming
  `token→citation→done`/`error` (mutating the streaming assistant bubble immutably by
  id), abort ONLY on unmount (D6, not on panel close — verified by a unit test spying
  on `AbortController.abort`), `launcherActive = sending && !chatOpen`, suggestions
  wired to `send`, history-row load via `fetchConversation` (system role filtered),
  `newChat` clears to the empty state. Bubbles reuse `CLIP_PATH`/`AMBER_GRADIENT` for
  the agent hexagon avatar (inline, like the FAB); composer with auto-resizing textarea
  (≤120px), Enter-to-send / Shift+Enter newline, and the state-driven send button.
  Message-area content gated on `!chatHistoryOpen` (D10 focus-trap parity with 5.3
  round-3); the composer is a sibling below the overlay, so it stays a legitimate,
  visible Tab-trap boundary — the 5.3 trap tests were updated to compute the focusable
  set (now including the textarea) instead of assuming buttons-only.
- **Task 7 — citation link:** `CitationSchema` is `{channel, author, date}` with NO
  message URL, so the chip cannot build a real Discord deep link (needs a message id —
  out of scope, backend). Uses the prototype's generic `https://discord.com/channels`
  placeholder with `target="_blank" rel="noopener noreferrer"`, documented in a code
  comment. Author-avatar initials from the author string on a fixed amber background
  (no per-author color map in scope).
- **Task 9 — CSS:** `.kh-chat-input-row` (base border → amber on `:focus-within`),
  `.kh-chat-citation` (base border → blurple on `:hover`), `.kh-chat-send:focus-visible`
  ring. Base border/color live in the class (cascade rule, Epic 4 AI#4); the send
  button's disabled/enabled bg is the one deliberate inline state (React-driven).
- **Task 8 (D1) — trace panel DEFERRED:** no `SSEFrameSchema`/`agent/graph.ts`/shared/
  backend change. Recorded in `deferred-work.md` as a future backend+shared story.
- **Task 11 — E2E:** added a `Story 5.4` describe block reusing `gotoChat`; the
  streaming test MUTATES (persists a conversation) so it is ordered LAST (D9) and no
  test asserts an exact conversation count after it. Updated the spec header comment
  and `tests/README.md` (chat.spec is no longer read-only).

### File List

**New**
- `packages/web/src/api/chat.ts`
- `packages/web/src/api/chat.test.ts`

**Modified**
- `packages/web/src/api/conversations.ts` (+ `fetchConversation`)
- `packages/web/src/api/conversations.test.ts` (+ `fetchConversation` cases)
- `packages/web/src/components/icons.tsx` (+ `SendIcon`)
- `packages/web/src/components/ChatWidget.tsx` (composer, bubbles, streaming, citations, history-load)
- `packages/web/src/components/ChatWidget.test.tsx` (5.4 behavior tests + focus-trap updates)
- `packages/web/src/App.tsx` (pass `user` prop to `ChatWidget`)
- `packages/web/src/styles/components.css` (3 new class rules)
- `packages/web/tests/chat.spec.ts` (Story 5.4 describe block; header comment)
- `packages/web/tests/README.md` (chat spec now mutates — ordering note)
- `_bmad-output/implementation-artifacts/deferred-work.md` (trace-panel deferral)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (5-4 → in-progress → review)

**NOT touched** (as scoped): any `@hivly/shared`/`@hivly/backend` file, `SSEFrameSchema`,
`agent/graph.ts`, `e2e/seed.ts`, DB schema/migrations, the router. No new npm deps.

## Change Log

| Date | Change |
|---|---|
| 2026-07-08 | Story 5.4 created (bmad-create-story). Epic 5 fourth/last story. Frontend-only chat streaming UI (composer + bubbles + SSE token streaming + citation chips + history load), extending the 5.3 shell. Headline decision D1: the "loop de ejecución" execution-trace panel (UX-DR20 tool_call/observation) is DEFERRED — the backend SSE contract (frozen 5.1) emits only token/citation/done/error and has no tool_exec node; a future backend+shared story adds it. sprint-status 5-4 backlog → ready-for-dev. |
| 2026-07-08 | Story 5.4 implemented (bmad-dev-story). Tasks 1–13 complete. New `api/chat.ts` (fetch-streaming `streamChat` async generator, AD-4) + `fetchConversation`; `SendIcon`; `ChatWidget` gains the composer, user/agent bubbles, SSE `token` streaming with the amber `kh-blink` cursor, citation chips, suggestion→send wiring, FAB `launcherActive` dot, and history-message load (closes 5.3's deferral). D1 trace panel deferred (no shared/backend change). Gate green: lint 0 / 517 unit+web / build clean (5 pkgs) / 13 E2E chromium (3 new 5.4 tests). Status review; sprint-status 5-4 in-progress → review. |
| 2026-07-08 | Story 5.4 code review (bmad-code-review, 3 adversarial layers: Blind Hunter + Edge Case Hunter + Acceptance Auditor). Auditor: 0 AC violations (AC1–10 and D1–D10 all honored). 8 patches applied, all real bugs in the new code, none pre-existing: (1) `newChat`/`selectConversation` now abort the in-flight stream, closing a hole where a stale `done` frame could silently reassign `activeConversationId` after the user moved on; (2) `selectConversation` gained a monotonic sequencing token so rapid double-clicks on two history rows can't race; (3) a failed history load now appends a visible errored bubble instead of failing silently; (4) `send()`'s re-entrancy guard now reads a synchronous ref instead of render-scope state, closing a narrow double-send race; (5) `onComposerKeyDown` now ignores Enter during IME composition; (6) `authorInitials` is now Unicode-aware (accented/non-Latin author names no longer collapse to "?"); (7) `streamChat` now throws instead of silently dropping a leftover unterminated frame when the stream closes early, so the assistant bubble errors out instead of blinking forever; (8) a suggestion-chip send no longer wipes an unrelated in-progress composer draft. 6 findings dismissed as noise (schema-guaranteed frame exhaustiveness, spec-mandated auto-scroll, spec-sanctioned citation placeholder link, unreachable multi-line SSE `data:` case given the backend's single-line JSON wire contract, no-op reader-lock nitpick, speculative `crypto.randomUUID` secure-context concern). Gate re-run green: lint 0 / 517 unit+web (unchanged) / build clean (5 pkgs) / 13 e2e chromium (unchanged). Status review → done; sprint-status 5-4 review → done. |
