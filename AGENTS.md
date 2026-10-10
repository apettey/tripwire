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
reopened from Settings > General Preferences > What's new. Its content is
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
- Keep wording consistent with the existing entries: plain language, written for the user.

### Ask for every feature: does it need a Settings toggle?

Every user-facing feature must answer this question before it is built, and the answer goes in the PR
(the PR template asks it) and in the change-log entry.

- **Default: yes, add a toggle** wherever someone could reasonably prefer to work without the feature
  (visual additions, pop-ups, automatic behaviour). Bug fixes and pure improvements usually don't need one;
  say why in the PR.
- **On by default**, so users see the feature exists; the toggle lets them turn it off.
- Store it per user in `options.<feature>.enabled` (a missing key means on), add a row to the matching
  Settings section (Chain Map Settings, General Preferences, ...) from the feature's own JS, apply it on
  Save like the neighbouring settings, and make sure it survives Settings > Reset.
- Mention the toggle in the feature's What's New description ("turn it off in Settings > ...").

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
  `public/css/app.min.css` by the `assets` service. Upstream commits those bundles, so commit them
  together with the source change, and only when you changed `app/`.
- Never commit `.env`, `config.php`, `db.inc.php`, or any secret. EVE SSO credentials stay in `.env`.
- Before opening a PR, make sure the image still builds: `docker build -f docker/Dockerfile -t tripwire:local .`
- JS tests: `npx gulp test` (from the `assets` container or with Node locally).

## 5. Commits and PRs

- One feature per PR, branched from `main`. Describe what changed and link the change-log entry.
- Every merge to `main` is released automatically: it gets a `vX.Y.Z` tag, a GitHub Release and the
  `petdog/tripwire:latest` image, so `main` must always build and run.
- The version bump follows the PR: a What's New entry is minor, docs-only is no release, anything else is
  patch. Override it with a `semver:major` / `semver:minor` / `semver:patch` / `semver:skip` label
  (breaking changes need `semver:major`). Rules: [docker/README.md](docker/README.md#publishing).

## 6. Security

Upstream has known weaknesses (CSRF on options/masks/comments endpoints, comment XSS, a fixed OAuth
`state`, no session regeneration on login). Don't make them worse. When you fix one, log it like any
other change. Don't add analytics, tracking pixels, or calls to third-party hosts without saying so in
the change-log entry.
