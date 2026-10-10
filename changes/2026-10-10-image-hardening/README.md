# Docker image hardening

**Date:** 2026-10-10

## Description

Fixes #9 (findings from moving a production deploy to `petdog/tripwire`): the image no longer reports
to upstream's Google Analytics or loads upstream's PayPal panel, ships only runtime files, is built for
arm64 too, and the database connection and entrypoint are more portable.

## Settings

No toggle: operator-facing image and deployment changes, nothing in the Tripwire UI changes for users
(except that upstream's donation panel in the footer is gone and the version shown is the fork's).

## Change

- **#9.1 Analytics / tracking:** `docker/analytics.inc.php` and `docker/donation_panel.inc` replace
  upstream's `analytics.inc.php` (property `UA-48258312-1`) and `donation_panel.inc` (PayPal form and
  tracking pixel) in the image, and are bind-mounted over them in the dev stack. By default they send
  nothing to third parties; `ga()` stays defined as a no-op for `tripwire.php`. Opt in with
  `GA_MEASUREMENT_ID` (your own GA4 property via gtag.js, which loads `googletagmanager.com` and
  reports page views to Google) and `DONATION_PANEL_HTML_FILE` (your own footer HTML).
  The unlinked upstream `public/donate.html` (PayPal redirect) is no longer in the image either.
- **#9.2 Image contents:** a new `src` build stage deletes repo/dev files (docs, `changes/`, agent
  files, compose files, CI, `docker/`, example configs, `bitbucket-pipelines.yml`, `crontab-tw.txt`,
  `scripts/`, `app/` sources, node tooling, upstream's `tools/`, `.docker/` except
  `mysql/tripwire.sql`) before they reach `/opt/app` (13.9 MB to 11.1 MB).
- **#9.3 Version label:** `org.opencontainers.image.version` is now set explicitly to the release
  version (it already was `1.0.0` for `v1.0.0`, but only because it was the first tag).
- **#9.4 arm64:** releases are built for `linux/amd64` and `linux/arm64` (QEMU in CI). The `assets`
  and `src` stages run on the build platform.
- **#9.5 utf8mb4:** `docker/db.inc.php` connects with `charset=utf8mb4` (all tables in
  `.docker/mysql/tripwire.sql` are already `utf8mb4`), so 4-byte characters such as emoji survive.
- **#9.6 Entrypoint / docs:** `DB_SSL=false` makes the schema import connect without TLS (default
  `true`, as before). `docker/README.md` has a complete environment variable table;
  `.env.example` and `docker-compose.prod.yml` list the new optional variables.
- **Fork version everywhere:** `docker/settings.php` replaces upstream's `settings.php` (image: copied
  over it, upstream's kept as `settings.upstream.php`; dev stack: mounted over it, upstream's mounted at
  `/opt/tripwire-upstream/settings.php` via `TRIPWIRE_UPSTREAM_SETTINGS`). `VERSION` is now the fork
  release version (`TRIPWIRE_FORK_VERSION`, `dev` in the dev stack) and `UPSTREAM_VERSION` upstream's,
  so the top-left of the app, the landing page, the "update available" reload prompt and `?v=` cache
  busting follow fork releases instead of staying on upstream's `1.30b`. The top-left version gets a
  tooltip with the upstream version (`app/js/whats-new.js`); `public/version.json` is generated from the
  same file. The build fails if upstream's `settings.php` starts defining anything besides `VERSION`.

No upstream files touched (upstream's `analytics.inc.php` / `donation_panel.inc` / `settings.php` are
overridden from the image and the dev compose file).
