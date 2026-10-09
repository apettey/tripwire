# Working rules for this repository

These rules apply to everyone changing this repo: people and AI agents alike.

This is a fork of [Tripwire](https://bitbucket.org/daimian/tripwire) (upstream, `production` branch).
We iterate on it here, and we must keep being able to pull in upstream's changes
(see [docker/README.md](docker/README.md#pulling-upstream-changes)).

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

## 2. Stay easy to sync with upstream

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

## 3. Develop against the local stack

```bash
docker compose -f docker-compose.dev.yml up --build     # http://127.0.0.1:8080
```

- PHP edits are live. Edits under `app/js` or `app/css` are rebuilt into `public/js/app.min.js` /
  `public/css/app.min.css` by the `assets` service. Upstream commits those bundles, so commit them
  together with the source change, and only when you changed `app/`.
- Never commit `.env`, `config.php`, `db.inc.php`, or any secret. EVE SSO credentials stay in `.env`.
- Before opening a PR, make sure the image still builds: `docker build -f docker/Dockerfile -t tripwire:local .`
- JS tests: `npx gulp test` (from the `assets` container or with Node locally).

## 4. Commits and PRs

- One feature per PR, branched from `main`. Describe what changed and link the change-log entry.
- Pushing to `main` publishes `petdog/tripwire:latest` to Docker Hub, so `main` must always build and run.

## 5. Security

Upstream has known weaknesses (CSRF on options/masks/comments endpoints, comment XSS, a fixed OAuth
`state`, no session regeneration on login). Don't make them worse. When you fix one, log it like any
other change. Don't add analytics, tracking pixels, or calls to third-party hosts without saying so in
the change-log entry.
