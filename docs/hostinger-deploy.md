# Hostinger VPS Deployment Guide

Share2Brain deploys to a Hostinger VPS using pre-built Docker images from GitHub
Container Registry (GHCR). GitHub Actions builds all images on push to `main` and
pulls them on the VPS — the server never builds anything.

## Architecture

```
GitHub Actions                          Hostinger VPS
┌─────────────────────┐                ┌──────────────────────────┐
│ build-and-push (×5)  │──── GHCR ────→│ docker compose pull      │
│  backend             │                │ docker compose up -d     │
│  bot                 │                │                          │
│  workers             │                │  Caddy (:80/:443)        │
│  nginx               │                │    ├→ landing (share2brain.app)
│  migrator            │                │    └→ nginx  (demo.share2brain.app)
└─────────────────────┘                └──────────────────────────┘
```

## Compose files

| File | Used by | Purpose |
|------|---------|---------|
| `docker-compose.yml` | Local dev | Base config — `build:` from source |
| `docker-compose.prod.yml` | VPS | Prod config — `image:` from GHCR, Caddy networking |

## Prerequisites

- Hostinger VPS with Docker and Docker Compose v2
- Caddy running with the landing page on `share2brain.app`
- DNS control for `share2brain.app`
- GitHub repo with Actions enabled

## Step 1 — DNS

| Type | Name | Value |
|------|------|-------|
| A | `demo` | `<VPS_PUBLIC_IP>` |

## Step 2 — Prepare the VPS (first time only)

```bash
cd /opt
git clone https://github.com/borjaberrocal87/share2brain.git
cd share2brain

# Secrets
cp .env.example .env
nano .env

# Generate random values
openssl rand -hex 16   # → POSTGRES_PASSWORD
openssl rand -hex 16   # → REDIS_PASSWORD
openssl rand -hex 32   # → SESSION_SECRET
```

Critical `.env` values:

| Variable | Value |
|----------|-------|
| `DISCORD_REDIRECT_URI` | `https://demo.share2brain.app/api/auth/callback` |
| `FRONTEND_URL` | `https://demo.share2brain.app` |
| `VITE_COMMUNITY_NAME` | Your community name |
| `POSTGRES_PASSWORD` | Generated |
| `REDIS_PASSWORD` | Generated |
| `SESSION_SECRET` | Generated |
| `DISCORD_*` | From Discord Developer Portal |
| `LLM_API_KEY` | Your LLM provider |
| `EMBEDDINGS_API_KEY` | Your embeddings provider |

```bash
# Behavior config
cp Share2Brain.config.yml.example Share2Brain.config.yml
nano Share2Brain.config.yml

# Caddy expects this bind mount
mkdir -p certs
```

### Verify Caddy's network name

```bash
docker network ls | grep share2brain
# Should show: share2brain-landing_share2brain-network
# If different, update `name:` in docker-compose.prod.yml → networks.caddy_net
```

### Add subdomain to Caddy

Edit Caddy's config (Caddyfile or compose labels) and add:

```
demo.share2brain.app {
    reverse_proxy share2brain-nginx:80
}
```

## Step 3 — GitHub Secrets

**Settings → Secrets and variables → Actions**:

| Secret | Value |
|--------|-------|
| `HOSTINGER_HOST` | VPS public IP |
| `HOSTINGER_USER` | SSH user |
| `HOSTINGER_SSH_KEY` | Full private key |

Generate if needed:

```bash
ssh-keygen -t ed25519 -C "github-deploy-share2brain"
ssh-copy-id -i ~/.ssh/id_ed25519.pub root@<IP>
cat ~/.ssh/id_ed25519   # → paste as HOSTINGER_SSH_KEY
```

## Step 4 — First deploy

Push to `main`. The pipeline:

1. **build-and-push** — builds 5 images in parallel (Buildx + GHA cache), pushes to GHCR
2. **deploy** — SCPs `docker-compose.prod.yml` to VPS → `pull` → `up -d`

After deploy, verify:

1. `curl https://demo.share2brain.app/health` → 200 OK
2. `https://demo.share2brain.app` → SPA loads
3. Discord login → redirect to `/api/auth/callback`
4. `share2brain.app` landing still works

## Manual re-deploy

Trigger from **GitHub Actions → Deploy → Run workflow**, or from the VPS:

```bash
cd /opt/share2brain
# Pull latest images (requires GHCR auth)
echo $GITHUB_TOKEN | docker login ghcr.io -u borjaberrocal87 --password-stdin
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d --remove-orphans
```

## Rollback

```bash
cd /opt/share2brain
# List available image tags on GHCR, or use a known SHA tag:
docker compose -f docker-compose.prod.yml down
# Edit docker-compose.prod.yml: change :latest to :sha-<good-commit>
docker compose -f docker-compose.prod.yml up -d
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| 502 from Caddy | Verify `share2brain-nginx` is on `caddy_net` and Caddyfile has the block |
| TLS not working | Wait for DNS propagation. Caddy auto-generates certs |
| CORS errors | Check `FRONTEND_URL` in `.env` |
| Discord OAuth fails | Check `DISCORD_REDIRECT_URI` in `.env` AND Discord Developer Portal |
| GHCR pull denied | Verify GitHub Actions has `packages: write` permission |
| Workers die on Redis restart | `restart: unless-stopped` auto-recovers (P2.6 fix) |
| `caddy_net` not found | `docker network ls` → update `name:` in `docker-compose.prod.yml` |
