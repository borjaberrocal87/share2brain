# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Initial open-source release of the Share2Brain MVP.

### Added

- **Ingestion pipeline** — Discord Bot (Gateway listener + historical backfill
  with snowflake reconciliation) publishing to Redis Streams; idempotent
  Indexer/Sync workers writing embeddings to PostgreSQL + pgvector.
- **AI-curated resource index** — messages containing URLs are enriched with an
  AI-generated title and description before indexing.
- **Semantic search** — embedding-similarity search with per-channel RBAC
  enforced inside the vector query.
- **RAG agent chat** — LangGraph agent with SSE streaming responses and
  verifiable citations (channel, author, date, link); conversation history.
- **Auth & access control** — Discord OAuth2 login, Redis-backed sessions,
  role-based channel access, optional config-gated guest access for demos.
- **Documents & read tracking** — per-member read state for indexed fragments,
  with sidebar badge.
- **Knowledge stats** — RBAC-scoped analytics view (activity, coverage, top
  users).
- **Notifications** — optional Telegram/Slack notifications.
- **UI internationalization** — Spanish and English, selected via
  `ui.language` and served from `/api/ui-config`.
- **Deployment** — 7-service Docker Compose stack (nginx as the only exposed
  service, one-shot migrator), configured via `Share2Brain.config.yml` +
  `.env`.
