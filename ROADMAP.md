# Roadmap

Where Share2Brain is and where it's heading. This is a living document — the
best way to influence it is to [open an issue](https://github.com/borjaberrocal87/share2brain/issues)
describing your use case.

## ✅ Shipped (MVP — on `main`, first tagged release pending)

- Automatic ingestion of Discord messages (realtime + historical backfill)
- AI-curated resource index: shared links enriched with title + description
- Semantic search over the community's knowledge (pgvector)
- RAG agent chat with streaming responses and verifiable citations
- Per-channel RBAC enforced inside the vector query (Discord roles)
- Discord OAuth2 login, Redis-backed sessions, optional guest demo access
- Per-member read tracking with unread badges
- Knowledge stats view (activity, read coverage, top contributors)
- Optional Slack notifications (Telegram is implemented in code; Docker
  Compose wiring pending — see the reliability items below)
- UI in Spanish and English (`ui.language`)
- Single-command deployment: 7-service Docker Compose stack

## 🔜 Next — reliability hardening

Making the ingestion pipeline production-grade for larger communities:

- **Dead-letter handling** — retry cap + alerting for stream entries that fail
  processing permanently (today they stay pending for reprocessing).
- **Transactional outbox** — close the small producer-side race between the DB
  write and the stream publish.
- **Bulk deletions** — handle Discord `messageDeleteBulk` (e.g. moderation
  sweeps) in the sync pipeline.
- **Full offline reconciliation** — detect edits/deletions that happened while
  the bot was offline, beyond the current backfill window.
- **Knowledge-lifecycle notifications** — notify when a newly enriched resource
  lands in the index.

## 💡 Exploring

Ideas we want, pending design work — feedback especially welcome:

- **Agent execution-trace panel** — inspect how the agent reasoned: retrieval
  steps, tool calls, and why each source was selected.
- **More UI languages** — the UI is fully translation-ready (Spanish and
  English today). A new locale needs a `locales/<lang>.json` in `packages/web`
  plus registering the language code wherever the existing `es`/`en` pair is
  wired (shared config + UI-config schemas, the web i18n setup, and the locale
  parity test). Contributions welcome.
- **Additional ingestion sources** — the pipeline is event-driven and
  source-agnostic by design; Discord is the first adapter, with **Slack** as
  the next target: ingest messages and shared links from Slack channels
  alongside Discord into the same curated index (with its own OAuth + RBAC
  mapping).
- **Richer resource types** — go beyond plain page links: index YouTube and
  other video transcripts, PDFs and message attachments, and detect and merge
  duplicate URLs so the same resource is not indexed twice.
- **Periodic knowledge digest** — a scheduled (e.g. weekly) roundup of the
  resources newly indexed in that window, delivered via the existing notifier
  (Telegram/Slack) or posted back to a Discord channel. Distinct from the
  per-resource lifecycle notification above: this is an aggregated summary meant
  to bring members back.
- **Personal knowledge tools** — per-member collections/bookmarks, saved
  searches, personal notes attached to any resource, and topic subscriptions
  that alert you when a matching resource is indexed. Builds on the existing
  per-member read tracking.
- **Export & read-only API** — export the curated index to Markdown/JSON and
  expose an API-key-gated read-only API, so the knowledge base stays portable
  and integrable rather than locked in.

## 🚫 Non-goals

To keep the project focused, some things are deliberately out of scope:

- **SaaS / multi-tenant hosting** — Share2Brain is self-hosted, one instance
  per Discord guild. Data sovereignty is the point.
- **Serverless deployments** — the deploy unit is Docker Compose.
- **A general-purpose chatbot** — the agent answers from your community's
  indexed knowledge with citations, or says it doesn't know. No freestyle.
