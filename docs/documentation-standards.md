---
description: Standards and best practices for technical documentation in the Share2Brain project, including documentation structure, update processes, and language rules.
globs:
alwaysApply: true
---
# Rules and Patterns for documentation and AI specs

## Introduction
Technical documentation applies to all documentation relative to the project, such as the data model, README, API specs, architecture context, and other MD docs that describe how the project is structured, runs, and operates.
AI specs refers to the documents that tell AI agents how to behave, document, plan, code, etc., which includes team agreements, standards and conventions (this `docs/` folder and the BMAD Method skills installed under `_bmad/`).

## General rules
- ALWAYS WRITE IN ENGLISH, including comments and any explanation in the files. This applies both to creating new documentation and updating existing one, and it also applies to documentation within the code (comments, explanations of functions or fields, etc.).
- **Docs-language precedence**: explicit user instruction > the project's declared docs language (English) > English. The conversation language is not a signal.

## Documentation map (source of truth)

Design context lives in `docs/context/` and is authoritative:

- `docs/context/PRD.md` — product requirements (the what and the why).
- `docs/context/ARCHITECTURE-SPINE.md` — invariants `AD-1 … AD-13`, stack, State Ownership, dependency rules.
- `docs/context/TECHNICAL-DESIGN.md` — detailed technical design (services, data model, ingestion pipeline, RAG agent, auth/RBAC, API, deployment).
- `docs/context/design/` — Web App mockups / design.

Planning and delivery artifacts (BMAD Method), resolved from `_bmad/bmm/config.yaml`:

- `_bmad-output/planning-artifacts/` — PRD, UX specs, architecture, and the epics & stories list (from `bmad-prd`, `bmad-ux`, `bmad-architecture`, `bmad-create-epics-and-stories`).
- `_bmad-output/implementation-artifacts/` — sprint status tracking and per-story implementation notes (from `bmad-sprint-planning`, `bmad-create-story`, `bmad-dev-story`).
- `_bmad/core/config.yaml` and `_bmad/bmm/config.yaml` — BMAD install configuration (project name, languages, artifact locations).

Standards docs (this folder): `base-standards.md`, `backend-standards.md`, `frontend-standards.md`, `documentation-standards.md`, `bmad-story-mandatory-steps.md`, `data-model.md`, `development_guide.md`, `self-hosting.md`, plus `api-spec.yml`.

## Technical Documentation
Before making any commit or git push, or if you're asked to document a commit, you must ALWAYS review which technical documentation should be updated.

When updating documentation, I will:
1. Review all recent changes in the codebase.
2. Identify which documentation files need updates based on the changes. Some clear examples:
   - Data model changes (`packages/shared/src/db/schema.ts`) → update `data-model.md`.
   - API contract changes (`packages/shared/src/schemas/`, routes) → update `api-spec.yml`.
   - Changes in libraries, dependencies, migrations, or anything that changes the install/run process → update the relevant `*-standards.md` and `development_guide.md`.
   - Architectural changes → update `docs/context/ARCHITECTURE-SPINE.md` / `TECHNICAL-DESIGN.md` and record the rationale in the story's implementation notes (and the architecture artifact via `bmad-architecture` if the spine moved).
3. Update each affected documentation file in English, maintaining consistency with existing documentation.
4. Ensure all documentation is properly formatted and follows the established structure.
5. Verify that all changes are accurately reflected in the documentation.
6. Report which files were updated and what changes were made.

Per-story doc discipline (BMAD Method): each story updates its status and implementation notes in `_bmad-output/implementation-artifacts` and the durable `docs/` a change implies. A story is not mergeable with docs pending — that is one of `bmad-code-review`'s gates.

## AI specs

This rule establishes a mandatory process for the AI to:
*   Learn from user feedback, guidance, and suggestions during interactions.
*   Identify opportunities to improve existing Development Rules based on these learnings proactively.
*   Keep the AI's assistance aligned with evolving project needs and user expectations.
*   Incorporate user feedback into the AI's operational framework to maximize its value.

This rule is applicable after any interaction where the user provides explicit or implicit feedback, suggestions, corrections, new information, or expresses preferences. **The AI MUST actively analyze all user interactions for such learning opportunities, not only passively waiting for direct feedback, to proactively refine its understanding and the project's best practices.**

### Common Pitfalls and Anti-Patterns to be avoided by the AI

*   **Skipping Approval Process:** Applying rule modifications without obtaining explicit user review and approval first.
*   **Unlinked Proposals:** Proposing rule changes without clearly connecting them to the specific user feedback or insights gained from the interaction.
*   **Imprecise Modifications:** Suggesting modifications without precisely identifying which rule or specific sections within a rule should be changed, hindering effective user review.
*   **Unaddressed Feedback:** Not initiating the learning and review process when the user provides relevant feedback that could improve the rules.
*   **Scope Creep:** Updating multiple unrelated rules simultaneously or making changes that exceed the scope of the feedback received.
*   **Unprompted Rule Changes:** Modifying rules proactively when there is no direct connection to user feedback or a learning opportunity. Rule updates should be reactive and feedback-driven.
*   **Missing Update Confirmation:** Failing to notify the user after a rule modification has been successfully implemented following their approval.
