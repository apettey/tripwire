# Discord notifications

**Date:** 2026-10-10

## Description

Mask admins can have Tripwire post to their corporation's Discord through channel webhooks: new k-space connections
within a safe (high-sec only) gate range of trade hubs, kills in the chain, kills by and losses of their corporation.
Each type has its own channel, mentions and message template; delivery goes through a durable outbox and one sender
that handles Discord's rate limits, retries and broken webhooks.

## Before / After

| Before | After |
| --- | --- |
| ![before](before.jpg) | ![after](after.jpg) |

A notification type with the preview of its message (as Discord shows it, and who it pings):

![preview](after-preview.jpg)

## Settings

No per-user toggle: the feature is opt-in per mask. Nothing is posted until an admin of the mask adds a webhook,
picks it for a notification type and turns that type on (Mask Admin > Discord); each type can be turned off there.
Users who aren't admins of the mask see nothing.

## Change

- New page **Mask Admin > Discord** (`app/js/fork/discord-notifications.js`, `app/css/fork/discord-notifications.css`),
  only where the Mask Admin link is shown; `public/discord.php` checks mask admin/owner rights on every request (403
  otherwise), needs a per-session CSRF token header on every change, never returns webhook URLs (name, `…/1234` and
  status instead) and validates them as Discord webhook URLs.
- `discord/` (fork-owned module): settings per mask, webhook URLs encrypted at rest with `DISCORD_SECRET_KEY`
  (new env var; plain text without it, still never shown), templates with escaped game data and `allowed_mentions`
  built only from what the admin wrote, a generated static gate graph (`discord/gate_graph.php` from
  `public/js/combine.js`, `discord/tools/generate-gate-graph.js`) for server-side safe-route BFS, outbox + dedupe
  tables, and the dispatcher (per-webhook and global 429s, `X-RateLimit-*`, 5xx/network backoff, broken webhooks on
  401/403/404, expiry and pruning).
- `discord_notify.worker.php` (new supervisord program `discord-notify`): polls the chain maps for new k-space
  connections and is the only process that calls Discord.
- `zkill_feed.worker.php`: hands each live streamed killmail to `discord_on_killmail()` (3 lines; queues only, never
  blocks the stream; no new zKillboard/ESI callers, names from the existing cache).
- Dev stack: fake Discord service `discord-mock` (`docker/dev/discord-mock.php`, simulates 404/401/429/500) with
  `DISCORD_API_BASE` (accepted for local hosts only), `docker/dev/discord-fake-kill.php` to feed a made-up kill.
- Tests: `discord/tests/discord_test.php` (110 checks: webhook validation, crypto, escaping, mentions, safe-route BFS
  with low-sec ends, Zarzakh and Pochven, hub range, kill classification and filters, settings validation, Discord
  responses with a fake transport) and `app/js-test/fork/discord-notifications.test.js`.
- Docs: `docker/README.md#discord-notifications`, `docker/sql/discord.sql`, `.env.example`, `docker/config.php`,
  `docker-compose.prod.yml` (`DISCORD_SECRET_KEY`).
- New outbound host: `discord.com` (webhook POSTs from the worker). Embeds link/reference `images.evetech.net`,
  `zkillboard.com` and `evemaps.dotlan.net` (fetched by Discord, not by Tripwire).

Upstream files touched: none (`zkill_feed.worker.php`, `docker/*` and the compose files are fork-owned). Upstream's
manual "ping" button (`DISCORD_WEB_HOOK`) is unchanged.
