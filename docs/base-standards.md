---
description: This document contains all development rules and guidelines for the Hivly project, applicable to all AI agents (Claude, Cursor, Codex, Gemini, etc.).
alwaysApply: true
---

## 1. Core Principles

- **Small tasks, one at a time**: Always work in baby steps, one at a time. Never go forward more than one step. In BMAD Method this means one story (`bmad-dev-story`) at a time — never bundle stories.
- **Respect the architecture invariants**: `docs/context/ARCHITECTURE-SPINE.md` defines invariants `AD-1 … AD-13`. Before touching an area, read the AD that governs it. Never break one without an explicit, recorded decision.
- **Test-Driven Development**: Start with failing tests for any new functionality (TDD), according to the task details. For core/domain and orchestration work, write the story's acceptance/integration tests first (red), then implement to green. UI and adapter glue may test after.
- **Type Safety**: All code must be fully typed. Strict TypeScript; avoid `any` (use `unknown` or specific types).
- **Contracts in `@hivly/shared`**: DB schema (Drizzle), API shapes (Zod) and config live only in `packages/shared`. Services never redefine them locally, and never import each other (AD-2).
- **Clear Naming**: Use clear, descriptive names for all variables and functions.
- **Incremental Changes**: Prefer incremental, focused changes over large, complex modifications.
- **Question Assumptions**: Always question assumptions and inferences.
- **Pattern Detection**: Detect and highlight repeated code patterns; reuse the existing helper instead of duplicating it.

## 2. Language Standards

- **English Only**: All technical artifacts must always use English, including:
    - Code (variables, functions, classes, comments, error messages, log messages)
    - Documentation (README, guides, API docs, SPECs, roadmap)
    - Issues and PRs (titles, descriptions, comments)
    - Data schemas and database names
    - Configuration files and scripts
    - Git commit messages
    - Test names and descriptions
- **Artifact-language precedence** (from the workflow skills): explicit user instruction > the project's declared docs language (English) > English. The **conversation** language never decides — a Spanish prompt still produces English commits/PRs/issues/SPECs.

## 3. Specific standards

For detailed standards and guidelines specific to different areas of the project, refer to:

- [Backend Standards](./backend-standards.md) — monorepo services (`shared`, `web`, `bot`, `backend`, `workers`), Drizzle/pgvector patterns, LangGraph agent, Redis Streams, API design, DDD principles, SOLID+DRY, testing and security.
- [Frontend Standards](./frontend-standards.md) — Vite + React SPA, Zod-inferred API types, SSE chat client, UI/UX and testing.
- [Documentation Standards](./documentation-standards.md) — technical documentation structure, formatting, and maintenance guidelines, including AI standards like this document.
- [Story Execution Mandatory Steps](./bmad-story-mandatory-steps.md) — required checklist and verification gate when planning (epics/stories) and executing stories with the BMAD Method skills.
- [Data Model](./data-model.md) — entities, fields and relationships (source of truth: `packages/shared/src/db/schema.ts`).
- [Development Guide](./development_guide.md) — environment setup and how to run the stack and tests.

## 4. Project Skills (BMAD Method)

- The project runs on the **BMAD Method** (BMM module), installed under `_bmad/` and configured in `_bmad/core/config.yaml` and `_bmad/bmm/config.yaml`. Skills are invoked as `bmad-*` (e.g. `bmad-create-story`, `bmad-dev-story`).
- When a request matches a skill, load and follow it before continuing. Named agents map to roles: **Mary** (analyst), **John** (PM), **Sally** (UX designer), **Winston** (architect), **Amelia** (dev), **Paige** (tech writer).
- **Way of working**:
    - **Plan** — `bmad-prd` (PRD, John) → `bmad-ux` (UX specs, Sally) → `bmad-architecture` (architecture spine, Winston) → `bmad-create-epics-and-stories`. Gate with `bmad-check-implementation-readiness`.
    - **Sprint** — `bmad-sprint-planning` (generate sprint status from epics), `bmad-create-story` (author a self-contained story), `bmad-sprint-status` (progress).
    - **Implement** — `bmad-dev-story` implements one story at a time (`bmad-quick-dev` for small changes).
    - **Review** — `bmad-code-review` (mandatory before merge) then `bmad-checkpoint-preview` (human review). Never auto-merge.
    - **Adjust / close** — `bmad-correct-course` for mid-sprint changes; `bmad-retrospective` to close an epic. See [Story Execution Mandatory Steps](./bmad-story-mandatory-steps.md).
- **Artifacts**: planning artifacts (PRD, UX, architecture, epics, stories) live under `_bmad-output/planning-artifacts`; sprint status and per-story implementation notes under `_bmad-output/implementation-artifacts`. Durable project knowledge (`project_knowledge` in `_bmad/bmm/config.yaml`) lives in `docs/`.

## 5. Planning Model Requirement

Planning and review are judgment work and must run on the **strongest** model at high reasoning.

