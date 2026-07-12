# Roadmap

Where Share2Brain is and where it's heading. This is a living document — the
best way to influence it is to [open an issue](https://github.com/borjaberrocal87/share2brain/issues)
describing your use case.

## ✅ Shipped (MVP)

- Automatic ingestion of Discord messages (realtime + historical backfill)
- AI-curated resource index: shared links enriched with title + description
- Semantic search over the community's knowledge (pgvector)
- RAG agent chat with streaming responses and verifiable citations
- Per-channel RBAC enforced inside the vector query (Discord roles)
- Discord OAuth2 login, Redis-backed sessions, optional guest demo access
- Per-member read tracking with unread badges
- Knowledge stats view (activity, read coverage, top contributors)
- Optional Telegram/Slack notifications
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
- **More UI languages** — the i18n plumbing is in place; new locales are a
  `locales/<lang>.json` away. Contributions welcome.
- **Additional ingestion sources** — the pipeline is event-driven and
  source-agnostic by design; Discord is the first adapter.

## 🚫 Non-goals

To keep the project focused, some things are deliberately out of scope:

- **SaaS / multi-tenant hosting** — Share2Brain is self-hosted, one instance
  per Discord guild. Data sovereignty is the point.
- **Serverless deployments** — the deploy unit is Docker Compose.
- **A general-purpose chatbot** — the agent answers from your community's
  indexed knowledge with citations, or says it doesn't know. No freestyle.
