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
- `assets` service (Node 20) builds `public/js/app.min.js` / `public/css/app.min.css` on start and
  rebuilds them when files under `app/` change. They are git-ignored build output (upstream commits
  them, we don't): CI and the Docker image build their own with `docker/gulpfile.dev.js`. To build
  them without the stack: `npm ci && npx gulp --gulpfile docker/gulpfile.dev.js --cwd . js css`.
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
kill feed worker (see [Kill Reporting](#kill-reporting)) and the Discord notifications worker (see
[Discord notifications](#discord-notifications)), all under supervisord.
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
`fork_rally` / `fork_rally_discord_message` (chain map rally point, "Fight here", per mask with a copy of its fleet comp, and its live legacy Discord message, created by `public/rally.php`; the `comp*` columns are added to an older `fork_rally` the first time a fight point is set; `fork_rally_discord` of 1.15-1.17 is no longer read), `fork_fight_comps` (the [fleet comps](#fight-here) per mask, created by `public/fight.php`), `fork_preserve_mass` ("preserve mass" flags on chain connections, created by `public/preserve_mass.php`, `preserve_mass.inc.php`; no foreign key to upstream's `wormholes`: flags of deleted wormholes are skipped when read and deleted when the mask's flags change; tests: `php tests/preserve_mass_test.php` against the dev database), `fork_rolling` ("rolling" flags on chain connections: who (character ID and name), when, note; created by `public/rolling.php`, `rolling.inc.php`, built like `fork_preserve_mass`; tests: `php tests/rolling_test.php`), `fork_system_residents` (residents of a system set by hand per mask, created by `public/system_residents.php`, `system_residents.inc.php`; see [System stats](#system-stats-system-threat)), `zkill_kills` /
`zkill_feed_state` (created by `zkill_feed.worker.php`, DDL in `docker/sql/kill-reporting.sql`) and `zkill_killmails` /
`zkill_state` / `zkill_backfill` / `zkill_names` / `zkill_system_stats` / `zkill_system_keep` / `zkill_kill_lookup` (the [zKillboard integration](#zkillboard-integration), DDL in
`docker/sql/zkill.sql`) and `discord_webhooks` / `discord_settings` / `discord_outbox` / `discord_sent` / `discord_rally_message`
([Discord notifications](#discord-notifications), DDL in `docker/sql/discord.sql`; `discord_rally` of 1.15-1.17 is no longer read and can be dropped)
and `fork_watchlist` (the corporation's [watchlist](#watchlist) filters per mask, created by `public/watchlist.php`) /
`fork_watchlist_baseline` / `fork_watchlist_seen` (what the Discord type "Watchlist match" has seen, created by
`discord_notify.worker.php`; DDL in `docker/sql/watchlist.sql`) and `fork_jump_jammed` (cyno-jammed systems marked per
mask for the [Jump planner](#jump-planner), created by `public/jump_jammed.php`, DDL in `jumprange/jammed.inc.php`, reference
copy `docker/sql/jump-jammed.sql`) and `fork_pilot_affiliation` / `fork_pilot_entities` / `fork_intel_lookups` /
`fork_pilot_threat` ([who is in local](#who-is-in-local), created by `public/intel_scans.php` and the zKillboard worker,
DDL in `intel/pilots.inc.php`) and `fork_structures` / `fork_structure_writes` (the [Structures](#structures) panel, created by
`public/structures.php`, DDL in `structures/structures.inc.php`, reference copy `docker/sql/structures.sql`). The app user therefore
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
| `ENABLE_ASSETS_SCOPE` | `false` | `config.php` (`ENABLE_ASSETS_SCOPE`), `public/login.php` | Asks tracking characters (Tracking > Add) for `esi-assets.read_assets.v1`, so [fitted jump mass](#fitted-jump-mass) can read the active ship's fit. EVE SSO refuses a scope your CCP developer application doesn't have (`invalid_scope`, adding characters fails), so: 1. enable `esi-assets.read_assets.v1` on the application at developers.eveonline.com, 2. set `ENABLE_ASSETS_SCOPE=true` and restart, 3. users remove and re-add their tracking characters. Without it jumps are logged with the hull mass only |
| `EVE_DUMP` | `eve_dump` | `config.php` (`EVE_DUMP`) | EVE SDE database name (upstream `tools/` only, not in the image) |
| `DISCORD_WEB_HOOK` | unset | `config.php` (`DISCORD_WEB_HOOK`), `public/ping.php`, `rally_discord.inc.php` | JSON object, e.g. `{"maskID":"https://discord.com/api/webhooks/..."}`. Used by upstream's pings and, for masks that don't have the "Fight here" (rally point) type turned on in Mask Admin > Discord ([Discord notifications](#discord-notifications); that setting wins), by [Fight here](#fight-here) posts (posted directly by `public/rally.php`; same rules as the Mask Admin type with fixed texts that name the fleet comp, and no pings, not even the comp's mention: changes within 30 s of the post edit it, a later move posts a new message and strikes through the old one, a clear strikes through the message and posts nothing; links use the origin of `EVE_SSO_REDIRECT`). Tests: `docker compose -f docker-compose.dev.yml exec -T app php tests/rally_discord_test.php` and, against the dev database, `php tests/rally_discord_lock_test.php` (`tests/` is not in the image) |
| `ZKILL_FEED_ENABLED` | `true` | `config.php` (`ZKILL_FEED_ENABLED`), `zkill_feed.worker.php`, `zkill/` | Follow zKillboard's R2Z2 feed for [Kill Reporting](#kill-reporting) and the [System Kill Feed](#zkillboard-integration). `false` = the worker idles and nothing is requested from zKillboard or ESI (no back-fills, no names) |
| `KILL_REPORT_FRIENDLY_CORPORATIONS` | empty | `config.php` (`KILL_REPORT_FRIENDLY_CORPORATIONS`), `public/kills.php` | Comma-separated corporation IDs whose kills and losses count as friendly for every user (each user's own corporation always does), e.g. `98839494` |
| `ZKILL_RETENTION_HOURS` | `48` | `config.php` (`ZKILL_RETENTION_HOURS`), `zkill/` | Hours (1-168) the [zKillboard integration](#zkillboard-integration) keeps kills in `zkill_killmails`; also the longest window `public/system_kills.php` serves |
| `ZKILL_THREAT_KEEP_DAYS` | `90` | `config.php` (`ZKILL_THREAT_KEEP_DAYS`), `zkill/profile.php` | Days (0-90) the stored kills of systems people look at are kept for the System Threat [90-day profile](#90-day-profile-system-threat) instead of `ZKILL_RETENTION_HOURS`; `0` = off |
| `ZKILL_API_INTERVAL` | `2` | `config.php` (`ZKILL_API_INTERVAL`), `zkill/` | Minimum seconds (1-60) between the worker's zKillboard API requests (back-fills). The R2Z2 feed is paced separately |
| `INTEL_ZKILL_THREAT_ENABLED` | `true` | `config.php` (`INTEL_ZKILL_THREAT_ENABLED`), `intel/pilots.inc.php` | Whether the worker fetches zKillboard character stats for pilots in shared local scans ([who is in local](#who-is-in-local)). `false` = corporations / alliances only (ESI), nothing is asked from zKillboard for local scans. Without `ZKILL_FEED_ENABLED` neither lookup runs |
| `DISCORD_SECRET_KEY` | unset | `discord/` (environment) | Key (any long random string) the webhook URLs of the [Discord notifications](#discord-notifications) are encrypted with at rest. Unset = stored unencrypted. Changing or removing it makes stored webhooks unreadable (marked broken, to be added again) |
| `DISCORD_API_BASE` | `https://discord.com/api` | `discord/` (environment) | Dev only: base URL of a local fake Discord; only `localhost`, `127.0.0.0/8`, `::1` and the dev stack's `discord-mock` are accepted, anything else is ignored |
| `TZ` | `UTC` | `config.php` (PHP default time zone), Alpine `tzdata` | Time zone. Keep `UTC` (recommended): signature times are stored in it, and the [Discord notifications](#discord-notifications) compare them across daylight-saving changes |
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

### Fitted jump mass

Tracked jumps through a mapped hole are logged by upstream's `jumpHistory` trigger with the hull only. The fork adds
the ship's real mass from its fitting (`app/js/fork/auto-mass.js`, `public/jump_fit.php`, table `fork_jump_fits`
created on first use): the tracking character's browser reads its assets from ESI with its own token and reports
the fitted mass of each jump. This needs the `esi-assets.read_assets.v1` scope, which is **off by default**:

1. Enable `esi-assets.read_assets.v1` on your application at developers.eveonline.com (EVE SSO refuses scopes the
   application doesn't have, so adding tracking characters would fail with `invalid_scope`).
2. Set `ENABLE_ASSETS_SCOPE=true` and restart.
3. Users remove and re-add their tracking characters (Tracking > Add) to grant it.

Without the scope, jumps are logged with the hull mass (and the pilot's hot/cold answer). The list of modules that
change mass is static (`app/js/fork/fit-mass-data.js`); regenerate it from public ESI with
`node tools/fork/build-fit-mass-data.mjs > app/js/fork/fit-mass-data.js` when CCP adds plates or prop modules.
Tests: `docker compose -f docker-compose.dev.yml exec -T app php tests/jump_fit_test.php`.

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

### ESI compatibility date and rate limits

ESI versions its routes by date: every ESI request the instance makes carries the compatibility date
`2025-12-16` (`X-Compatibility-Date` header from PHP, `compatibility_date` query parameter from the browser, so
upstream's simple GETs don't need a CORS preflight). Without a date ESI serves its oldest one (2020-01-01); the
responses of every route Tripwire calls are the same at both dates. There is no setting: a new date can change
response shapes, so it is a code change. It lives in `esi/esi.inc.php` (`ESI_COMPATIBILITY_DATE`, also used by
`zkill/`) and `app/js/fork/esi-limits.js` (`esiLimits.COMPATIBILITY_DATE`); a mocha test keeps the two equal.

| Where | What happens on ESI limits |
| --- | --- |
| PHP (`esi.class.php` via `esi/esi.inc.php`: login, registration, crons; `public/cached_third_party.php` for faction warfare) | 429 pauses that rate-limit group (per character for authenticated routes) or route until `Retry-After`; 420 or fewer than 10 errors left pauses all ESI calls until `X-ESI-Error-Limit-Reset`; a group with less than 5% of its tokens left pauses for 60 s. Pauses are shared by all PHP processes through `cache/esi-limits.json`, capped at 15 minutes and logged once as `[tripwire] ESI: ... pausing ...`. A paused call is not sent and fails like a network error (faction warfare keeps serving its stale cache). |
| Browser (`app/js/fork/esi-limits.js`, a jQuery prefilter on `esi.evetech.net` URLs) | A 429 on a character's route stops that character's location/ship/online polling until `Retry-After` (other characters keep polling); a 420 or fewer than 10 errors left stops all polling, the TQ status poll and the chain map's system activity fetch (jumps/kills) until the error window resets. Logged once to the browser console. User actions (set destination, show info, searches) are never held back. |
| `zkill/` (worker) | Its own client, unchanged: see below. |

Tests: `docker compose -f docker-compose.dev.yml exec -T app php esi/tests/esi_test.php` (fake transport, no
network; `esi/tests/` is not in the image) and `app/js-test/fork/esi-limits.test.js`.

### Raidable skyhooks

The Raidable skyhooks box (opened from the skyhook icon on low-sec / null-sec chain systems) reads `public/skyhooks.php`, which serves one server-wide copy of ESI's public
`GET /skyhooks/raidable` (`skyhooks.inc.php`, cache in `cache/skyhooks.json`). Browsers never call ESI for it: the
route's rate-limit group allows only 30 requests per 15 minutes per IP. The server asks ESI at most once per 5
minutes (exclusive `flock`, so concurrent requests don't stampede; after an error not again for 60 s), sends
`X-Compatibility-Date: 2026-10-01` for this one call (the pinned date answers 404), respects the pauses of
`esi/esi.inc.php`, and serves the old list when ESI fails. No env vars. Tests:
`docker compose -f docker-compose.dev.yml exec -T app php tests/skyhooks_test.php` (fake ESI, no network) and
`app/js-test/fork/skyhooks-panel.test.js`.

### zKillboard integration

All zKillboard and ESI access of the fork's features goes through one module, `zkill/` (fork-owned), and only one process
uses it for outgoing requests: `zkill_feed.worker.php`. Web endpoints never call zKillboard or ESI; they read the
tables and at most add rows to bounded queues the worker drains (single-kill lookups, back-fills, names, system stats, local pilots). New features that need kills must read these
tables (`zkill/query.php`, `public/system_kills.php`) and queue work, never add their own zKillboard callers.

| File | Owns |
| --- | --- |
| `zkill/zkill.inc.php` | Entry point (require this), settings (`ZKILL_*`, `USER_AGENT`), log sink, system ID check |
| `zkill/http.php` | The HTTP client: one User-Agent, per-host spacing reserved when a request starts (`zkillboard.com`: `ZKILL_API_INTERVAL`; ESI: 20/s), 429 `Retry-After`, exponential backoff on 420/5xx/network errors, **403 or a 200 that isn't JSON (challenge page) blocks the host for at least 10 minutes and is logged as `BLOCKED by <host>`**, ESI error-limit and `X-Ratelimit-*` headers. ESI uses versionless routes with `X-Compatibility-Date` |
| `zkill/schema.php` | DDL of the tables below (`docker/sql/zkill.sql` is the reference copy) |
| `zkill/killmails.php` | Normalising a killmail (R2Z2 or API shape) into a row, storing, stream coverage and high-water mark, pruning |
| `zkill/backfill.php` | Per-system back-fill queue: request (web), run (worker) |
| `zkill/lookup.php` | Single-kill lookup queue for [Smart notes](#smart-notes) kill cards: request (web), fetch one kill (worker) |
| `zkill/names.php` | ESI name cache: look up / queue (web), resolve in batches via `POST /universe/names` (worker) |
| `zkill/query.php` | Read helpers for endpoints, e.g. `zk_system_kills()` behind `public/system_kills.php` |
| `zkill/profile.php` | 90-day threat profile and the longer retention of watched systems' kills (see [90-day profile](#90-day-profile-system-threat)) |
| `zkill/stats.php`, `zkill/threat.php` | Per-system zKillboard stats cache + queue, and the read side of System Threat behind `public/system_threat.php` (see [System stats](#system-stats-system-threat)) |
| `zkill/system_ids.php` | Generated list of valid solar system IDs (8289 systems as ranges) from `appData.systems` in `public/js/combine.js`. Regenerate after upstream changes that file: `docker compose -f docker-compose.dev.yml exec -T assets node zkill/tools/generate-system-ids.js` |
| `zkill/tests/zkill_test.php` | Tests of the pure parts (no database or network): `docker compose -f docker-compose.dev.yml exec -T app php zkill/tests/zkill_test.php` (`zkill/tests/` and `zkill/tools/` are not in the image); also `lookup_test.php` (lookup queue and worker step on SQLite with a fake zKillboard / ESI) and `zkill_kill_endpoint_test.php` (`public/zkill_kill.php` against the dev database) |

Data flow:

1. **Stream.** The worker follows R2Z2 as described in [Kill Reporting](#kill-reporting). Every killmail (all of
   New Eden, NPC kills included, flagged `npc`) goes into `zkill_killmails` (victim, final blow
   character/corporation/alliance/ship, pilot count, value, flags) and is kept for `ZKILL_RETENTION_HOURS` (by kill
   time). Its auto-increment `id` is the since-cursor for readers. Kills in chain systems still also go into
   `zkill_kills`, Kill Reporting's alert log, exactly as before. Expect roughly 10-30 thousand rows per day of retention.
   `zkill_state` holds the stream's coverage: `stream.coveredSince` (since when it has stored every kill without a
   gap; reset when the worker starts from the current sequence, i.e. first start or more than 20 hours down, or skips
   ahead) and `stream.highWater` (up to when: the R2Z2 upload time of the last processed killmail while catching up,
   or now whenever it is caught up). Readers get `feed.lagSeconds` / `feed.caughtUp` from it.
2. **Back-fill.** When an endpoint asks for a window that the stream doesn't cover yet, `zk_backfill_request()`
   queues the system in `zkill_backfill` (one row per system, deduped) and the response says `pending`. Limits: only
   real solar systems (`zkill/system_ids.php`); queued/running rows overall at most 800 for `source=panel` and 1000
   for `source=chain` (the last 200 are reserved for chain back-fills); per user at most 250 (panel) / 500 (chain).
   Above a limit nothing new is queued and the response says `queueFull`. A failed back-fill or one older than a
   stream restart is retried after 10 minutes. Priority: `source=chain` (20) before `source=panel` (10), then oldest request;
   a later chain request raises a queued panel request. **Only while the stream is caught up** (between R2Z2 polls),
   the worker takes the top job and requests `https://zkillboard.com/api/systemID/<id>/pastSeconds/<window>/` (at
   most one request per `ZKILL_API_INTERVAL` seconds, instance-wide, 10 s timeout). Entries that come back without the
   killmail are fetched from ESI (`/killmails/<id>/<hash>`, 5 in parallel, at most 200 per job and 8 s per job);
   if any entry is left out, the back-fill only counts as covering the kills before the first gap (by killID). Busy systems where
   zKillboard's answer is cut off (about 200 kills) are covered from their oldest returned kill and not asked again.
   A job that throws is marked `failed`; a `running` job older than 5 minutes is queued again. Back-filled kills go
   into `zkill_killmails` only, never into `zkill_kills`, so they never trigger kill sounds.
3. **Names.** Endpoints return IDs plus the names already in `zkill_names` and queue unknown IDs; while the stream is
   caught up the worker resolves queued IDs every 2 seconds (at most 3 ESI requests and 3 seconds per pass). ESI rejects a whole
   batch if one ID is invalid, so `attempts` works as a tier: new IDs go in one batch of up to 500, IDs from a
   rejected batch go in batches of 10, IDs from a rejected small batch one by one, and an ID rejected on its own is
   stored as unresolvable. At most one rejection per pass, then name passes pause for 10 seconds: an invalid ID
   costs about three ESI errors and never blocks the queue. Names are re-resolved after 30 days (unresolvable ones
   after a day).
4. **Pruning.** Every 10 minutes with Kill Reporting's prune: kills older than the retention (kills fetched for a note,
   `source = 'lookup'`, are kept 7 days after they arrived), finished back-fill rows older than the retention, finished
   lookups older than 7 days, stale names.
5. **System stats.** Lowest priority, after back-fills: see [System stats](#system-stats-system-threat).
6. **Single-kill lookups.** Interleaved with back-fills and stats (at most every other API slot while they wait): see [Smart notes](#smart-notes).
7. **Local pilots.** ESI lookups of the pilots in shared local scans every 2 seconds with the name passes, and their
   zKillboard character stats at the lowest priority, after single-kill lookups, back-fills and system stats: see
   [Who is in local](#who-is-in-local). The order of the zKillboard API work is `intel_zkill_api_step()` in
   `intel/pilots.inc.php`.

`public/system_kills.php` (logged-in users, GET only):

| Parameter | Meaning |
| --- | --- |
| `systemID=<id>` and/or `systems=<id,...>` | Solar systems, at most 200 (validated against `zkill/system_ids.php`) |
| `pastSeconds` | Window, 60 up to the retention (default: the retention; longer is clamped) |
| `limit` | Kills returned over all systems, 1-50 (default 20) |
| `since=<cursor>` | Incremental mode like `kills.php`: only kills stored after the cursor (in the window), in stored order (by `id`, not by kill time: back-filled history arrives after newer streamed kills, so clients sort by `killTime` themselves); `cursor` in the answer is where to continue (the last kill of a full page, else the latest id; a cursor beyond the latest resets to it) |
| `source=panel\|chain` | Back-fill priority (default `panel`) |
| `queue=0\|1` | `0` = read only, queue nothing (default `1`); a back-fill that is already queued or running still shows as `pending` (not with `ZKILL_FEED_ENABLED=false`) |

The answer has `kills` (newest first without `since`), `names` (ID => name), `cursor`, `feed` (`enabled`, `live`,
`caughtUp`, `lagSeconds`, `coveredSince`, `highWater`), per-system `systems[]` (`complete`, `coveredFrom`,
`coveredTo`, `pending`, `queueFull`, `backfill`) and overall `complete` / `pending` / `queueFull` / `namesPending`
flags. Poll again while `pending` or `namesPending` is true. Per system, `complete: true` means every kill of the
window is stored; `pending: true` means a back-fill is queued or running; `pending: false` with `complete: false`
means partial history that won't improve for now: a busy system whose zKillboard answer was cut off (covered from
`coveredFrom`), a back-fill that failed recently (retried after 10 minutes), `queueFull`, or the stream lagging
(`feed.caughtUp: false`). With `ZKILL_FEED_ENABLED=false` it returns what is stored and queues nothing. The GET's only side effect is a deduplicated, capped queue row, so a cross-site request
can at most queue real systems up to the caps.

Browser consumers: the System Kill Feed panel (`app/js/fork/system-killfeed.js`, one system, 24 h) and the Chain
Kill Feed panel (`app/js/fork/chain-killfeed.js`): a window request (`systems=<joining ids>&pastSeconds=3600`,
`source=chain` for wormhole systems and the first 10 k-space systems of a join, `source=panel` for the rest) when
systems join the chain, then one shared `since` cursor polled every 20 s (4 s while back-fills or names are pending,
`queue=0`), at most 200 systems per request.

#### System stats (System Threat)

Longer history than the retention comes from zKillboard's per-system stats,
`https://zkillboard.com/api/stats/solarSystemID/<id>/kills/`: kills of the last 7 days (`activepvp`, NPC kills left
out), monthly kill totals, and the 7-day top corporations / alliances (kills as attackers). `zkill/stats.php` keeps a
compact copy per system in `zkill_system_stats`, which is also the queue. `zk_stats_request()` (web) queues systems
whose entry is missing or older than 12 hours (zKillboard caches these numbers for hours itself), a failed fetch is
retried after 15 minutes; caps: 400 queued/running rows overall, 200 per user; the viewed system (priority 20) goes
before chain systems (10). The worker runs `zk_stats_run_one()` **after** `zk_backfill_run_one()` found nothing to do:
only while the stream is caught up, only when no back-fill is queued, and within the same `ZKILL_API_INTERVAL` budget
(10 s timeout, one request per system). Rows nobody asked for in 14 days are pruned. `zkill/threat.php` adds counts
from the stored kills (1 h, 24 h, retention window), corporations / alliances seen in a system's stored kills (final
blows and losses) and its structure losses.

`public/system_threat.php` (logged-in users, GET only): `systems=<id,...>` (chain badges, at most 200),
`systemID=<id>` (the viewed system: adds `detail` with residents and structure losses, queues names and a back-fill of
the retention window like the System Kill Feed), `queue=0|1`. The answer has `systems` (ID => `stats` (the cached
entry or `null`), `fetchedAt`, `statsStatus`, `pending`, `queueFull`, `local` (`kills1h`, `kills24h`, `killsWindow`,
`lastKill`)), `retentionSeconds`, `localSince` (since when the stream has every kill), `feed`, `pending`, and with
`systemID` a `detail` object. Poll again while `pending` is true. Browser consumer: `app/js/fork/system-threat.js`
(badges every 5 minutes and when the chain changes, the viewed system after 1 s; 6 s while pending, paused while the
tab is hidden). Tests: `php zkill/tests/stats_test.php`.

The block shows in the Intel panel as a collapsible "Threat & residents" section (in the system info panel when the
Intel panel is off). **Set residents** stores who lives in a system per mask in `fork_system_residents` (created on
first use by `public/system_residents.php`, `system_residents.inc.php`; reference DDL `docker/sql/system-residents.sql`):
GET `systemID=<id>`; POST (with `X-Requested-With: XMLHttpRequest`) `mode=set` with `entities` (JSON `[{kind, id}]`),
`names` (JSON list of exact names) and `note` (200 characters), or `mode=clear`. Names and tickers never come from the
browser: names are resolved with ESI's public `POST /universe/ids`, then each entity's name and ticker come from the
stored row, `zkill_names` and the system's `zkill_system_stats` top lists, else ESI's public `GET /corporations/{id}` /
`/alliances/{id}` (through `esi/esi.inc.php`, so ESI pauses apply; only on Save). The browser re-reads the residents with
the viewed system's detail polls (every 5 minutes; while its stats are pending, not more than once a minute). Tests: `php tests/system_residents_test.php` (fake ESI; storage
checks against the dev database).

#### 90-day profile (System Threat)

The Threat & residents section also shows a 7 d / 90 d profile of the viewed system: kills, the busiest 4 hours of the
EVE day (a 24-bar kills-by-hour chart), the top 5 groups (alliance, else corporation; only groups with kills on 3 or
more different days) and when it was analysed. It is computed by `zkill/profile.php` from `zkill_killmails`
(`zk_profile_compute()`: SQL aggregates by hour, (group, day) and victim group, never the raw kills in PHP; cached per
system in `zkill_profile_cache` for an hour, ten minutes when nobody watches the system, one request computing per
system at a time via MySQL `GET_LOCK`), so it costs **no zKillboard request**:
the zKillboard call budget is unchanged (same stats and back-fill requests as before, same `ZKILL_API_INTERVAL`).
The retention window is too short for 90 days, so the systems people look at (the viewed system and the systems of the
user's mask chain, looked up on the server from the mask's wormhole signatures, never from the request; at most 500
overall and 200 per user, rows nobody asked for in 14 days are dropped; one batched upsert that cannot fail the request) are listed in
`zkill_system_keep` and the stream keeps their kills for `ZKILL_THREAT_KEEP_DAYS` (default 90) instead of
`ZKILL_RETENTION_HOURS`: `zk_store_killmail()` stores older kills of those systems and `zk_prune()` spares them, keeping
at most 5000 kills beyond the retention window per system (oldest dropped by `zk_keep_housekeeping()`; the panel's
coverage then starts at the oldest kept kill). History
therefore builds up from the day a system is first looked at (the response's `detail.profile.coveredDays` and the
panel's "kills seen for about N days so far" say how much), plus what the retention window and its back-fill already
held. zKillboard's own history API is limited to 7 days, so nothing older can be fetched. Storage: roughly 0.3 KB per
stored kill (a wormhole has a few dozen kills in 90 days; a busy k-space system tens of thousands, so on a small
instance set `ZKILL_THREAT_KEEP_DAYS=30` or `0`). Tests: `php zkill/tests/profile_test.php`,
`app/js-test/fork/system-threat-90d.test.js`.

#### Smart notes

System notes render zKillboard kill links as kill cards (`app/js/fork/smart-notes.js`, render time only: the stored
note HTML is never changed). The card data comes from `public/zkill_kill.php` (logged-in users with a mask, GET only):
`ids=<killID,...>` (at most 20) and/or `names=<id,...>` (at most 20 character / corporation / alliance IDs for chips).
A kill in `zkill_killmails` is answered from there (names from `zkill_names`, unknown names queued, the card's
red / green edge from the session's corporation and alliance, `KILL_REPORT_FRIENDLY_CORPORATIONS` and the active
corporation / alliance mask). Any other kill is queued in `zkill_kill_lookup` (`zkill/lookup.php`) and answered
`queued`; the browser asks again after 3, 10 and 30 seconds, then shows the plain link. Caps: 200 queued / running
lookups per user, 2000 overall (above them: `full`, plain link). With `ZKILL_FEED_ENABLED=false` nothing is queued
(`unavailable`). Name IDs above 32 bits are skipped; asked-for names are queued only while fewer than 200 names are
pending. The worker's `zk_queues_run_one()` interleaves `zk_lookup_run_one()` with back-fills and stats (lookups first,
but never twice in a row while other work waits), within the same `ZKILL_API_INTERVAL` budget and only while both
zKillboard and ESI may be called: `https://zkillboard.com/api/killID/<id>/` for the hash, then ESI `/killmails/<id>/<hash>/`, stored with
`source = 'lookup'` regardless of the retention and kept 7 days after it arrived. A failed lookup is retried after 10
minutes, at most 3 attempts; a `running` lookup older than 5 minutes is queued again. The browser never calls
zKillboard, Dotlan or EveWho; it only links to them and loads images from `images.evetech.net`.

### Discord notifications

Corporation admins can have Tripwire post to their Discord (Mask Admin > Discord). All of it is fork-owned: `discord/`,
`discord_notify.worker.php`, `public/discord.php`, `app/js/fork/discord-notifications.js`, tables `discord_*` (DDL in
`discord/schema.php`, reference copy `docker/sql/discord.sql`). It belongs to a corporation: only its corporation mask
(`<corp>.2`) and custom masks owned by the corporation (`<id>.0`, owner type corporation) have it, and only the
corporation's Tripwire admins (the admin flag, `checkAdmin`) see and change it. Not the Public or Private masks,
alliance masks, or custom masks owned by a character (anyone can create those). If a mask stops qualifying, or its
corporation has no Tripwire admin left, the worker ignores its settings (they stay stored) and its queued messages fail
instead of being sent. A member who loses the admin flag can't change anything any more, but what the corporation set
up keeps running until another admin turns it off. The admin flag is upstream's `characters.admin`: set when a
character registers as admin (ESI Director role or a "Tripwire Admin" title) and reset when the character changes
corporation; losing the Director role within the same corporation is not detected.
Nothing is sent until an admin adds a
webhook, picks it for a notification type and turns the type on; nothing that happened before a type was turned on is
announced (each type stores `enabledAt`, set by the server).

**Webhooks, not a bot.** Each Discord channel webhook (channel settings > Integrations > Webhooks) posts to one
channel, so "which channel" is "which webhook". Webhooks need no bot account, gateway connection or token with
server-wide permissions, can only post to their own channel, and are revoked in Discord by deleting them.

**Types** (per mask; each has on/off, a webhook, a "ping" field and a message template):

| Type | When |
| --- | --- |
| New k-space near a ping system | A wormhole on the mask's chain leads to a k-space system (high/low/null, Pochven counts) that had no other wormhole signature in the mask, fewer than `maxJumps` (default 10) *safe* gate jumps from a ping system (default Jita, Amarr). Safe = every system in between is high-sec (security >= 0.45, not Pochven) and never Zarzakh; both ends may be any security (the Favourites panel's safe-route rule). Each connection is looked at once; at most one message per (mask, system) per `cooldownHours` (default 6) |
| Any kill in our chain | A kill in a wormhole, low-sec or null-sec system connected to the mask's **home system** through live wormholes right now (see "Home system" below; no home set = no chain kills); high-sec systems only with "include high-sec systems" (off by default, so a hole into Jita or Uedama doesn't post every gank) |
| Kills by our corporation | One of "our" corporations/alliances is on the attackers' side (and not the victim) |
| Losses of our corporation | The victim is in one of "our" corporations/alliances |
| Watchlist match | A system on the mask's chain, connected to the mask's **home system** through live wormholes right now (the chain kill rule, see "Home system" below, walked on every poll; no home set = no watchlist messages), matches one of the mask's [watchlist](#watchlist) filters, evaluated by the worker every 15 s (`discord/watchlist.php`), so it is posted even when nobody has Tripwire open. Matches outside that chain (old fragments) are neither posted nor recorded, so a system that gets connected to home later, while it still matches and its hole is still there, is posted then. What is new comes from what the worker has seen, not from edit times: on the first poll after the type is turned on, after a filter is saved or turned on, or after the home system changes, the chain's current matches are recorded without posting anything (`fork_watchlist_baseline`; records made before are kept, so a match posted earlier that is cut off at that moment isn't posted again when it is reconnected); afterwards a (filter, system) match is posted once, when none of its holes (any of the system's connections for filters on the system only, those fitting the hole conditions otherwise) was seen before. A match needs at least one hole of the chain among them (live by the chain's rule, far side in the chain or not known yet; an expired hole or one from a fragment alone doesn't make a match), and the message names the oldest of those. Every hole seen matching is kept in `fork_watchlist_seen` for as long as it exists (no expiry, so an old hole or a gate link is never posted again however long it stays on the chain), and forgotten when it is gone from the chain: a second way into a system already posted isn't posted, the system reached through a new wormhole after all its holes collapsed is. Editing a hole (name, EOL, mass) never posts it; a hole that only starts matching through an edit (e.g. its type is filled in) is new. A paused or deleted filter's records are dropped. Filters with "jumps from you / from home" are skipped (they depend on who is looking). Placeholders `{filter}`, `{system}`, `{class}`, `{effect}`, `{details}` (class and effect), `{region}`, `{sig}` (the hole's signature in the system it is off), `{hole}` (its type there, K162 for the exit side), `{from}`, `{map}`; default ``{pings} Watchlist **{filter}**: **{system}** ({details}, {region}), through {sig} {hole} in {from}`` + `{map}` on a new line, e.g. "@here Watchlist **C5 with a Wolf-Rayet**: **J170540** (C5, Wolf-Rayet, E-R00024), through WRC-555 H296 in J115405". Filter names (admin text) and game data are escaped; at most 20 messages per mask per poll |
| Fight here (rally point; key `rally`) | Someone sets, moves or clears the chain map's fight point ([Fight here](#fight-here), first called the rally point), with or without a fleet comp, or changes its comp (and hasn't unticked "Also post to Discord", `options.rallyDiscord.enabled`). Two texts: set/moved (`{who}`, `{system}`, `{label}`, `{labelSystem}`, `{class}`, `{region}`, `{map}`, `{time}`, `{comp}`, `{compNote}`, `{withComp}`...) and cleared (`{rally}`, `{who}`, `{time}`, `{was}`, and the system placeholders for the system the fight was on). `{comp}` / `{compNote}` are the comp's name and note (admin text, escaped like game data; empty without a comp), `{withComp}` is " — comp: Armor HACs" or empty. `{pings}` is the comp's Discord mention (Mask Admin > Fight here) followed by the type's ping field, each mention once; `allowed_mentions` comes from those two and the admin's text only. Defaults: ``{pings} Fight here: **{labelSystem}** ({class}){withComp} — set by *{who}*`` + `{map}` on a new line, e.g. "<@&role> @here Fight here: **AB · J163701** (C5) — comp: Armor HACs — set by *Chribba*", and ``{rally}`` + ``Cleared by *{who}* at {time}`` on a new line. One live message per mask (`discord_rally_message`: id and text as last posted): a set or move within 30 s of its post edits it (`PATCH .../messages/<id>`), unless the change pings someone the message didn't (e.g. a comp with a role picked seconds after "no comp": edits never notify, so that is handled like a later move); a move after that posts a new message (with the pings) and edits the old one into its text struck through + "Moved to **AB · J170122** (Shield BS) by *who* at <time>", or "Changed to **AB · J170122** (Shield BS)" / "(no comp)" when only the comp changed on the same system (fixed text; `discord_rally_message.systemID` keeps the system the message shows, added to older tables on their first write); a clear, at any time, edits it into the cleared text: `{rally}` is the message struck through line by line, without its pings and its link line (a cleared text without `{rally}` gets it put above). E.g. "~~Fight here: **AABCA · J163701** (C5) — comp: Armor HACs — set by *Kytus Bos*~~" / "Cleared by *Aashai Modor* at 19:08". A clear never posts a new message or pings: when there is no live message (never posted, deleted in Discord, another webhook, the type turned off and on since) nothing is sent. Every edit has empty `allowed_mentions` (Discord doesn't notify on edits anyway); the edits that end a message (cleared, moved) also have no pings in their text (the ping field and mentions the admin wrote are left out; a struck rally text that doesn't fit Discord's 2000 characters is cut, never the cleared line). `{time}` is a Discord timestamp (`<t:unix:t>`), shown in each reader's own time zone. Texts saved with an earlier default (1.15's, 1.17's ``{pings} Tripwire rally point cleared by *{who}*{was}``, or the "Tripwire rally point from ..." set text from before Fight here) are read as today's; edited texts are kept (they still get the comp's mention in `{pings}`). The message shows the rally as stored when it is sent, and a queued rally message is dropped when a newer one of the mask is queued (a set and a clear queued together send nothing). A live message deleted in Discord (404 Unknown Message) is posted again for a set/move, never for a clear, without marking the webhook broken. Masks without the type turned on keep posting to upstream's server-wide `DISCORD_WEB_HOOK` when it has a webhook for them (the page says so) |
| Preserve mass (key `preserveMass`, `discord/preserve_mass.php`) | Someone marks a chain connection "preserve mass" (`public/preserve_mass.php`, `fork_preserve_mass`), changes the mark (another pilot or another reason) or clears it. The change is decided on the server from the flag as stored before and after the request (re-marking with the same pilot and reason is no change), never from the browser, and queued after the response. Every member's change is posted: it is a corporation safety signal, so there is no per-user opt-out like Fight here's; admins turn the type on or off. **Only the chain** (`chainOnly`, on by default): a *new* message is only posted for a connection with an end in the chain connected to the home system (`discord_chain_systems_cached`, as chain kills; no home = nothing new, the page warns); edits of a message already posted always go through. Untick it to post every marked connection of the mask. Two texts: marked/changed (`{connection}` "AB · J163701 ↔ J152820": both ends with their chain labels, the end closer to home first, i.e. home, else the shorter label, an unlabelled end last; `{from}`, `{to}`, `{hole}` the type seen from `{from}` (K162 when scanned on the far side), `{class}` of `{to}`, `{details}` "K162, C5", `{sig}`, `{mass}`, `{life}`, `{who}`, `{reason}`, `{withReason}` ": home static" or empty, `{map}` link to `{from}`) and cleared (`{mark}` the message struck through, `{who}`, `{time}`). Defaults ``{pings} Preserve mass on **{connection}** ({details}) by *{who}*{withReason}`` + `{map}` on a new line, e.g. "@here Preserve mass on **AB · J163701 ↔ J152820** (K162, C5) by *Chribba*: home static", and ``{mark}`` + ``Cleared by *{who}* at {time}``. One live message per (mask, wormhole) (`discord_preserve_message`), handled like Fight here's: a change within 30 s of the post edits it (unless it pings someone new); a later change posts a new message (with the pings) and edits the old one into its text struck through + "Changed by *who* at <time>"; a clear edits it into the cleared text (no new message, no ping; nothing when there is no message); marked again within 30 s of that clear, the struck message is edited back instead of posting a new one. **Hole gone:** when a marked hole leaves the map (collapsed, expired or deleted, i.e. its `wormholes` row is gone) while its message is live, the worker's 10-minute prune pass queues one clear for it (`discord_preserve_clear_gone`; claimed once per hole in `discord_sent`, kind `pmGone`), so the message is struck through with "Cleared by *Tripwire (the hole is gone from the map)* at <time>" (the cleared text with that `{who}`), nobody pinged. **Debounce:** each change is queued due 10 s later and is dropped when a newer change of the same hole is queued, and the message shows the flag and hole as stored when it is sent, so marking and clearing a hole quickly posts nothing. Every edit has empty `allowed_mentions`; pilot names, reasons and labels are escaped like game data. A message deleted in Discord is posted again for a mark, never for a clear. A flag that can't be read when a mark is sent (a database error) makes the row wait and retry, as Fight here rows now do too, instead of failing it. Messages are forgotten a day after they were struck or 7 days after they were posted (holes don't live longer) |
| Rolling (key `rolling`, `discord/rolling.php`) | Someone marks a chain connection "rolling" (right-click a system > Rolling…, or the mass dialog; `public/rolling.php`, `fork_rolling`), changes the mark (another pilot or another note) or clears it (Stop rolling). Pick the hole-roll channel for it. Built and sent exactly like Preserve mass (same server-side change detection, 10 s debounce, one live message per (mask, wormhole) in `discord_rolling_message`, edits within 30 s, a later change posts anew and strikes the old one with "Changed by *who* at HH:MM EVE", a clear strikes it, re-marked within 30 s brings it back, edits never ping, **only the chain** `chainOnly` on by default, every member's change is posted, no per-user opt-out), with short texts: mark ``{pings} Rolling **{name}** in **{system}** — {time} EVE``, e.g. "@here Rolling **AB** in **J163701** — 19:08 EVE", and done ``{mark}`` + ``{outcome} at {time} EVE``. `{name}` is the hole's name: the chain label of the system it leads to (`discord/chain_label.php`), else its signature ID in `{system}`; `{system}` the system it is in (the end closer to home, without its class), `{to}` the other end, `{class}` of `{to}`, `{sig}`, `{connection}` (as Preserve mass), `{who}`, `{note}`, `{withNote}` ": closing it" or empty, `{map}`, `{mark}`. `{time}` is EVE time (UTC, "HH:MM", what rollers talk in; not a Discord timestamp): when rolling started in the mark (re-marking moves it), when it was cleared / found gone in the done text. `{outcome}` is "Done", or "Hole collapsed" when the hole is gone from the map: the worker's 10-minute prune pass queues one clear per live message whose hole is gone (`discord_rolling_clear_gone`, claimed in `discord_sent` kind `rollGone`), `{who}` "Tripwire (the hole is gone from the map)", so "~~Rolling **AB** in **J163701** — 19:08 EVE~~" / "Hole collapsed at 19:40 EVE". The done text never pings |

"Our" corporations/alliances (any IDs the admin enters) default to the mask's corporation. Kill types can skip NPC kills (default), pods and kills under an ISK value.
When one kill matches several types that post to the same webhook, only the most specific is sent (loss > kill > chain).

**Home system** (per mask, Mask Admin > Discord, stored as `homeSystemID` in the mask's settings; any known system,
validated against the static data). "The chain" for chain kills is every system connected to home through the mask's
live wormholes, walked outward from home (`discord_chain_systems` in `discord/chain.php`, through k-space exits too,
like the chain map). A wormhole is live while its `wormholes` row and both signatures exist in the mask and neither
signature is past its `lifeLeft` (signatures with `lifeLength` 0 never expire; EOL holes count until they expire; a
hole that collapsed early counts until it is deleted from the map). Signatures with an unknown far side are never
walked through, and neither are EVE-Scout's Thera/Turnur connections the chain map draws (they aren't in the mask's
tables): a kill behind a Thera hole that only EVE-Scout knows doesn't count until the hole is added to the mask. The
chain is reloaded with the kill settings every `DISCORD_KILL_REFRESH` (60 s). Without a home set, chain kills post
nothing and the page warns; corp kills/losses don't use it. Before 2026-10-10 any system with one of the mask's
wormhole signatures counted, so fragments of an old chain (holes collapsed or rolled but not deleted; upstream's
`wormholeClean` only deletes them at `lifeLeft` + 10 % of their life) kept posting
(`changes/2026-10-10-chain-kills-connected/`).
"Watchlist match" uses the same chain since 2026-10-11 (`changes/2026-10-11-watchlist-home-chain/`): the worker walks
it on each 15 s poll (`discord_chain_systems`, one query for all masks with the type on and filters), no home set
means no watchlist messages (the page's warning names both types), and the home system is part of each filter's
baseline stamp (`fork_watchlist_baseline.stamp` = `enabledAt:updatedAt:homeSystemID`), so setting or moving home
records the new chain's current matches without posting them. The in-app watchlist (pop-up, sound, marks) is not
limited: it matches what each member's chain map draws.

**Chain kills paused notice** (`discord/chain_notice.php`, no setting). While chain kills are on and the mask has no
home system, `discord_notify.worker.php` posts one message to the chain kill channel (checked every 15 s with the
k-space poll): "Chain kills are paused: no home system is set for the **Corp** mask. An admin can set it in Tripwire >
Mask Admin > Discord." Once per episode and channel: the episode is a `discord_sent` row (kind `nohome`, ref
`wh:<webhookID>`) that is also the notice's dedupe, so later passes post nothing; it is kept by the 7-day prune for as
long as the episode lasts. The episode ends (row deleted) when the mask gets a home, chain kills are turned off or
moved to another channel, the webhook's URL is replaced (it may be another channel: the next pass posts a new notice
there), or the mask or its webhook can no longer send; if chain kills still go to that channel, now with a home, and
the notice did not fail (sent, still queued, or its outbox row already pruned: sent rows go after 7 days; a failed
notice gets no "resumed", unless the episode outlasts the 14 days failed rows are kept), one "Chain kills resumed for the **Corp** mask (home: J160650)." follows. Removing the home again starts a
new episode. Same rule as the chain: only "no home" pauses chain kills (a home without live holes is a chain of one
system, and an unknown home ID is dropped when the settings load). Both messages are fixed text with empty
`allowed_mentions` (no pings, whatever the type's ping field says) and the mask name escaped. Mask Admin > Discord adds
to its "Set a home system" warning when the notice was posted ("A notice was posted to the chain kills channel on
2026-10-11 00:59 EVE time.", or "Chain kills paused since ..." once the notice's outbox row is pruned; `homeNotice` in
`discord.php`'s answer). Test: `discord/tests/chain_notice_flow_test.php`
(against the dev stack's MySQL, worker and `discord-mock`).

**Detection.** K-space: `discord_notify.worker.php` polls `wormholes`/`signatures` of masks with the type on every 15 s
for signatures changed since its last look (high-water mark on `signatures.modifiedTime`, compared in MySQL, paged by
change time and wormhole ID; it starts at the newest existing change and keeps moving with it while no mask has the type
on, and changes older than the type's `enabledAt` are skipped, so nothing old is announced; no upstream file is
hooked). `signatures.modifiedTime` is written in the app's local time (`TZ`), so **`TZ=UTC` (the default) is
recommended**: with a zone that has daylight saving time, the hour when clocks go back can be skipped or seen twice. Gate distances are a BFS
in PHP over `discord/gate_graph.php`, generated from the browser's own `appData` (`systems`, `regions`, `map.shortest`)
in `public/js/combine.js`; regenerate after upstream changes that file:
`docker compose -f docker-compose.dev.yml exec -T assets node discord/tools/generate-gate-graph.js`.
Kills: `zkill_feed.worker.php` hands every killmail it streams from R2Z2 to `discord_on_killmail()` (never back-filled
ones, and only kills less than 15 minutes old, so catching up after downtime posts nothing old); that only queues
messages and never calls Discord, so the stream is never held up. No new zKillboard or ESI callers: names come from the
[zKillboard integration](#zkillboard-integration)'s name cache (a kill message waits up to 90 s for names, then uses
fallbacks). Dedupe: `discord_sent` per (mask, type, killID / connection / system), written in the same transaction as
the outbox row (both or neither; its primary key also stops two processes queueing the same message).

**Delivery.** Messages go into the `discord_outbox` table; `discord_notify.worker.php` (supervisord program
`discord-notify`, runs as `www-data`) is the only process that calls Discord. A separate process keeps Discord's
latency and outages away from the kill stream and keeps k-space messages working with `ZKILL_FEED_ENABLED=false`.
With several app containers on one database, MySQL named locks (`GET_LOCK`, `<database>.discord-dispatch` and
`<database>.discord-kspace`) make one worker the sender and one the k-space poller; the others log "standby" and take
over when the holder's connection goes away. Every second the sender handles up to 20 due messages (5 s budget, 10 s
timeout per request, 50 ms between requests):

- `X-RateLimit-Remaining: 0` pauses that webhook for `X-RateLimit-Reset-After`; a 429 pauses the webhook (or every
  request when `global` / `X-RateLimit-Global`, or when the 429 isn't JSON, i.e. Cloudflare) for `retry_after`, and
  the message is retried without counting an attempt;
- 5xx and network errors: retried after 5 s, doubling up to 15 min, given up after 10 attempts;
- 401/403/404 (deleted webhook, bad token): the webhook is marked **broken** (shown in Mask Admin with Discord's
  message), its queued messages fail and nothing more is sent to it until an admin replaces the URL; other 4xx fail
  that message only. A new or replaced URL is "not verified" (`pending`) until Discord accepts a message for it;
- circuit breakers on refused requests (any 4xx, 429 included) within 10 minutes: 50 for one webhook pause that
  webhook, 150 for one mask pause that mask, 400 for one corporation (all its masks together) pause that corporation,
  2000 overall pause **all** sending (last resort; Cloudflare bans an IP
  from Discord's API at 10,000 per 10 minutes), each until its oldest refusal leaves the window. Logged as
  `CIRCUIT BREAKER (<scope>)`; a paused mask or webhook is shown on that mask's settings page, a paused corporation on the page of each of its Discord-enabled masks. Per mask, at most 5 test
  messages per minute and 10 webhook URLs added or replaced per hour (recorded first, then counted, so concurrent
  requests can't slip past the limit);
- queued messages older than 6 h expire; sent rows are deleted after 7 days, failed ones after 14, dedupe rows after
  7 days; at most 500 queued messages per mask (more are dropped and logged).

**Messages.** Text from the admin's template with placeholders (`{system}`, `{security}`, `{jumps}`, `{hub}`,
`{hubs}`, `{sig}`, `{mapper}`, `{mask}`, `{victim}`, `{ship}`, `{corp}`, `{attackers}`, `{isk}`, `{zkill}`, `{pings}`
and more, listed in the UI) plus an embed (kills: victim, final blow, attackers, value, ship render and portrait from
`images.evetech.net`, zKillboard link; k-space: security, region, hole, mapper, jumps table, Tripwire and Dotlan links;
wormhole systems show their class instead of a security value).
`{label}` (k-space, rally point and the three kill types) is the system's chain label, the name the chain map shows for it: the name of the
wormhole signature leading into the system, on the far side of the hole (`discord_chain_label` in `discord/chain_label.php`:
a wormhole of the mask whose far-side signature has a name starting with a letter or digit and whose near-side signature is unnamed or a return
bookmark `!...` (or the older `<...`); reached more than once, the shortest leading name token wins, then the lowest wormhole id; empty for
home or a system without a named hole). `{labelSystem}` is "AABCA · J152820", or only "J152820" without a label.
The legacy `DISCORD_WEB_HOOK` rally posts show the label the same way. Labels are signature names (user text), escaped
like game data.
Kill messages name the system with its label on the mask when it has one: the default texts use `{labelSystem}`
("... lost a Coercer Navy Issue in AABCA · J105246, 44.07m ISK"), and the embed title and system line show it too
("Kill in the chain: Coercer Navy Issue in AABCA · J105246", "AABCA · J105246 (C5), E-R00028"); without a label they
are as before. The label is escaped in the embed title too (titles render markdown such as bold, spoilers and
emoji). The labels of every mask with a kill type on are loaded with the kill settings every 60 s
(`discord_chain_labels`, one query), so the kill feed never waits on a query per kill, and are stored with the queued
message (a label up to a minute old). Kill texts saved with the earlier default (`{system}`) are read as today's.
`allowed_mentions` is built only from what the admin wrote (template + ping field: `<@&role>`, `<@user>`,
`@here`/`@everyone`), and game data (pilot, corp, ship, mapper names) has Discord markdown escaped and `@` defused, so
a kill can never ping anyone by itself.

**Settings endpoint** `public/discord.php`: every request checks that the session's mask belongs to the user's
corporation (its corp mask, or a custom mask with owner type corporation and owner = the user's corporation) and that
the user is a Tripwire admin of it (`checkAdmin`; mask ownership alone, `checkOwner`, is not enough), else 403. The
menu entry only appears in that case too. Changes are JSON POSTs that need the per-session `X-CSRF-Token` (from
`mode=get`), `X-Requested-With: XMLHttpRequest` and, when the browser sends `Origin`, this host. Webhook URLs are
validated (`https://discord.com/api/webhooks/<id>/<token>`, `discordapp.com`, `canary.`/`ptb.`, optional `/vN` and
`?thread_id=`), refused when the mask already has that webhook, and never returned: the UI shows a name,
`…/<last 4 digits of the webhook ID>` and the status; they can only be replaced or deleted. "Send test" queues a test message the worker sends within seconds.

**Secrets at rest.** With `DISCORD_SECRET_KEY` set, webhook URLs are stored encrypted (libsodium secretbox, key =
BLAKE2b of the setting); without it they are stored in plain text (the UI says so) and encrypted by the worker as soon
as a key is configured. Changing or removing the key makes stored URLs unreadable: those webhooks are marked broken and
admins have to paste the URL again. Keep the key in your secrets store, like `EVE_SSO_SECRET`.

**Outbound hosts:** `discord.com` (from the worker: POST, and PATCH to edit or strike through rally point, preserve mass and rolling messages; the legacy
`DISCORD_WEB_HOOK` rally posts come from `public/rally.php` as before). Embeds reference `images.evetech.net`,
`zkillboard.com` and `evemaps.dotlan.net`; Discord fetches those, not Tripwire.

**Dev stack:** `docker-compose.dev.yml` runs a fake Discord (`discord-mock`, `docker/dev/discord-mock.php`) and
points `DISCORD_API_BASE` at it (only `localhost`, `127.0.0.0/8`, `::1` and `discord-mock` are accepted; production
doesn't set it). Webhook IDs ending in
`0404`/`0401` answer 404/401, `0429`/`0430` answer every other request with a per-webhook/global 429, `0500` fails
twice; `PATCH .../messages/<id>` edits (rally point), `GET /delete/<id>` makes later edits of that message answer 404
Unknown Message; `http://127.0.0.1:9095/messages` lists what was received and `/channel` shows the channel as a reader sees it (each message as last edited). Any 18-digit ID and 68-character token works, e.g.
`https://discord.com/api/webhooks/111111111111111111/<68 characters>`. Fake a kill through the same path as the worker:
`docker compose -f docker-compose.dev.yml exec -T app php docker/dev/discord-fake-kill.php <systemID> <loss|kill|neutral>`.
Tests: `docker compose -f docker-compose.dev.yml exec -T app php discord/tests/discord_test.php` and, against the
running dev stack (worker + mock), `php discord/tests/chain_notice_flow_test.php` (`discord/tests/` and
`discord/tools/` are not in the image).

Upstream's own manual "ping" button (`DISCORD_WEB_HOOK`, `public/ping.php`) is unchanged and separate. Rally point
tests: also `php tests/rally_discord_test.php` (routing between the Mask Admin setting and `DISCORD_WEB_HOOK`, legacy texts) and, against the running dev stack (worker + mock), `php tests/rally_discord_flow_test.php` (every set / move / clear sequence on both paths, printing the channel).
Preserve mass: `php discord/tests/preserve_mass_test.php` (settings, change detection, texts, escaping, mentions, the
sender's plan, debounce, chain scope; SQLite) and, against the running dev stack (dev login, worker, mock),
`php tests/preserve_mass_discord_flow_test.php` (marks and clears through `public/preserve_mass.php` over HTTP, printing the
channel; takes a few minutes because of the 10 s debounce).
Rolling: `php discord/tests/rolling_test.php` (settings, texts, EVE time, done / hole gone, escaping, the plan, debounce; SQLite)
and, against the running dev stack, `php tests/rolling_discord_flow_test.php` (marks and clears through `public/rolling.php`, the hole-gone
strike; a few minutes).

### Fight here

The chain map's rally point, renamed "Fight here" and given fleet comps. Right-click a system > **Fight here ▸**:
"Fight here (no comp)" (the old rally), one entry per fleet comp of the mask (coloured dot + name), and "Clear fight"
while a fight point is set. A mask without comps keeps the old one-click entry ("Fight here", or "Clear fight" on the
fight's system). Everyone on the mask sees the system in the comp's colour (no comp: the old green), the
route to it, and a banner in the chain map header: "Fight here: AB · J163701 (C5, 2 jumps) · Armor HACs · set by
Chribba · 4 min ago ✕" (the chain label as the Discord message shows it, `discord_chain_label`; the comp's note in
its tooltip; ✕ clears it). Members can hide the banner (Settings > Map Markers > Fight here,
`options.fightBanner.enabled`, on by default); the system stays marked.

- **Comps** (Mask Admin > Fight here, `public/fight.php`, `fight/fight.inc.php`): the corporation's Tripwire admins
  (same masks and checks as Mask Admin > Discord: the corp mask and corporation-owned custom masks, `checkAdmin`) add,
  edit, reorder and remove up to 20 comps per mask: a name (required, up to 40 characters, unique per mask), a colour
  from a fixed palette (green, red, orange, yellow, blue, purple, pink, cyan, white), an optional note (up to 140) and an
  optional Discord mention (`<@&roleID>`, `<@userID>`, `@here`, `@everyone`, validated like the type's ping field).
  Stored as JSON in `fork_fight_comps` (one row per mask). Every member reads the list (in `public/rally.php`'s answer,
  without the mentions); changes need the admin, a per-session `X-CSRF-Token`, `X-Requested-With`, JSON and a
  same-origin `Origin` (as `public/discord.php`).
- **The fight point** is still `fork_rally` (`public/rally.php`, internal names unchanged: no data migration). Setting it
  takes an optional `compID`; the server looks the comp up and stores a copy (`compID`, `compName`, `compColour`,
  `compNote`, `compMention`), so a comp removed or renamed later keeps showing as it was until the fight is cleared or
  moved. Choosing another comp on the same system counts as a change (Discord: an edit within 30 s, else a new message).
- **Discord**: the "Fight here" type of Mask Admin > Discord (see the table above): the comp's name in the text, its
  mention pinged with the type's ping. The legacy `DISCORD_WEB_HOOK` path names the comp, never pings.

Tests: `docker compose -f docker-compose.dev.yml exec -T app php fight/tests/fight_test.php` (validation, storage,
removed comps, payloads, template upgrade, legacy texts; SQLite) and, against the running dev stack (login from
`docker/dev-seed.sh`, worker, mock), `php tests/fight_endpoint_test.php` (admin / non-admin / CSRF / Origin checks,
comps and the fight point over HTTP, and set with a comp → move within 30 s → clear through the worker to the mock,
printing the payloads). `fight/tests/` is not in the image. Mocha: `app/js-test/fork/fight-comps.test.js`.

### Mask admins

Mask Admin > Admins & members (`public/mask_admins.php`, `maskadmin/maskadmin.inc.php`,
`app/js/fork/mask-admin-tab.js`, `app/js/fork/mask-defaults.js`). Tables are created on first use
(`docker/sql/mask-admins.sql` is the reference): `fork_mask_admins`, `fork_mask_blocks`, `fork_mask_defaults`,
`fork_mask_audit`.

- **Several admins.** On a custom mask the owner and the owning corporation's Tripwire admins can make any member a
  mask admin (and revoke it). `checkAdmin()` in `lib.inc.php` accepts granted admins, so Mask Admin and the Discord,
  Watchlist and Fight here tabs honour them. Granted admins can block, unblock, remove members and set the defaults;
  they can't grant/revoke, edit the access list or delete the mask, and Discord / Fight here / Watchlist stay for the
  corporation's Tripwire admins. A grant counts only while the character still has access to the mask. The owner and
  corporation admins can't be revoked, blocked or removed. Blocks are per character.
- **Remove / block.** *Remove* deletes a character's own entry from the access list (not possible for access through
  a corporation or alliance). *Block* (with a reason) makes the mask unusable for that character whatever grants
  access: `docker/db.inc.php`, loaded by every endpoint, drops a blocked character's session to their corp mask
  before anything reads `$_SESSION['mask']`, and the mask disappears from their mask list. Unblocking doesn't put
  them back on the mask; they pick it again. Alliance members are listed once they have used the mask (Tripwire
  stores no alliance per character).
- **Mask default settings.** An admin ticks fork settings (rows registered with a `key`) and saves their own current
  values as the mask's defaults. For a key the member has no value for, the default is used (own choice, then mask
  default, then built-in); Settings shows a "mask default" badge on those rows. Saving other settings never turns a
  default into a personal choice. A member who picks exactly the default value is not told apart from one who never
  chose. Not allowed as defaults: layout, tracking, favourites, background, scale, masks and upstream's built-in
  groups (`chain`, `signatures`, `buttons`).
- **Security.** The mask is always the session's mask (no request value names one). Writes need the per-session
  `X-CSRF-Token`, `X-Requested-With`, JSON and a same-origin `Origin`, like `fight.php`. Every change is in the audit list.
- Test: `docker compose -f docker-compose.dev.yml exec -T app php tests/mask_admins_test.php`.

### D-scan and local scans

Pilots paste a d-scan or local member list into the Intel dialog (system info panel, or chain map right-click
"Paste d-scan / local"); `public/intel_scans.php` validates and normalises it with `intel/intel.inc.php` (at most
200 kB and 2000 lines; d-scan rows with or without the leading type ID, character names for local) and stores the
normalised rows, not the pasted text, in `fork_intel_scans` (created on first use). Same session/mask checks and
`X-Requested-With` rule as `rally.php`; at most 20 scans per user per minute; rows are deleted after 24 hours and
only the newest 30 per mask and system are kept. Requests may pass `have=<ids>`: the rows of those (immutable)
scans are left out, so polls carry only metadata. The browser builds the summary from the rows and
`public/intel/types.json`, static type data regenerated from ESI's public universe endpoints with
`node intel/tools/generate-types.js` after a game update (no runtime ESI calls). No configuration.
Tests: `docker compose -f docker-compose.dev.yml exec -T app php intel/tests/intel_test.php` and, against the dev
database, `php intel/tests/intel_endpoint_test.php`.

#### Who is in local

A shared local scan stores names only; `intel/pilots.inc.php` turns them into corporations, alliances and a compact
zKillboard threat summary. Like the [zKillboard integration](#zkillboard-integration), web requests only read cache
tables and queue work; **only `zkill_feed.worker.php` calls ESI and zKillboard**, through `zkill/http.php` (same
User-Agent, per-host spacing, ESI error/rate limits, 403 blocks), and only while `ZKILL_FEED_ENABLED` is on and the
stream is caught up. With the feed off nothing is queued and the panel shows the names as "not looked up".

| Table | Holds |
| --- | --- |
| `fork_pilot_affiliation` | One row per character name (ASCII, case-insensitive): `characterID` (`NULL` = not resolved yet, `0` = no such character), `resolvedAt` (when name → ID was last checked), `corporationID`, `allianceID`, fetched time. Also the ESI queue (`status` queued / done / failed, `requestedBy`, `requestedAt`, `wantedAt`) |
| `fork_pilot_entities` | Corporation / alliance name and ticker (also a queue); refreshed after a week |
| `fork_intel_lookups` | One job per shared local scan with the sharer's friendly corporation / alliance IDs (session plus a corp/alliance mask's owner) |
| `fork_pilot_threat` | Compact zKillboard character stats per character (`danger`, `gang`, `kills`, `losses`, `solo`, `kills7d`, `lastMonth`, top 3 ship types), fresh for 24 hours, deleted after 48; also that queue |

1. **Share.** `POST mode=add` of a local scan queues its names (at most 2000 per scan) and creates a lookup job. Only
   names in EVE's character-name charset (ASCII letters, digits, space, `'` `.` `-` `_`, 3-37 characters) are looked up;
   anything else (full-width or accented letters) can't be a character and shows as unknown without a lookup. Caps:
   20,000 queued names overall, and 6,000 names per user per hour whatever became of them (so names that resolve
   within seconds count too, and one user can't keep the queue full for everyone else); above them nothing more is
   queued and the answer says `queueFull`.
2. **ESI** (every 2 seconds with the name passes, at most 8 requests and 3 seconds per pass, 5 s timeout, so the R2Z2
   poll is never held up for long; the name passes of `zkill/names.php` have the same 3-second budget):
   `POST /universe/ids` (500 names per call), `POST /characters/affiliation` (1000 IDs per call), then
   `GET /corporations/<id>` and `GET /alliances/<id>` for names and tickers (NPC corporations, 1000000-1999999, are
   not looked up). A rejected batch is retried in smaller batches, then one by one (like the name cache), one
   rejection per pass; names still queued after an hour are given up. When a scan is viewed, affiliations older than
   an hour are refreshed (ESI caches them that long) and name → ID mappings older than a day are checked again
   (renamed characters become unknown under their old name); the old data stays on show meanwhile. Names ESI
   doesn't know are deleted after an hour and looked up again if someone pastes them again.
3. **Threat selection** (no HTTP): once a scan's names are resolved (or after 15 minutes), the worker queues
   zKillboard stats for at most **20 new pilots per scan**: never friendly ones (friendly corporation or friendly
   alliance; the panel uses the same rule), pilots in player corporations before those in NPC corporations, paste
   order otherwise; pilots with fresh (24 h) or queued stats don't count. Caps: 300 queued overall, 100 per user.
4. **zKillboard** (lowest priority): `https://zkillboard.com/api/stats/characterID/<id>/kills/` (without `kills/`
   zKillboard redirects there), one request per pilot, only when no back-fill or system stats are queued and within
   `ZKILL_API_INTERVAL` (10 s timeout); a failure is retried after an hour at the earliest.
   `INTEL_ZKILL_THREAT_ENABLED=false` turns this step off. Answers (zKillboard's `view/apistats.php`): a stats object
   is compacted; `{"error":"Invalid type or id"}` (zKillboard has no record of the character, common in local) and an
   empty body, `null`, `[]` or `{}` are stored as "no kills" and never block zKillboard; another `error` is a failed
   lookup; only a 200 that isn't JSON (challenge page) blocks the host, like everywhere else.
5. Rows nobody asked for in 7 days are pruned (hourly).

`public/intel_scans.php` accepts `pilots=<scanID>` with `systemID` (a local scan of the mask in that system) and then
returns `pilots`: `pilots` (per name in paste order `[characterID, corporationID, allianceID, threat]`, threat being
the compact stats, `"q"` queued, `"f"` failed or `null` not looked up), `entities` (`id => [name, ticker]`),
`friendly`, `lookups`, `threat`, `pending` (names still being looked up), `threatPending` (the job hasn't picked yet)
and `queueFull`. The Intel panel (`app/js/fork/intel-pilots.js`) polls every 5 seconds while something is pending
(for at most 5 minutes after opening a scan), then with the normal 30-second poll.

**Outbound hosts:** `esi.evetech.net` and `zkillboard.com`, from the worker only. Settings per user: Settings > Kills
& Intel > D-scan & local intel (groups, threat; display only). Tests (fake ESI / zKillboard transport, dev
database): `docker compose -f docker-compose.dev.yml exec -T app php intel/tests/pilots_test.php`; mocha
`app/js-test/fork/intel-pilots.test.js`.

### Structures

A small **Structures** panel (own layout widget, Settings > Kills & Intel > Structures panel) lists the Upwell structures,
POS towers and deployables recorded for the viewed system, with owner, state and one timer each, and a residents strip
(one chip per owner: ours / hostile / unresolved, plus corporations System Threat saw in kills here). Structures come
from the d-scan dialog (a "Save structures to ..." section, with "Save structures only" for no 24 h scan) or are added
by hand. Data is per mask and system, not per chain: it stays when the system leaves the chain.
`public/structures.php` (`list` / `scan` / `add` / `update` / `gone`, same session / mask / `X-Requested-With`
rules as `intel_scans.php`; at most 20 writes per user per minute, 200 live rows per mask and system) uses
`structures/structures.inc.php` and creates `fork_structures` / `fork_structure_writes` on first use (DDL in that file,
reference copy `docker/sql/structures.sql`). Owners are looked up only in the cache of the pilot lookups
(`fork_pilot_entities`); this feature never calls ESI or zKillboard. Destroyed / removed rows are kept 30 days (Undo);
deployables not seen for 7 days and old gone rows are pruned on `list`; Upwell and POS rows are never removed
automatically. No configuration. Tests: `docker compose -f docker-compose.dev.yml exec -T app php
structures/tests/structures_test.php` and `php structures/tests/structures_endpoint_test.php` (dev database; the
browser parse and merge share `structures/tests/fixtures.json`), mocha `app/js-test/fork/structures.test.js`.

### Watchlist

Named filters per mask ("C5 with a Wolf-Rayet", "J123450", "anything on an H296") that tell everyone on the mask when
the chain map has what they are looking for. They belong to the same masks and admins as the
[Discord notifications](#discord-notifications): the corporation mask and corporation-owned custom masks; the
corporation's Tripwire admins (`checkAdmin`) create, edit, pause and delete them in Mask Admin > Watchlist (or the
panel), every member of the mask reads them. Fork-owned: `watchlist/` (storage, validation and the server-side matcher),
`public/watchlist.php`, `app/js/fork/watchlist.js`, table `fork_watchlist` (one row per mask with the filters as JSON;
DDL in `watchlist/watchlist.inc.php`, reference copy `docker/sql/watchlist.sql`).

- `public/watchlist.php`: `GET ?mode=get` returns the session mask's filters (`available` false and no filters for
  masks the watchlist isn't for), `canEdit`, and for admins a per-session CSRF token. Admins `POST` JSON
  (`filter-save`, `filter-delete`, `filter-enable`) with the `X-CSRF-Token` header, `X-Requested-With: XMLHttpRequest`,
  `Content-Type: application/json` and, when the browser sends `Origin`, this host; everyone else gets 403. The server
  normalises the conditions with the browser's rules, checks the system, region, constellation and wormhole types
  against the game data, and stamps `updatedAt` / `updatedBy` itself. At most 50 filters per mask.
- The browser matches the filters against its chain map on every draw: pop-up, sound and marks (node, the hole that
  makes the match or leads to the system, with an eye next to its size tag, and the hole's signature in the
  signature table). Each member turns these on or off in Settings > Kills & Intel > Watchlist.
- The Discord type "Watchlist match" matches the same filters in `discord_notify.worker.php`, only in the chain
  connected to the mask's home system (Mask Admin > Discord; see "Home system" under
  [Discord notifications](#discord-notifications)); the in-app pop-up, sound and marks cover everything on the
  member's chain map. Both matchers pass the
  same cases, `watchlist/tests/cases.json` (mocha: `app/js-test/fork/watchlist.test.js`; PHP:
  `docker compose -f docker-compose.dev.yml exec -T app php watchlist/tests/watchlist_test.php`).
- Game data (systems, wormhole types, regions) is read from `public/js/combine.js`, the file the browser matches with
  (`appData` is plain JSON after `var appData =`), once per worker process and per admin save (about 35 ms); there is
  no copy to regenerate after a game-data update. `watchlist/tests/` is not in the image.

### Jump planner

A range-ring icon on the chain's low-sec / null-sec exits opens the Jump planner panel (`app/js/fork/jump-planner.js`):
which systems a jump ship reaches from that exit, by distance band, on a top-down mini-map and a list, plus trade-hub
reach. The range maths is a separate pure engine, `app/js/fork/jump-range.js` (tests: `app/js-test/fork/jump-range.test.js`).
No runtime calls to third parties and no configuration.

- Static data in `public/jumprange/`: `systems.json` (positions of every gate-reachable k-space system plus Pochven and
  Zarzakh, 0.001 LY, delta-encoded, about 86 kB) and `ships.json` (every published hull with a jump drive and its base
  range, dogma attribute 867). Both are generated from CCP's Static Data Export (JSON Lines zip from
  https://developers.eveonline.com/static-data) with `node jumprange/tools/generate-coords.js <unzipped-sde-dir> --zip <the zip>`
  (records the zip name and SHA-256 in `meta`); re-run
  it after a game update, commit both files and set `jumpPlanner.DATA_VERSION` to the new `meta.version` (a test checks).
- Cyno-jammed systems are marked by hand per mask (ESI has no public cyno jammer feed): `public/jump_jammed.php`
  (`GET` lists, `POST mode=set|clear&systemID=`), same session/mask checks and `X-Requested-With` rule as `rally.php`,
  only systems in `systems.json`, at most 500 per mask. Tests, against the dev database:
  `docker compose -f docker-compose.dev.yml exec -T app php jumprange/tests/jammed_endpoint_test.php`
  (`jumprange/tests/` and `jumprange/tools/` are not in the image).

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
files, CI, example configs, `app/` sources, node tooling, upstream's `tools/`, `zkill/tests/`, `zkill/tools/`, `discord/tests/`, `discord/tools/`, `esi/tests/`, `intel/tests/`, `intel/tools/`, `watchlist/tests/`, `jumprange/tests/`, `jumprange/tools/`, `fight/tests/`) from the build context
before copying it in; if upstream adds new non-runtime files, add them to that list.

If upstream adds a setting to `config.example.php`, add it to `docker/config.php` (and the compose
files) too.

## Publishing

Every PR runs `.github/workflows/ci.yml`: JS unit tests (mocha), a check that the
`app.min.js` / `app.min.css` bundles build, PHP syntax, What's New JSON, actionlint, shellcheck
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
`bump/tripwire-X.Y.Z-run<id>-<attempt>` branch is used instead). Other open `bump/tripwire-*` PRs are closed as
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
infra's bump script, and never prints it. `docker-publish.yml` calls the workflow with
`secrets: inherit`: a called workflow sees an environment secret only if its caller passes secrets,
otherwise it silently gets an empty string (that is why v1.9.0 skipped the infra job).

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
