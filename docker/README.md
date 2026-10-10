# Tripwire on Docker (fork notes)

This repo is a fork of [daimian/tripwire](https://bitbucket.org/daimian/tripwire) (`production` branch)
that adds a single self-contained Docker image, published as
[`petdog/tripwire`](https://hub.docker.com/r/petdog/tripwire), plus a local dev stack.

Everything fork-specific lives in new files so upstream syncs stay conflict-free:

| Path | Purpose |
| --- | --- |
| `docker/` | Image Dockerfile, env-driven `config.php` / `db.inc.php`, nginx, php-fpm, supervisord, cron, entrypoint |
| `docker-compose.dev.yml` | Local development stack |
| `docker-compose.prod.yml` | Example production stack using the published image |
| `.env.example` | Settings template for both compose files |
| `.github/` | Release + Docker Hub publish and weekly upstream sync workflows, `upstream-base`, version and sync scripts |
| `AGENTS.md`, `changes/` | Working rules and the change log |

Avoid editing upstream files unless you mean to diverge; every edit is a potential sync conflict.

## Local development

```bash
cp .env.example .env    # optional: only needed for EVE SSO login or non-default passwords
docker compose -f docker-compose.dev.yml up --build
```

- App: http://localhost:8080 (PHP edits are live, the repo is bind-mounted)
- Adminer: http://localhost:9000 (server `mysql`, user `tripwire` / `MYSQL_PASSWORD`, or `root`)
- MySQL: `localhost:3306`
- All ports are bound to `127.0.0.1` only.
- `assets` service (Node 20) rebuilds `public/js/app.min.js` / `public/css/app.min.css` when files
  under `app/` change. Upstream commits those bundles, so commit them along with your `app/` changes,
  and `git checkout --` them if the watcher touched them without a real change.
- Quick login without EVE SSO: `docker compose -f docker-compose.dev.yml exec app bash /opt/app/docker/dev-seed.sh`
  creates user `dev` / `dev-password` (override with `DEV_USERNAME`, `DEV_PASSWORD`; `DEV_CHARACTER` picks
  the public EVE character the account borrows). Log in on the "Tripwire" tab of the login page. There is
  no ESI token, so location tracking doesn't run; simulate a jump from the browser console with
  `tripwire.EVE({characterID: 1, characterName: 'Test', systemID: <from>})` followed by the same call with
  the destination `systemID`.
- Real login: create an EVE SSO app with callback `http://localhost:8080/index.php?mode=sso`
  and put its client ID/secret in `.env`.
- PHP errors go to `docker compose -f docker-compose.dev.yml logs app`, not the page (upstream code
  emits PHP 8 deprecation notices that would break JSON responses).
- Reset the database: `docker compose -f docker-compose.dev.yml down -v`

`docker/config.php` and `docker/db.inc.php` are mounted over `/opt/app/config.php` and
`/opt/app/db.inc.php`, so Docker leaves empty `config.php` / `db.inc.php` files in the repo root as
mount points. They are gitignored; leave them (Docker recreates them) unless you run Tripwire
outside Docker, in which case replace them with real config files.

## The image

One container runs nginx, php-fpm (listening on `127.0.0.1:9000` only) and busybox crond.
Cron runs `/etc/crontabs/www-data` as `www-data` (`system_activity` hourly, `account_update` every
3 minutes); jobs inherit the container environment and their output goes to the container log,
as do nginx access/error logs.

On start the entrypoint waits up to `DB_WAIT_SECONDS` for MySQL, then:

- database has no tables: imports `.docker/mysql/tripwire.sql`;
- `accounts`, `signatures` and `wormholes` exist: does nothing;
- anything else: logs an error and exits. It never imports over existing data (the dump contains
  `DROP TABLE`). Empty the database or set `DB_AUTO_INIT=false` to continue.

The import runs as the app user; no root credentials are needed. That user needs all privileges on
its database (the `MYSQL_USER` the mysql image creates has them) to create triggers and events.

MySQL must run with `event_scheduler=ON`, `sql_mode=NO_ENGINE_SUBSTITUTION` and
`log_bin_trust_function_creators=1` (needed for a non-SUPER user to create triggers while binary
logging is on; see `docker-compose.prod.yml`).

The app serves plain HTTP on port 80; put it behind a TLS proxy. nginx passes `HTTPS=on` to PHP when
the request carries `X-Forwarded-Proto: https`, so don't expose port 80 directly to clients you don't
trust. As upstream, the PHP session cookie is not marked `Secure` (upstream `php.ini` default), while
the "remember me" cookie is, so over plain HTTP (dev) logins aren't remembered across sessions.

### Environment variables

| Variable | Default | Notes |
| --- | --- | --- |
| `DB_HOST` / `DB_PORT` / `DB_NAME` | `mysql` / `3306` / `tripwire_database` | |
| `DB_USER` / `DB_PASSWORD` | `tripwire` / empty | App connection, also used for the schema import |
| `DB_INIT_USER` / `DB_INIT_PASSWORD` | the app user | Optional separate account for the schema import |
| `DB_AUTO_INIT` | `true` | Set `false` to skip waiting for / importing the schema |
| `DB_WAIT_SECONDS` | `60` | How long to wait for MySQL on start |
| `TRIPWIRE_DOMAIN` | `localhost` | Public host (and port, if not 80/443) |
| `TRIPWIRE_HTTPS` | `true` | Used to build the default SSO redirect |
| `TRUSTED_PROXIES` | empty | Comma/space separated proxy CIDRs; when set, the client IP is taken from `X-Forwarded-For` (nginx realip) |
| `EVE_SSO_CLIENT` / `EVE_SSO_SECRET` | empty | From developers.eveonline.com |
| `EVE_SSO_REDIRECT` | `https://$TRIPWIRE_DOMAIN/index.php?mode=sso` | |
| `ADMIN_EMAIL` / `USER_AGENT` | | ESI user agent |
| `CDN_DOMAIN`, `APP_NAME`, `TRIPWIRE_API`, `ENABLE_SEARCH_SCOPE`, `EVE_DUMP`, `TZ` | as `config.example.php` | |
| `DISCORD_WEB_HOOK` | unset | JSON object, e.g. `{"maskID":"https://discord.com/api/webhooks/..."}` |

Empty values fall back to the default; unparseable booleans do too. The compose files pass each
variable explicitly (no `env_file`), so `MYSQL_ROOT_PASSWORD` never reaches the app container.

If upstream adds a setting to `config.example.php`, add it to `docker/config.php` (and the compose
files) too.

## Publishing

Every merge to `main` is a release: `.github/workflows/docker-publish.yml` computes the next
[SemVer](https://semver.org) version, pushes the image to Docker Hub, tags the commit `vX.Y.Z` and creates
a GitHub Release with notes generated from the merged PRs. The first release is `v1.0.0`.

### Which part of the version goes up

Decided per merged PR by `.github/scripts/next-version.sh` (tests: `.github/scripts/test-next-version.sh`):

1. A `semver:*` label on the PR wins: `semver:major`, `semver:minor`, `semver:patch`, or `semver:skip`
   (no release). With several, `skip` beats everything, otherwise the biggest bump.
2. Otherwise, a PR that changes `public/whats-new/features.json` (a new user-facing feature) is **minor**.
3. Otherwise, a PR that only touches docs (`docs/`, `changes/`, `.claude/`, `*.md` incl. `AGENTS.md`)
   is **skipped**: no tag, no image.
4. Anything else, including pushes to `main` without a PR, is a **patch**.

If several merges land before a run gets to them (runs on `main` are queued one at a time), the next
run covers every commit since the last tag and applies the biggest bump among them. Each PR's
**Version** job summary shows what merging it would release; add or change a label to adjust it.
A run on a commit that is already tagged reuses that version (safe to re-run).

### Image tags

| Event | Tags pushed to `petdog/tripwire` |
| --- | --- |
| Release (merge to `main` or manual run) | `X.Y.Z`, `X.Y`, `X`, `latest`, `upstream-<Tripwire version from settings.php>` (e.g. `upstream-1.30b`), `sha-<commit>` |
| Docs-only merge / `semver:skip` | nothing (the image is still built as a check) |
| Pull request | nothing (built, not pushed) |

The fork version is baked into the image as `TRIPWIRE_FORK_VERSION` and `public/version.json`
(`{"version":"1.2.0","upstream":"1.30b"}`); the What's New dialog and its Settings row show it. Local
builds without `--build-arg TRIPWIRE_FORK_VERSION=...` and the dev stack show `dev`.
The build fails if the version can't be read from `settings.php`.

### Manual release

Actions > Docker image > Run workflow on `main`, pick `patch`, `minor` or `major`. Runs on other
branches fail.

### One-time setup

Repository secrets: `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN` (a Docker Hub access token with Read &
Write scope). The labels:

```bash
gh label create semver:major --repo apettey/tripwire --color B60205 --description "Release a new major version (breaking change)"
gh label create semver:minor --repo apettey/tripwire --color 0E8A16 --description "Release a new minor version (new feature)"
gh label create semver:patch --repo apettey/tripwire --color 1D76DB --description "Release a new patch version (fix)"
gh label create semver:skip  --repo apettey/tripwire --color CCCCCC --description "Don't release this change"
```

Releases are tagged by `github-actions[bot]`; tag protection rules (if any) must allow it.

## Pulling upstream changes

This repo was started from a snapshot of upstream and does **not** share its git history.
`.github/upstream-base` records the upstream commit our code matches.
`.github/scripts/sync-upstream.sh` applies everything upstream changed since then as a 3-way merge
and bumps that file.

`.github/workflows/upstream-sync.yml` runs it weekly (or on demand from the Actions tab) and opens a
PR from the `upstream-sync` branch. Any merge style is fine. If upstream's changes conflict with ours,
the job fails and you sync locally:

```bash
git checkout main && git pull
git checkout -b upstream-sync-manual
.github/scripts/sync-upstream.sh      # exit 2 = conflicts: fix markers, git add
git commit -m "Sync upstream Tripwire"
```

One-time setup: Settings > Actions > General > Workflow permissions > enable
**Allow GitHub Actions to create and approve pull requests**, or the PR step fails.
PRs opened by that workflow don't trigger other workflows, so the Docker build check runs after
merge. To check it first, close and reopen the PR.
