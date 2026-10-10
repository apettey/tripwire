# Rally point to Discord

**Date:** 2026-10-10

## Description

Setting, moving or clearing the rally point now also posts a short message to the mask's Discord webhook,
the same one upstream's chain map pings use. The person changing the rally can untick "Also post to
Discord" in the chain map's right-click menu; nothing happens when the mask has no webhook.

## Before / After

| Before | After |
| --- | --- |
| ![before](before.png) | ![after](after.png) |

Settings row: ![settings](settings.png)

## Settings

Toggle: the "Also post to Discord" entry in the chain map right-click menu (only shown when the mask has a
webhook) and Settings > Chain Map Settings > Rally point "Post rally changes to Discord". Both set
`options.rallyDiscord.enabled` (missing = on), so the last choice is remembered per user; Settings > Reset
turns it back on.

## Change

- `public/rally.php` (fork file): a change POSTed with `discord=1` is posted after the response is sent
  (`fastcgi_finish_request`), only when the rally actually changed (moving to the same system or clearing
  an empty rally posts nothing). GET/POST responses include `discord` (does the mask have a webhook).
- New `rally_discord.inc.php`: webhook lookup through upstream's `discord_webhook_for_current_mask()`
  (`ping.inc.php`) and sending like `public/ping.php` (`file_get_contents` + http stream context, JSON
  body, 5 s timeout). Message follows upstream's ping format: system name with class and region from
  `public/js/combine.js` (server side, not trusted from the client), who set it, and a link back to
  Tripwire. Clearing posts "Tripwire rally point cleared by *name*".
- The link is built from configuration only: scheme/host/port of `EVE_SSO_REDIRECT` (in Docker built from
  `TRIPWIRE_DOMAIN` / `TRIPWIRE_HTTPS`) plus the directory of `SCRIPT_NAME`; never the Host header or
  `REQUEST_URI`, and `<`, `>` and whitespace are stripped from it so it can't leave its `<autolink>`.
- Escaping: user text (the character name) is stripped of control characters and `<`/`>`, markdown is
  backslash-escaped, `@` gets a zero-width space, and every payload carries
  `"allowed_mentions": {"parse": []}`, so `@everyone`, `@here` and `<@id>` can't ping.
- Debounce (new table `fork_rally_discord`, one row per mask, created on first use): at most one **new**
  Discord message per mask per 30 s; a change inside the window edits that message (`PATCH
  .../messages/<id>`, the id comes from posting with `?wait=true`).
  - Each send holds a per-mask MySQL lock (`GET_LOCK('rally_discord_<mask>', 20)`) around decide, claim
    and send, and posts the rally **as stored when it holds the lock** (not the change that triggered
    it). Concurrent changes are serialised, and the last send always shows the final rally.
  - A failed post deletes the claim, so the next change posts. A failed edit (message deleted: 404, or
    Discord unreachable) falls back to a new post.
  - Errors are logged with the webhook URL redacted (it contains the token).
- `app/js/fork/rally.js` / `app/css/fork/rally.css`: the menu entry (keeps the menu open when toggled),
  the Settings row, `discord=1|0` on changes. Mocha tests for the option and payload logic; PHP tests in
  `tests/rally_discord_test.php` (escaping, labels, payload, debounce, webhook URLs, link base with a
  hostile Host / `REQUEST_URI`, log redaction; 50 checks).
- `docker/Dockerfile` leaves `tests/` out of the image; `docker/README.md` documents the webhook use.
- No upstream files touched.
- **Third-party host:** rally posts go to the mask's configured webhook, normally `discord.com`, which
  upstream's pings already call. Nothing is sent without a configured webhook.

Captured in dev against a local stub webhook (`php -S 127.0.0.1:9999` inside the app container,
`DISCORD_WEB_HOOK={"<mask>":"http://127.0.0.1:9999/api/webhooks/123/devtoken"}`).

Set, move to Jita 2 s later, clear 1 s later, then (with the option unticked) set again; there was no
request for the unticked change:

```
12:19:39 POST /api/webhooks/123/devtoken?wait=true
{"content":"Tripwire rally point from *Chribba*: **J152820 (C5, E-R00024)**\n<http:\/\/localhost:8096\/?system=J152820>","allowed_mentions":{"parse":[]}}

12:19:41 PATCH /api/webhooks/123/devtoken/messages/1000034779948
{"content":"Tripwire rally point from *Chribba*: **Jita (High-Sec, The Forge)**\n<http:\/\/localhost:8096\/?system=Jita>","allowed_mentions":{"parse":[]}}

12:19:42 PATCH /api/webhooks/123/devtoken/messages/1000034779948
{"content":"Tripwire rally point cleared by *Chribba*","allowed_mentions":{"parse":[]}}
```

Three parallel changes (Jita, Amarr, J150745) after the window: one new message, and the last edit
shows what's stored (`fork_rally` = J150745):

```
12:18:50 POST  .../devtoken?wait=true             Jita (High-Sec, The Forge)
12:18:50 PATCH .../devtoken/messages/1000034730603 J150745 (C1, A-R00002)
12:18:50 PATCH .../devtoken/messages/1000034730603 J150745 (C1, A-R00002)
```

The message was deleted (the edit gets a 404), then the stub was down; each falls back:

```
12:18:28 PATCH .../devtoken/messages/404   -> 404, then
12:18:28 POST  .../devtoken?wait=true      Jita (High-Sec, The Forge)
(stub down: POST fails, claim deleted; log: "rally discord: POST failed: file_get_contents(<webhook> ... Connection refused")
12:18:31 POST  .../devtoken?wait=true      Thera (Thera, G-R00031)   <- the next change posts
```

The link comes from `EVE_SSO_REDIRECT`, which is `http://localhost:8096/...` in the dev stack.
