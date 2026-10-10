# ESI compatibility date and rate limits

**Date:** 2026-10-10

## Description

ESI picks each route's behaviour by compatibility date and has a new token-bucket rate limiter, but Tripwire
sent no date and ignored ESI's limit headers. Every ESI request now carries one pinned date (`2025-12-16`), and
429 / 420 / nearly used-up limits pause the affected calls until ESI says they may resume, instead of retrying.

## Settings

No toggle, because nothing changes for users while ESI answers normally: the date gives the same responses as
before, and the pauses only kick in when ESI is already refusing requests.

## Change

**Facts (checked 2026-10-10):**

- Versioning: send `X-Compatibility-Date: YYYY-MM-DD`, or the `compatibility_date` query parameter where headers
  can't be set. Without one, ESI serves the oldest date. The date can't be in the future, and ESI's day changes at
  11:00 UTC ([ESI overview](https://developers.eveonline.com/docs/services/esi/overview/)). Valid dates are listed at
  `GET /meta/compatibility-dates` (2020-01-01 … 2026-08-18). Tested on live ESI: legacy prefixes (`/v4/`,
  `/latest/`) don't pick a version; the date does (`/v4/corporations/{id}` at 2026-08-18 returns the 2026-07-21
  shape). The response's `X-Compatibility-Date` names the route version actually served. Both the header and the
  query parameter are honoured on legacy paths (a future date gets a 400).
- Pinned date: **2025-12-16**, the same date `zkill/` already used. In `GET /meta/changelog`, the breaking changes
  for routes we call come later: `GET /characters/{id}` (`title` → `corporation_title`, 2026-06-09) and
  `GET /corporations/{id}` (`faction_id`/`tax_rate` renamed, 2026-07-21). I compared the OpenAPI specs at
  2020-01-01 and 2025-12-16 (`/meta/openapi.json?compatibility_date=…`, `$ref`s resolved). They are identical,
  apart from the date itself, for every route we use: character location/ship/online/roles/titles/search/public
  info, corporations, alliances, affiliation, universe names/types/stations/system_jumps/system_kills, status,
  ui/autopilot/waypoint, ui/openwindow/information, fw/systems and killmails. So behaviour doesn't change.
- Rate limits ([rate limiting](https://developers.eveonline.com/docs/services/esi/rate-limiting/)): this is a
  floating window (15 min). Each route group has its own bucket: per application+character for authenticated
  routes, per IP for public ones. Costs: 2XX = 2 tokens, 3XX = 1, 4XX = 5 (429 excluded), 5XX = 0. Headers:
  `X-Ratelimit-Group`, `X-Ratelimit-Limit` (e.g. `600/15m`), `X-Ratelimit-Remaining`, `X-Ratelimit-Used`. Over
  the limit you get 429 with `Retry-After` (seconds). Routes without the new limiter keep the legacy error limit:
  100 non-2xx/3xx responses per window, then 420 on every route, with `X-ESI-Error-Limit-Remain` / `-Reset`
  ([best practices](https://developers.eveonline.com/docs/services/esi/best-practices/)). The two header sets
  are mutually exclusive.
- Enforcement is live, rolled out group by group since 13 Oct 2025
  ([announcement](https://developers.eveonline.com/blog/hold-your-horses-introducing-rate-limiting-to-esi),
  [market orders, 24 Feb 2026](https://developers.eveonline.com/blog/market-orders-rate-limit-rolls-out-on-february-24-2026)).
  Groups we hit now (from the 2025-12-16 spec): `char-location` 1200/15m (location, ship, online),
  `ui` 900/15m, `status` 600/15m, `char-detail` 600/15m (roles, titles), `factional-warfare` 150/15m and
  `killmail` 3600/15m. The rest are still error-limited. Tracking one character polls location + ship every 5 s
  and online every 60 s, about 750 of 1200 tokens per 15 min. A second open tab for the same character runs out
  the bucket, which is the main case this change handles.
- CORS (checked live): `Access-Control-Allow-Origin: *`, the preflight allows `x-compatibility-date`, and
  `Retry-After`, `X-Ratelimit-*` and `X-Esi-Error-Limit-*` are exposed to scripts. The browser still uses the
  query parameter. Upstream deliberately keeps its GETs "simple" (token and user agent in the query string), and a
  custom header would add a preflight to every poll.

**Code:**

- `esi/esi.inc.php` (new, fork-owned) holds `ESI_COMPATIBILITY_DATE` and the PHP limiter. It adds the header to
  ESI calls and reads the limit headers. A 429 pauses the group, per character when authenticated (or the route
  when there is no group header), for `Retry-After`. A 420, or fewer than 10 errors left, pauses all ESI calls until
  the reset. A group with less than 5% of its tokens left pauses for 60 s. Pauses are capped at 15 min, shared
  across PHP processes in `cache/esi-limits.json` (with `flock`), and logged once. A paused call is not sent.
  SSO (`login.eveonline.com`) is never paused. Tests: `esi/tests/esi_test.php` (fake transport, 51 checks).
- `app/js/fork/esi-limits.js` (new) is a jQuery `ajaxPrefilter` scoped to `https://esi.evetech.net/`. It appends
  `compatibility_date` and records every response. Upstream's `tripwire.esi.location/ship/online` are wrapped to
  leave out characters paused by a 429 on their own route. A 420 or a low error budget pauses all polling and the
  TQ status poll. Timers keep running and a character rejoins when its pause ends. User actions are not held
  back. The upstream "ESI Connection Failed / Resumed" notices still show. Tests:
  `app/js-test/fork/esi-limits.test.js`, which also checks that the JS and PHP dates match. Checked in the dev
  stack in headless Chrome with all ESI traffic intercepted and two fake characters. After a 429 for one
  character, that character made 0 requests during the 20 s pause while the other kept polling, then it resumed.
  52 of 53 ESI requests had the date, and there were no preflights.
- Known gap: the first TQ status request at page load is sent by upstream's `serverStatus.js` before the fork
  bundle code runs, so it has no date. `/status` is identical at both dates, and later polls carry the date.
- `zkill/`: already sent `X-Compatibility-Date` and handled 429/420/limit headers in its own client (unchanged).
  It now takes the date from `ESI_COMPATIBILITY_DATE`.
- `docker/dev-seed.sh` sends the date on its public ESI lookups. `docker/Dockerfile` leaves `esi/tests/` out of
  the image. `docker/README.md` has a new section, "ESI compatibility date and rate limits". There is no env var:
  changing the date can change response shapes, so it is a code change.

**Upstream files touched** (small, marked `// fork`):

- `esi.class.php`: require `esi/esi.inc.php`; in `getAPI()`, the pause check, header date, response-header
  collection and recording (5 lines).
- `public/cached_third_party.php`: `fopen($url)` → `esi_open_url($url, $cache_file)`. Non-ESI URLs are still a
  plain `fopen`. ESI uses the date and limits, and serves the stale cache if paused or failing.
- `public/js/app.min.js(.map)`: rebuilt bundle (one line added).

No new third-party hosts, analytics or tracking.
