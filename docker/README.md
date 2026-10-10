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

One container runs nginx, php-fpm (listening on `127.0.0.1:9000` only), busybox crond and the
kill feed worker (see [Kill Reporting](#kill-reporting)), all under supervisord.
Cron runs `/etc/crontabs/www-data` as `www-data` (`system_activity` hourly, `account_update` every
3 minutes); jobs inherit the container environment and their output goes to the container log,
as do nginx access/error logs.

On start the entrypoint (unless `DB_AUTO_INIT=false`) waits up to `DB_WAIT_SECONDS` for MySQL
(over TLS unless `DB_SSL=false`), then:

- database has no tables: imports `.docker/mysql/tripwire.sql`;
- `accounts`, `signatures` and `wormholes` exist: does nothing;
- anything else: logs an error and exits. It never imports over existing data (the dump contains
  `DROP TABLE`). Empty the database or set `DB_AUTO_INIT=false` to continue.

Fork features that need their own tables create them on first use with `CREATE TABLE IF NOT EXISTS`
(so existing databases need no migration and `.docker/mysql/tripwire.sql` stays upstream's): currently
`fork_rally` (chain map rally point per mask, created by `public/rally.php`) and `zkill_kills` /
`zkill_feed_state` (created by `zkill_feed.worker.php`, DDL in `docker/sql/kill-reporting.sql`). The app user therefore
needs `CREATE` privileges on its database, which it already has.

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

Every setting the image reads. "Read by" says where: `config.php` / `db.inc.php` are
`docker/config.php` / `docker/db.inc.php` (copied over `/opt/app/`), the entrypoint is
`docker/entrypoint.sh` (runs once on container start).

| Variable | Default | Read by | Controls |
| --- | --- | --- | --- |
| `DB_HOST` | `mysql` | `db.inc.php`, entrypoint | MySQL host for the app and the schema import |
| `DB_PORT` | `3306` | `db.inc.php`, entrypoint | MySQL port |
| `DB_NAME` | `tripwire_database` | `db.inc.php`, entrypoint | Database name; the entrypoint creates it if missing |
| `DB_USER` / `DB_PASSWORD` | `tripwire` / empty | `db.inc.php`, entrypoint | App connection (PDO, `charset=utf8mb4`); also the schema import account unless `DB_INIT_*` is set |
| `DB_INIT_USER` / `DB_INIT_PASSWORD` | `DB_USER` / `DB_PASSWORD` | entrypoint | Separate account for the wait/create/import step |
| `DB_AUTO_INIT` | `true` | entrypoint | `false` skips waiting for MySQL and the schema import entirely |
| `DB_WAIT_SECONDS` | `60` | entrypoint | How long to wait for MySQL on start before exiting |
| `DB_SSL` | `true` | entrypoint | TLS for the schema-import client: `true` = `--ssl --skip-ssl-verify-server-cert` (MySQL 8 default), `false` = `--skip-ssl` for servers without TLS. Does not affect the PHP connection |
| `TRIPWIRE_DOMAIN` | `localhost` | `config.php` | Public host (and port, if not 80/443); default for `CDN_DOMAIN` and `EVE_SSO_REDIRECT` |
| `TRIPWIRE_HTTPS` | `true` | `config.php` | Scheme (`https`/`http`) of the default `EVE_SSO_REDIRECT`; nothing else |
| `TRUSTED_PROXIES` | empty | entrypoint (nginx) | Comma/space separated proxy CIDRs written to nginx `set_real_ip_from`; when set, the client IP is taken from `X-Forwarded-For`. Invalid values stop the container |
| `EVE_SSO_CLIENT` / `EVE_SSO_SECRET` | empty | `config.php` (`EVE_SSO_CLIENT` / `EVE_SSO_SECRET`) | EVE SSO app from developers.eveonline.com |
| `EVE_SSO_REDIRECT` | `https://$TRIPWIRE_DOMAIN/index.php?mode=sso` | `config.php` (`EVE_SSO_REDIRECT`) | SSO callback URL |
| `ADMIN_EMAIL` | `admin@example.com` | `config.php` | Only used to build the default `USER_AGENT` |
| `USER_AGENT` | `Tripwire Server - $ADMIN_EMAIL` | `config.php` (`USER_AGENT`) | User agent for ESI requests |
| `CDN_DOMAIN` | `$TRIPWIRE_DOMAIN` | `config.php` (`CDN_DOMAIN`) | Host serving images/css/js |
| `APP_NAME` | `Tripwire` | `config.php` (`APP_NAME`) | Name shown in the UI |
| `TRIPWIRE_API` | `true` | `config.php` (`TRIPWIRE_API`) | Enables the `/api` endpoints |
| `ENABLE_SEARCH_SCOPE` | `true` | `config.php` (`ENABLE_SEARCH_SCOPE`) | Requests the ESI search scope at login |
| `EVE_DUMP` | `eve_dump` | `config.php` (`EVE_DUMP`) | EVE SDE database name (upstream `tools/` only, not in the image) |
| `DISCORD_WEB_HOOK` | unset | `config.php` (`DISCORD_WEB_HOOK`) | JSON object, e.g. `{"maskID":"https://discord.com/api/webhooks/..."}` |
| `ZKILL_FEED_ENABLED` | `true` | `config.php` (`ZKILL_FEED_ENABLED`), `zkill_feed.worker.php` | Follow zKillboard's R2Z2 feed for [Kill Reporting](#kill-reporting). `false` = the worker idles and nothing is requested from zKillboard |
| `KILL_REPORT_FRIENDLY_CORPORATIONS` | empty | `config.php` (`KILL_REPORT_FRIENDLY_CORPORATIONS`), `public/kills.php` | Comma-separated corporation IDs whose kills and losses count as friendly for every user (each user's own corporation always does), e.g. `98839494` |
| `TZ` | `UTC` | `config.php` (PHP default time zone), Alpine `tzdata` | Time zone |
| `GA_MEASUREMENT_ID` | unset | `analytics.inc.php` | Your own Google Analytics 4 ID (`G-...`): loads gtag.js and sends a `page_view` on load and every 4 minutes in the app. Unset = no analytics, no request to Google |
| `DONATION_PANEL_HTML_FILE` | unset | `donation_panel.inc` | Path (inside the container) to an HTML file shown in the footer of the app and landing page, e.g. your own donation panel. Output as-is, so only point it at a file you control. Unset = nothing shown |
| `TRIPWIRE_FORK_VERSION` | build arg (`dev` for local builds) | `settings.php` (`VERSION`), `public/version.json` (generated at build time) | Fork release version, the app's version everywhere (see [Versions](#versions)); set by CI, don't override at runtime. Anything but letters, digits and `.+_-` becomes `dev` |
| `TRIPWIRE_UPSTREAM_SETTINGS` | `/opt/app/settings.upstream.php` | `settings.php` (`UPSTREAM_VERSION`) | Upstream's `settings.php`, read for upstream's version; only the dev stack sets it |

Empty values fall back to the default; unparseable booleans in `config.php` do too (`DB_AUTO_INIT`
must be exactly `true` to run, `DB_SSL` must be `true`/`false`). The compose files pass each variable
explicitly (no `env_file`), so `MYSQL_ROOT_PASSWORD` never reaches the app container. Compose-only
variables: `MYSQL_ROOT_PASSWORD` / `MYSQL_USER` / `MYSQL_PASSWORD` (mysql container, mapped to
`DB_USER` / `DB_PASSWORD`), `TRIPWIRE_IMAGE`, `HTTP_PORT` (prod) and `DEV_*_PORT` (dev).

### No upstream analytics or donation panel

Upstream ships `analytics.inc.php` (its own Google Analytics property) and `donation_panel.inc` (a
PayPal donate form with a tracking pixel), both included by `tripwire.php` and `landing.php`. The image
replaces them with `docker/analytics.inc.php` and `docker/donation_panel.inc` (the dev stack mounts
them over the repo copies), which send nothing to third parties unless `GA_MEASUREMENT_ID` /
`DONATION_PANEL_HTML_FILE` are set. `docker/analytics.inc.php` always defines a no-op `ga()` because
`tripwire.php` calls it every 4 minutes.

### Kill Reporting

`zkill_feed.worker.php` (supervisord program `zkill-feed`, runs as `www-data`) follows zKillboard's
[R2Z2 feed](https://zkillboard.com/api/docs/) once for the whole instance: it requests
`https://r2z2.zkillboard.com/ephemeral/<sequence>.json` one killmail at a time (at most ~4 requests/s
while catching up, one every 6 s once caught up, exponential backoff up to 2 minutes on errors), with
`USER_AGENT` (or `Tripwire kill feed (+https://github.com/apettey/tripwire)` when unset) as User-Agent.
It keeps non-NPC kills in J-space and in any system that has a signature in Tripwire, stores them in
`zkill_kills` for 24 hours, and saves its position in `zkill_feed_state` so a restart resumes where it
stopped (after more than 20 hours down it starts from the current sequence). It logs every stored kill
and a heartbeat every 5 minutes to the container log.

Browsers never contact zKillboard: the client polls `public/kills.php` (logged-in users only), which
returns the stored kills for the systems on the user's chain map and marks friendly victims/attackers
(the user's corporation plus `KILL_REPORT_FRIENDLY_CORPORATIONS`). Set `ZKILL_FEED_ENABLED=false` to turn
the feed off for the instance; the endpoint then simply returns no kills.

### Versions

The fork's release version (`X.Y.Z`, `TRIPWIRE_FORK_VERSION`) is the app's version.
`docker/settings.php` replaces upstream's `settings.php` (copied over it in the image, mounted over it in
the dev stack): `VERSION` is the fork version (`dev` when unset), and `UPSTREAM_VERSION` is upstream's
`define('VERSION', ...)`, read from upstream's file (kept as `/opt/app/settings.upstream.php`). The
build fails if upstream's `settings.php` ever defines anything besides `VERSION`; extend
`docker/settings.php` then. The version shows up in:

- the top-left of the app (its tooltip adds the upstream version from `version.json`) and the landing
  page panel;
- the "Tripwire update available ... Reload" prompt, which open tabs show after each release (the page's
  version no longer matches the server's);
- `?v=` on the css/js that `tripwire.php` loads (`app.min.css`, `jquery-ui-custom.css`, `combine.js`,
  `app.min.js`): the URLs change with every release, and nginx serves js/css requested with a release
  `?v=X.Y.Z` as `Cache-Control: public, max-age=31536000, immutable`. Everything else (`?v=dev`,
  unversioned files such as the landing page's, `whats-new/features.json`, `version.json`) stays
  `no-cache`. So a CDN that rewrites `no-cache` into a max-age (Cloudflare's Browser Cache TTL) can't
  serve stale bundles after an upgrade (#14);
- `public/version.json` (`{"version":"1.2.0","upstream":"1.30b"}`), shown in What's New and its Settings row;
- the image's `org.opencontainers.image.version` label and its `X.Y.Z` / `X.Y` / `X` tags
  (plus `upstream-<upstream version>`).

The dev stack (and local builds without `--build-arg TRIPWIRE_FORK_VERSION=...`) shows `dev`. The dev
stack has no `version.json` (the repo is mounted over it), so its tooltip shows no upstream version.

### What is in `/opt/app`

Only what the running app needs: the PHP sources, `api/`, `public/` (with the bundles built in the
`assets` stage), `vendor/`, `cache/`, `settings.php` (`docker/settings.php`), `settings.upstream.php`
and `.docker/mysql/tripwire.sql` (imported by the entrypoint). The `src` stage of `docker/Dockerfile` deletes repo and dev files (docs, change log, compose
files, CI, example configs, `app/` sources, node tooling, upstream's `tools/`) from the build context
before copying it in; if upstream adds new non-runtime files, add them to that list.

If upstream adds a setting to `config.example.php`, add it to `docker/config.php` (and the compose
files) too.

## Publishing

Every PR runs `.github/workflows/ci.yml`: JS unit tests (mocha), a check that the committed
`app.min.js` / `app.min.css` bundles are up to date, PHP syntax, What's New JSON, actionlint, shellcheck
and the version-calculation tests. PRs do not build the Docker image; it is built and pushed only from
`main`, after the checks above.

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
| Pull request | nothing (not built) |

Images are `linux/amd64` only. arm64 was dropped because building it under QEMU made releases very
slow and nobody runs it yet; it can be added back with native arm64 runners (`ubuntu-24.04-arm`,
one build per platform merged into a manifest list). `org.opencontainers.image.version` is set to
`X.Y.Z`.

The fork version is baked into the image as `TRIPWIRE_FORK_VERSION` and `public/version.json`
(`{"version":"1.2.0","upstream":"1.30b"}`) and is the app's version everywhere (see [Versions](#versions)).
Local builds without `--build-arg TRIPWIRE_FORK_VERSION=...` and the dev stack show `dev`.
The build fails if the upstream version can't be read from `settings.php`.

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

### Deploying to eve-infrastructure

Production runs from the private repo `apettey/eve-infrastructure`, which pins the image by digest
in `stacks/tripwire/compose.yaml`; every merge to its `main` deploys. After each release,
`docker-publish.yml` calls `.github/workflows/infra-deploy.yml`, which:

1. resolves the digest of `petdog/tripwire:X.Y.Z` (`docker buildx imagetools inspect`);
2. runs infra's `tools/bump-tripwire.sh` (image pin + version lines in its docs) on branch
   `bump/tripwire-X.Y.Z` and opens the PR **"tripwire: petdog/tripwire X.Y.Z"**, listing the fork PRs
   since the version infra runs now;
3. enables **squash auto-merge**, so it merges and deploys once infra's 5 required checks pass.
   If a check fails, the PR just stays open.

**`deploy:manual` label**: put it on a fork PR whose release needs more than a new image in infra (new
env vars or secrets, compose changes, manual SQL, new outbound hosts). The infra PR is still opened,
but without auto-merge, and its body lists what to check; push the infra changes to that branch and
merge it yourself. The label applies to every infra PR that includes that fork PR. It is the
durable way to hold a release: switching auto-merge off on an infra PR only lasts until the workflow
runs again (a re-run enables it again). It is not retroactive: labelling a fork PR after its infra PR
was opened changes nothing until the next run, so disable auto-merge on that infra PR by hand too.

Re-runs are safe: the PR for that version is updated, not duplicated; `bump/tripwire-X.Y.Z` is reused
only if it already has this pin on top of infra's current `main`, otherwise it is replaced (infra keeps
merged branches, so old ones exist), and a branch with human commits is never overwritten (a new
`bump/tripwire-X.Y.Z-run<id>` branch is used instead). Other open `bump/tripwire-*` PRs are closed as
superseded only when all their commits were made by the workflow (a `Generated-by: tripwire
infra-deploy` trailer); ones with human commits stay open and are linked in the new PR. Nothing happens
when infra already runs that version. Hand-made bumps in infra use another prefix
(`manual/tripwire-X.Y.Z`) so they never collide.

**Deploy an existing release by hand** (first rollout, re-deploy, rollback): Actions > *Deploy release
to infra* > Run workflow on `main`, with `version` (empty = latest tag). `dry_run` only reports the
image change, the fork PRs and the auto-merge decision; `auto_merge` off opens the PR for you to merge.
Older versions than infra runs need `allow_downgrade` and are never auto-merged. Or revert the infra PR.

If an infra PR sits waiting for an approval (eve-infrastructure's ruleset asks for an extra approval
for unattributed changes), approve or merge it by hand; auto-merge stays armed. Commits are made as the
token's owner to keep them attributed.

**Failures:** without the token the job is skipped with a warning. An expired or revoked token, or any
other error, makes the `infra` job fail; the tag, image and GitHub Release are already done by then and
are not affected. Fix it and re-run the job (or use *Deploy release to infra*).

**Public logs:** this repo and its Actions logs are public. The job prints only the image change, PR
numbers and fork PR titles; infra diffs and file contents go into the private infra PR only.

**Token and blast radius:** `INFRA_REPO_TOKEN` can push branches and merge PRs in eve-infrastructure,
and every merge there deploys to production, so it is effectively a production credential. Anyone who
can run a workflow with it can deploy. That is why it lives in the `infra-deploy` environment, which
only `main` may use (a repo-level secret would be readable by workflows on any branch). Both workflows
also refuse refs other than `main`. The job passes the token only to `actions/checkout` and `gh`, not to
infra's bump script, and never prints it.

One-time setup (owner):

1. Create a fine-grained personal access token (GitHub > Settings > Developer settings > Fine-grained
   tokens): resource owner `apettey`, **Only select repositories: `apettey/eve-infrastructure`**,
   permissions **Contents: Read and write** and **Pull requests: Read and write** (Metadata: read is
   added automatically), expiry e.g. 1 year (calendar the renewal). Done 2026-10-10.
   Alternative: a GitHub App installed only on eve-infrastructure with the same two permissions, with
   its token minted by `actions/create-github-app-token` in `infra-deploy.yml`.
2. In this repo: Settings > Environments > New environment **`infra-deploy`** > Deployment branches and
   tags: **Selected branches**, add `main` only. Add **`INFRA_REPO_TOKEN`** there as an environment
   secret, then **delete the repository-level `INFRA_REPO_TOKEN`** (Settings > Secrets and variables >
   Actions). Until the environment secret exists, releases skip the infra job with a warning.
3. In eve-infrastructure: Settings > General > Pull Requests > tick **Allow auto-merge** (done
   2026-10-10). Its branch protection (PR + 5 required checks) is what gates the merge.
4. The label exists (created 2026-10-10); to recreate it:
   `gh label create deploy:manual --repo apettey/tripwire --color FBCA04 --description "Release needs infra changes: open the infra PR without auto-merge"`

It must not be `GITHUB_TOKEN`: PRs and merges made with it start no workflows, so infra's checks and
deploy would never run. PRs and auto-merges appear as made by the token's owner.

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
