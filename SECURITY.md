# Security Policy

Share2Brain indexes real conversations from real communities. We take the
confidentiality of that data seriously, and we appreciate anyone who helps us
keep it safe.

## Reporting a vulnerability

**Please do NOT open a public issue for security problems.**

Report vulnerabilities privately through
[GitHub Security Advisories](https://github.com/borjaberrocal87/share2brain/security/advisories/new)
("Report a vulnerability" on the repository's Security tab).

Include what you can:

- A description of the issue and its impact
- Steps to reproduce (a minimal proof of concept helps a lot)
- Affected component (`bot`, `backend`, `workers`, `web`, `shared`, deployment)
- Any suggested fix or mitigation

You can expect an acknowledgment within **72 hours** and a status update at
least every **7 days** until the issue is resolved. Once a fix ships, we will
credit you in the advisory (unless you prefer to stay anonymous).

## Supported versions

Share2Brain is pre-1.0. Only the latest release (and `main`) receives security
fixes. If you self-host, keep your deployment updated:

```bash
git pull && docker compose build && docker compose up -d
```

## Areas of special interest

Reports in these areas are especially valuable, because they map to the
project's core security invariants:

- **RBAC bypass** — any way to retrieve search results, documents, chat answers,
  or stats derived from channels the session's Discord roles cannot see.
- **Session handling** — session fixation/hijacking, cookie issues (sessions
  live in Redis; the httpOnly cookie holds only the session ID).
- **Secret exposure** — tokens or API keys leaking into logs, error responses,
  or the frontend bundle.
- **Injection** — SQL injection via search/chat inputs, or prompt-injection
  paths that exfiltrate content across RBAC boundaries.

## Out of scope

- Vulnerabilities in third-party dependencies with no exploitable path in
  Share2Brain (please report those upstream — a heads-up issue here is still
  welcome).
- Issues that require a maliciously modified `Share2Brain.config.yml` or `.env`
  on the operator's own machine (the operator already owns the deployment).
- Denial of service against your own self-hosted instance.