This requirement applies to:
- Planning skills: `bmad-prd`, `bmad-architecture`, `bmad-ux`, `bmad-create-epics-and-stories`, `bmad-check-implementation-readiness`.
- Story authoring: `bmad-create-story`.
- Review skills: `bmad-code-review`, `bmad-checkpoint-preview`, and the adversarial `bmad-review-*` lenses.

Before starting one of these workflows, verify the session is on Opus high reasoning. If it is not, **self-correct** by adding `"model": "claude-opus-4-8"` to `.claude/settings.json` (use the `update-config` skill or edit directly), then continue — do not stop and ask the user. Return to the cheaper tier (e.g. `sonnet` medium) for mechanical implementation steps such as `bmad-dev-story` / `bmad-quick-dev`.

**Never review a change with a model weaker than the one that wrote it.** Across a model/effort boundary, hand off to a fresh turn — do not compose.

## 6. BMAD Install Integrity and Portability

- **Canonical Source**: BMAD is installed under `_bmad/` (core + BMM module) and configured by `_bmad/core/config.yaml` and `_bmad/bmm/config.yaml` (generated by the BMAD installer, version pinned in each file's header). Treat those config files as the source of truth for project name, output language, and artifact locations.
- **Configuration precedence**: `communication_language` and `document_output_language` are set to English in the config — respect them (see §2). Artifact folders (`planning_artifacts`, `implementation_artifacts`, `project_knowledge`) are resolved from the config, never hardcoded ad-hoc.
- **Customization**: Adjust agent or workflow behavior only through `bmad-customize` (authored overrides), not by editing installed skill internals — installer updates would overwrite them.
- **Portability**: On agents without a slash-command menu, invoke the equivalent `bmad-*` skill by name and follow it literally in a fresh conversation; run planning/review on your strongest model (see §5).
- **Completion Gate**: A change is incomplete if it leaves the BMAD config, epics/stories, or durable `docs/` out of sync with the code that shipped.

## 7. Documentation Is the Source of Truth (post-apply changes)

When a new fix/change request appears after a story has been implemented (`bmad-dev-story`) and before it is merged, treat it as a **spec update first**, not an informal "fix this quickly". Documentation is the source of truth.

Required order:

1. Update the affected story and its epic in `_bmad-output/planning-artifacts` — acceptance criteria and scope — as part of the original design, not appended as a "bugfix". Update the architecture context in `docs/context/` if a decision moved it.
2. If the scope change is significant, run `bmad-correct-course` to re-plan (and, if needed, re-author the story with `bmad-create-story`) before coding.
3. Implement code only after the story reflects the new request.
4. Re-run the verification gate (type-check + tests + build) against the updated story before opening/updating the PR.

Do not apply direct code-only fixes in this window without updating the story first.

## 8. Commit Conventions

The repository uses **[Conventional Commits](https://www.conventionalcommits.org/)**. Format:

```
<type>(<scope>): <summary>

[optional body]

[optional footer(s)]
```

- **In English**, imperative mood, no trailing period, ≤ 72 chars in the summary (see §2).
- **One commit per meaningful slice** of a story; never a single dump commit at the end. Run the commit — describing it is not committing (see `bmad-story-mandatory-steps.md`).

### Allowed types

| Type | Use for |
|---|---|
| `feat` | A new capability or user-facing behavior |
| `fix` | A bug fix |
| `refactor` | Code change that neither adds a feature nor fixes a bug |
| `perf` | A performance improvement |
| `test` | Adding or correcting tests only |
| `docs` | Documentation only (`docs/`, README, `api-spec.yml`, code comments) |
| `build` | Build system, dependencies, Docker, Compose |
| `ci` | CI configuration and scripts |
| `chore` | Maintenance that doesn't touch `src/` behavior (tooling, configs, `_bmad/`) |
| `revert` | Reverts a previous commit |

### Scope

The `<scope>` is the affected workspace, without the `@hivly/` prefix: **`shared`, `bot`, `backend`, `workers`, `web`**. Use `repo` for cross-cutting/root-level changes (Compose, root config, docs spanning several packages). Scope is recommended; omit it only when genuinely global.

Because contracts live in `@hivly/shared` (AD-2/AD-5/AD-6), a change that alters the schema or a Zod contract is scoped `shared` even if a consumer motivated it.

### Breaking changes

Mark a breaking change to a public contract (DB schema, API/Zod shape, event type, config shape) with `!` after the scope **and** a footer:

```
feat(shared)!: rename embeddings.channel_id to channel_ref

BREAKING CHANGE: consumers must read channel_ref; migration 00xx renames the column.
```

### Footers

- `Closes #<n>` for issue-born work (usually also stated in the PR body).
- `Co-authored-by:` when pairing.

### Examples

```
feat(backend): stream chat answers over SSE with citation frames
fix(workers): upsert on existing embedding.id instead of throwing (AD-13)
refactor(shared): extract RBAC channel-filter into a reusable query helper
test(backend): cover allowedChannelIds expansion for revoked roles
docs(repo): adapt first-level docs to the BMAD Method workflow
build(repo): pin pgvector image and add migrator service to compose
```
