#!/usr/bin/env bash
# Pulls upstream Tripwire changes into the working tree.
#
# This repo does not share git history with upstream. .github/upstream-base holds the
# upstream commit our code currently matches; this script applies the upstream diff from
# that commit to the latest upstream with a 3-way merge, then updates the base file.
#
# Exit codes: 0 = applied cleanly (or already up to date), 2 = applied with conflicts
# (fix the <<<<<<< markers, `git add`, commit), 1 = error.
#
# Usage (repo root, clean working tree):  .github/scripts/sync-upstream.sh
set -euo pipefail

UPSTREAM_URL="${UPSTREAM_URL:-https://bitbucket.org/daimian/tripwire.git}"
UPSTREAM_BRANCH="${UPSTREAM_BRANCH:-production}"
BASE_FILE=".github/upstream-base"

cd "$(git rev-parse --show-toplevel)"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Working tree has uncommitted changes; commit or stash them first." >&2
  exit 1
fi

base=$(tr -d '[:space:]' < "$BASE_FILE")
git fetch --quiet --no-tags "$UPSTREAM_URL" "+refs/heads/$UPSTREAM_BRANCH:refs/remotes/upstream/$UPSTREAM_BRANCH"
target=$(git rev-parse "refs/remotes/upstream/$UPSTREAM_BRANCH")

if [ "$base" = "$target" ]; then
  echo "Already up to date with upstream $UPSTREAM_BRANCH ($target)"
  exit 0
fi

echo "Applying upstream $base..$target:"
git log --oneline --no-decorate "$base..$target"

echo "$target" > "$BASE_FILE"
git add "$BASE_FILE"

# Upstream commits its built bundles; we build ours from app/ and don't track them
if git diff --binary "$base" "$target" -- . \
    ':(exclude)public/js/app.min.js' ':(exclude)public/js/app.min.js.map' \
    ':(exclude)public/css/app.min.css' ':(exclude)public/css/app.min.css.map' \
    | git apply --3way --index --whitespace=nowarn; then
  echo "Applied cleanly. Review with 'git diff --cached', then commit."
  exit 0
else
  echo >&2
  echo "Applied with conflicts in:" >&2
  git diff --name-only --diff-filter=U >&2
  echo "Resolve the markers, 'git add' the files, then commit." >&2
  exit 2
fi
