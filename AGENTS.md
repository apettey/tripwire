# Working rules for this repository

These rules apply to everyone changing this repo: people and AI agents alike.

This is a fork of [Tripwire](https://bitbucket.org/daimian/tripwire) (upstream, `production` branch).
We iterate on it here, and we must keep being able to pull in upstream's changes
(see [docker/README.md](docker/README.md#pulling-upstream-changes)).

## 0. Context

- New to EVE Online or wormholes? Read [docs/eve-wormhole-primer.md](docs/eve-wormhole-primer.md) (domain, glossary, where each concept lives in the code).
- Claude Code skills: [tripwire-domain](.claude/skills/tripwire-domain/SKILL.md) (domain + key code entry points) and
  [tripwire-feature](.claude/skills/tripwire-feature/SKILL.md) (checklist for shipping a user-facing feature).

## 1. Log every change in `changes/` (required)

Every change you make — a feature, fix, config or infrastructure change — gets a change-log entry in the
same commit or PR. No entry, no merge.

- Create a folder `changes/YYYY-MM-DD-<feature-name>/` (lower-case, hyphenated feature name).
- Inside it, write `README.md` from [changes/_template.md](changes/_template.md):
  - **Feature**: the feature name
  - **Description**: one to three sentences on what changed and why
  - **Before / After**: screenshots, if the change is visible in the UI
  - **Change**: if there's nothing visual, a short description of what is different instead
- Screenshots go next to the README as `before.png` and `after.png` (`.jpg` is fine). Take "before"
  from the dev stack *before* you start editing, and "after" once the change works.
- Add a row to the table in [changes/README.md](changes/README.md), newest first.
- Updating an existing feature? Add a new entry; don't rewrite old ones.

Keep entries short. They are a log, not documentation.

## 2. Announce user-facing features in What's New

Users learn about new features from the What's New window, which opens once after each update and can be
reopened from Settings > General > What's new. Its content is
[public/whats-new/features.json](public/whats-new/features.json).

- Every PR that adds or changes something users can see adds an entry to `features.json`, newest first.
  Open the PR first to get its number, then push the entry.
  - `pr`: the PR number (unique, it decides what counts as "new")
  - `date`: `YYYY-MM-DD`
  - `title`: the feature name
  - `description`: one to three sentences of plain text (no HTML) saying what it does and how to find it;
    a blank line starts a new paragraph
  - `images` (optional, ideally 1–2): screenshots showing where to find it, saved as
    `public/whats-new/img/pr-<number>-<name>.png` and referenced as
    `{ "src": "whats-new/img/pr-<number>-<name>.png", "caption": "..." }`
- Internal-only changes (Docker, CI, docs, refactoring) don't get an entry.
- Every user-facing feature also adds its entry to [public/fork/feature-catalog.json](public/fork/feature-catalog.json)
  (a follow-up PR adds its number to the parent feature's `prs`; the mocha test `app/js-test/fork/feature-catalog.test.js`
  fails until every What's New PR is covered) and states a one-line success signal in the PR, e.g. "used by >=20% of
  eligible users by day 28, opt-out <10%" (also in the entry's optional `success` field when it is clear). Usage is
  counted first-party ([Product analytics](docker/README.md#product-analytics)); check it with `forkUsage.debug(true)`
  (tripwire-feature skill, section 6).
- Keep wording consistent with the existing entries: plain language, written for the user.

### Ask for every feature: does it need a Settings toggle?

Every user-facing feature must answer this question before it is built, and the answer goes in the PR
(the PR template asks it) and in the change-log entry.

- **Default: yes, add a toggle** wherever someone could reasonably prefer to work without the feature
  (visual additions, pop-ups, automatic behaviour). Bug fixes and pure improvements usually don't need one;
  say why in the PR.
- **On by default**, so users see the feature exists; the toggle lets them turn it off.
- Store it per user in `options.<feature>.enabled`; a missing key means on (with the defaults).
- Mention it in the feature's What's New description ("turn it off in Settings > Map Markers").
- Settings shared by everyone on a mask (channels, filters, mask-wide switches) go in **Mask Admin**, not Settings.

**How:** call `forkSettings.register({...})` from the feature's own JS file (the fields are documented in
[app/js/fork/settings-sections.js](app/js/fork/settings-sections.js)). It builds the row, fills it when Settings
opens, writes it on Save (so it takes effect like its neighbours) and handles Settings > Reset (deletes `key`,
or runs your `reset(options)`). Never find a section by position (`#optionsAccordion > div`) and never add your
own Save/open/Reset hooks. Give the row an `order` so its place doesn't depend on script load order.

**Where:** the section that matches what the user is doing when they'd want to change it.

| Section (`section` key) | What belongs there | Examples |
| --- | --- | --- |
| Chain Map (`chain`) | How the map itself is laid out and drawn (upstream rows) | renderer, gridlines, node spacing, sig name on map |
| Map Markers (`markers`) | Things drawn on the map's nodes and connections | hole size tags, high-sec region, preserve mass, threat badges, Fight here |
| Wormhole Jumps & Mass (`jumps`) | Jumping through holes: mass logging, rolling, after-jump prompts | jump mass, rolling guidance, return bookmark pop-up |
| Signatures (`signatures`) | The signature list: adding, pasting, copying sigs | Add dialog type, paste life, copy separator, colour by age |
| Routes & Navigation (`routes`) | Routes, destinations, getting somewhere | route blobs, K-space route, Thera/Turnur routes, Destinations, Favourites panel, Jump planner on/off |
| Jump Planner (`jumpPlanner`) | One feature's own cluster: jump ship, range, mini-map | jump planner |
| Kills & Intel (`intel`) | Kill feeds, threat info, intel panels | system/chain kill feed, threat & residents, d-scan & local, Watchlist, smart notes |
| Kill Reporting (`killReporting`) | One feature's own cluster: kill sounds and pop-ups | kill reporting |
| General (`general`) | The whole app rather than one area | background, UI scale, What's new, usage statistics |

Drawn on the map means Map Markers, even when it is about mass or kills; a panel or pop-up goes with its
topic. Account Settings and Personal Statistics stay as upstream has them.

**New section:** only when 3 or more related settings fit no description above (or one feature has its own
cluster of 3+); never a one-row section. Add it with `forkSettings.section(key, title, {after: <key>})` from
the feature's JS, choose its position, and add it to this table in the same PR. Aim for 3-10 rows per section.
Don't move settings between sections casually (users learn where things are); if you do, say so in What's New.

## 3. Stay easy to sync with upstream

Upstream changes are applied as a 3-way diff (`.github/scripts/sync-upstream.sh`). Every line we change
in an upstream file is a line that can conflict later.

- **Prefer new files over editing upstream files.** Put fork code in fork-owned places: `docker/`,
  `.github/`, `changes/`, or new files/directories you create. Override behaviour from outside
  (config, nginx, Docker image) where you can.
- When you must edit an upstream file, keep the edit **small and local**: don't reformat, re-indent,
  reorder, rename, or "tidy" surrounding code, and don't change line endings.
  Mention the touched upstream files in the change-log entry.
- Don't hand-edit `.github/upstream-base`; only the sync script updates it.
- Upstream syncs are their own commits/PRs ("Sync upstream Tripwire ..."); don't mix them with
  feature work.
- New settings belong in `docker/config.php` (read from env) and `.env.example`; also update
  `docker/README.md`.

## 4. Develop against the local stack

```bash
docker compose -f docker-compose.dev.yml up --build     # http://127.0.0.1:8080
```

- PHP edits are live. Edits under `app/js` or `app/css` are rebuilt into `public/js/app.min.js` /
  `public/css/app.min.css` by the `assets` service. The bundles are build output: they are git-ignored
  and the Docker image builds its own, so never commit them (upstream does; we don't).
- Never commit `.env`, `config.php`, `db.inc.php`, or any secret. EVE SSO credentials stay in `.env`.
- Before opening a PR, make sure the image still builds: `docker build -f docker/Dockerfile -t tripwire:local .`
- JS tests: `npx gulp test` (from the `assets` container or with Node locally).

## 5. Commits and PRs

- One feature per PR. **Stack PRs:** branch from the newest open PR's branch (from `main` only when no PR is
  open) and target that branch, so open PRs form one chain and don't conflict; merge them bottom-up (head branches
  are deleted on merge, so the next PR retargets to `main`). Describe what changed and link the change-log entry.
- Every feature goes through a review loop before its PR: a fresh reviewer checks the diff, the author fixes,
  and it repeats until a review round has no findings (see the tripwire-feature skill, section 8).
- Every merge to `main` is released automatically: it gets a `vX.Y.Z` tag, a GitHub Release and the
  `petdog/tripwire:latest` image, so `main` must always build and run.
- The version bump follows the PR: a What's New entry is minor, docs-only is no release, anything else is
  patch. Override it with a `semver:major` / `semver:minor` / `semver:patch` / `semver:skip` label
  (breaking changes need `semver:major`). Rules: [docker/README.md](docker/README.md#publishing).
- Each release is then deployed to production by an auto-merging PR in `apettey/eve-infrastructure`.
  If your change needs new env vars, secrets, compose or schema changes there, add the `deploy:manual`
  label so that PR waits for a human ([details](docker/README.md#deploying-to-eve-infrastructure)).

## 6. Security

Upstream has known weaknesses (CSRF on options/masks/comments endpoints, comment XSS, a fixed OAuth
`state`, no session regeneration on login). Don't make them worse. When you fix one, log it like any
other change. Don't add analytics, tracking pixels, or calls to third-party hosts without saying so in
the change-log entry.
