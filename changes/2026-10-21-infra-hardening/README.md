# Infrastructure hardening

**Date:** 2026-10-21

## Description

Follow-up to the 2026-10-20 security review: the release pipeline holds `DOCKERHUB_TOKEN` and `INFRA_REPO_TOKEN`
(which can deploy to production), so its actions are now pinned to commit SHAs; nginx sends basic security headers;
ignore files keep secrets and local notes out of git and the image.

## Settings

No toggle, because nothing changes for users (infrastructure only).

## Change

- **Workflows:** every `uses:` in `.github/workflows/*.yml` is pinned to a full commit SHA with a `# vX.Y.Z` comment.
  New `.github/dependabot.yml` keeps actions, npm and the Dockerfile base images up to date (weekly, grouped).
- **infra-deploy:** the eve-infrastructure checkout uses `persist-credentials: false`, so the token is not in
  `.infra/.git/config` while infra's `tools/bump-tripwire.sh` runs. `open-infra-pr.sh` hands git the token through
  `GIT_CONFIG_*` env (masked) only after that, for its fetches and the push. Behaviour is otherwise the same.
- **nginx:** `server_tokens off`; `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` and
  `Referrer-Policy: strict-origin-when-cross-origin` on every response (`always`), from
  `docker/nginx-security-headers.conf`, which is included again in the js/css/json location (it has its own
  `add_header`). PHP's own copies of these headers are hidden so each is sent once. No Content-Security-Policy
  yet: it needs the inline scripts moved out first (follow-up).
- **Ignore files:** `.gitignore` adds `.env.*` (except `.env.example`), `*.pem`, `*.key`, `acme.json`, `/reports/`,
  `/research_notes/`; `docker/Dockerfile.dockerignore` adds `.env*` (except `.env.example`), `backup.sql`, `*.sql.gz`,
  `*.pem`, `*.key`, `.claude`.
- **docker-compose.prod.yml:** the port is published on `127.0.0.1` only (for a TLS proxy on the same host);
  `docker/README.md` says not to run upstream's `docker-compose.yml` in production.

Upstream files touched: `.gitignore` (lines added only).
