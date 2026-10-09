# Fork setup

**Date:** 2026-10-10

## Description

Started this repo from upstream Tripwire (`bitbucket.org/daimian/tripwire`, `production` at
`6682a89`) as a snapshot without upstream's git history, and added the tooling to keep pulling
upstream changes in.

## Change

- First commit is the unmodified upstream snapshot; `.github/upstream-base` records its upstream commit.
- `.github/scripts/sync-upstream.sh` applies upstream's changes since that commit as a 3-way merge;
  `.github/workflows/upstream-sync.yml` runs it weekly and opens a PR.
- Added `AGENTS.md` (working rules, `CLAUDE.md` points to it) and this `changes/` log.
- Upstream file touched: `README.md` (attribution note at the top).
