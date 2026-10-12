# API password login off by default

**Date:** 2026-10-12

## Description

The old REST API login with the Tripwire account password (HTTP Basic) is now off by default: it has no rate limit and sends the real password on every request, and personal API tokens (#96) cover everything it could read.

## Change

- `TRIPWIRE_API_PASSWORD_AUTH` now defaults to `false` (`docker/config.php`, `api/tokens.inc.php`); only `true`/`1`/`yes`/`on` turns it on. With it off, Basic auth answers 401; `/api/v1` never accepted passwords.
- `.env.example` and `docker/README.md` updated; `tests/api_tokens_test.php` expects off by default.
- Anyone with an old script: create a token in Settings > General > API tokens, or set `TRIPWIRE_API_PASSWORD_AUTH=true` temporarily.

No UI change, no toggle (server setting).
