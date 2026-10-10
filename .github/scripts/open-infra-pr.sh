#!/usr/bin/env bash
# Opens (or updates) the eve-infrastructure PR that deploys a release of this fork.
# Run by .github/workflows/infra-deploy.yml; see docker/README.md#deploying-to-eve-infrastructure.
#
# Run from the root of a full clone of this repo (tags included). Environment:
#   VERSION          release to deploy, X.Y.Z (tag vX.Y.Z must exist)
#   DIGEST           sha256:<hex> of petdog/tripwire:VERSION
#   INFRA_DIR        checkout of apettey/eve-infrastructure (on main, push credentials set up)
#   INFRA_REPO       e.g. apettey/eve-infrastructure
#   INFRA_TOKEN      token for INFRA_REPO (gh: PRs, auto-merge); never printed
#   GH_TOKEN         token for reading this repo's PRs (github.token)
#   AUTO_MERGE       true|false: enable squash auto-merge (default true; deploy:manual turns it off)
#   ALLOW_DOWNGRADE  true|false: allow deploying an older version than infra runs (rollback)
#   DRY_RUN          true: only show the diff and PR body (job summary); no push, no PR
#   GITHUB_REPOSITORY, GITHUB_SERVER_URL, GITHUB_RUN_ID, GITHUB_STEP_SUMMARY (set by Actions)
#
# The infra PR changes stacks/tripwire/compose.yaml (+ docs) via infra's tools/bump-tripwire.sh.
# If any fork PR between the version infra runs now and VERSION has the deploy:manual label, the
# PR is opened without auto-merge. Re-runs update the existing PR instead of opening another one.
set -euo pipefail

: "${VERSION:?}" "${DIGEST:?}" "${INFRA_DIR:?}" "${INFRA_REPO:?}" "${INFRA_TOKEN:?}" "${GH_TOKEN:?}"
AUTO_MERGE="${AUTO_MERGE:-true}"
ALLOW_DOWNGRADE="${ALLOW_DOWNGRADE:-false}"
DRY_RUN="${DRY_RUN:-false}"
MARKER="Generated-by: tripwire infra-deploy"
REPO="${GITHUB_REPOSITORY:-apettey/tripwire}"
SERVER="${GITHUB_SERVER_URL:-https://github.com}"
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/null}"
MANUAL_LABEL="deploy:manual"
BOT_NAME="github-actions[bot]"
BOT_EMAIL="41898282+github-actions[bot]@users.noreply.github.com"
summary() { echo "$*" >> "$SUMMARY"; }
infra_gh() { GH_TOKEN="$INFRA_TOKEN" gh "$@"; }

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "::error::bad VERSION '$VERSION'"; exit 1; }
tag="v$VERSION"
commit=$(git rev-parse "$tag^{commit}")
upstream=$(git show "$tag:settings.php" | sed -n "s/.*define('VERSION', *'\([^']*\)').*/\1/p" | head -n1)
release_url="$SERVER/$REPO/releases/tag/$tag"
compose="$INFRA_DIR/stacks/tripwire/compose.yaml"
current=$(sed -nE 's/^    image: petdog\/tripwire:([0-9.]+)@.*/\1/p' "$compose")
summary "### eve-infrastructure"
summary ""

downgrade=false
if [ "$current" != "$VERSION" ] &&
	[ "$(printf '%s\n%s\n' "$current" "$VERSION" | sort -V | tail -n1)" != "$VERSION" ]; then
	downgrade=true
	if [ "$ALLOW_DOWNGRADE" != true ]; then
		echo "::warning::eve-infrastructure already runs $current, newer than $VERSION; nothing to do (run 'Deploy release to infra' with allow_downgrade to roll back)"
		summary "- Infra runs **$current**, newer than $VERSION: no PR (rollbacks need \`allow_downgrade\`)."
		exit 0
	fi
fi

# Fork PRs between what infra runs and this release (first-parent merges on main)
lo="v$current" hi="$tag"
if $downgrade; then lo="$tag" hi="v$current"; fi
if git rev-parse -q --verify "$lo^{commit}" > /dev/null && git merge-base --is-ancestor "$lo" "$hi"; then
	range="$lo..$hi"
else
	range="--max-count=20 $hi" # infra runs a version without a tag here: list recent merges only
fi
prs="" manual_prs=""
# shellcheck disable=SC2086 # range is intentionally split
for c in $(git rev-list --first-parent --max-count=100 $range); do
	line=$(gh api "repos/$REPO/commits/$c/pulls" --jq \
		'[.[] | select(.merged_at != null and .base.ref == "main")][0] | select(.) | [.number, .title, ([.labels[].name] | join(","))] | @tsv')
	[ -n "$line" ] || continue
	IFS=$'\t' read -r num title labels <<< "$line"
	prs+="- $REPO#$num $title${labels:+ (labels: $labels)}"$'\n'
	case ",$labels," in *",$MANUAL_LABEL,"*) manual_prs+="$REPO#$num " ;; esac
done

auto=true reason=""
if [ -n "$manual_prs" ]; then auto=false reason="\`$MANUAL_LABEL\` on $manual_prs"; fi
if $downgrade; then auto=false reason="rollback from $current"; fi
if [ "$AUTO_MERGE" != true ]; then auto=false reason="${reason:-auto_merge=false on the workflow run}"; fi

# Bump
bump_args=("$VERSION" "$DIGEST" "$commit")
if [ -n "$upstream" ]; then bump_args+=(--upstream "$upstream"); fi
if $downgrade; then bump_args+=(--allow-downgrade); fi
(cd "$INFRA_DIR" && bash tools/bump-tripwire.sh "${bump_args[@]}")
files=(stacks/tripwire/compose.yaml README.md docs/agents/facts.md docs/apps/tripwire.md)
if git -C "$INFRA_DIR" diff --quiet -- "${files[@]}"; then
	summary "- Infra main already runs \`petdog/tripwire:$VERSION@$DIGEST\`: no PR."
	exit 0
fi

branch="bump/tripwire-$VERSION"
title="tripwire: petdog/tripwire $VERSION"
body=$(mktemp)
{
	echo "Deploys [Tripwire $tag]($release_url) to production: \`stacks/tripwire/compose.yaml\` now pins"
	echo "\`petdog/tripwire:$VERSION@$DIGEST\` (fork commit [\`${commit:0:7}\`]($SERVER/$REPO/commit/$commit), upstream Tripwire ${upstream:-?})."
	echo "Infra ran **$current** before this PR. Merging redeploys the \`tripwire\` stack on apps-1."
	echo
	if $downgrade; then echo "### Fork PRs rolled back ($tag..v$current)"; else echo "### Fork PRs in this deploy ($range)"; fi
	echo
	printf '%s' "${prs:-"- (none found)"$'\n'}"
	echo
	if $auto; then
		echo "### Auto-merge"
		echo
		echo "Squash auto-merge is enabled: this merges and deploys as soon as the 5 required checks pass."
		echo "If a check fails the PR stays open; fix it here or close it. To stop the deploy, disable auto-merge or close this PR."
		echo "If GitHub says the PR waits for an approval (the ruleset's extra approval for unattributed changes), approve"
		echo "or merge it by hand; auto-merge stays armed until then."
	else
		echo "### Manual deploy: $reason"
		echo
		echo "Auto-merge is **off**. Before merging, check (and push fixes to this branch):"
		echo
		echo "- [ ] The fork PRs' \`changes/\` entries and [docker/README.md]($SERVER/$REPO/blob/$tag/docker/README.md#environment-variables) for new or renamed env vars; map them in \`stacks/tripwire/compose.yaml\`"
		echo "- [ ] New secrets: add them to \`secrets/apps/tripwire.env\` (sops) and \`secrets/apps/tripwire.env.example\`"
		echo "- [ ] Schema changes that \`CREATE TABLE IF NOT EXISTS\` does not cover (manual SQL, see docs/apps/tripwire.md#upgrading)"
		echo "- [ ] New outbound hosts, ports or volumes"
		echo "- [ ] Docs: docs/apps/tripwire.md"
		if $downgrade; then
			echo "- [ ] Rollback: the older image must cope with what newer releases left behind (extra tables and env vars are"
			echo "      usually harmless; changed columns or data are not). There are no backups."
		fi
		echo
		echo "Then merge it yourself (squash) and watch the deploy."
	fi
	echo
	echo "After the deploy: \`gh run list --repo $INFRA_REPO --workflow deploy.yml --limit 1\`, then \`tools/verify-sites.sh\`."
	echo "Roll back by reverting this PR, or run *Deploy release to infra* in $REPO with an older version and \`allow_downgrade\`."
	echo
	echo "Opened by [$REPO run ${GITHUB_RUN_ID:-local}]($SERVER/$REPO/actions/runs/${GITHUB_RUN_ID:-}) (\`.github/workflows/infra-deploy.yml\`)."
} > "$body"

cd "$INFRA_DIR"
if [ "$DRY_RUN" = true ]; then
	{
		echo "- **Dry run**: would open \`$branch\` \"$title\" (auto-merge: $auto${reason:+, $reason}). Diff and body:"
		echo ""
		echo '```diff'
		git --no-pager diff -- "${files[@]}"
		echo '```'
		echo ""
		cat "$body"
	} >> "$SUMMARY"
	git --no-pager diff -- "${files[@]}"
	exit 0
fi

# Commit as the token's owner, so the push is attributed to them (falls back to the Actions bot,
# e.g. for a GitHub App token, which cannot read /user)
if who=$(infra_gh api user --jq '[.login, "\(.id)+\(.login)@users.noreply.github.com"] | @tsv' 2> /dev/null) && [ -n "$who" ]; then
	IFS=$'\t' read -r BOT_NAME BOT_EMAIL <<< "$who"
fi
git config user.name "$BOT_NAME"
git config user.email "$BOT_EMAIL"
git checkout -q -B "$branch"
git add -- "${files[@]}"
git commit -q -m "$title" -m "Release: $release_url
Fork commit: $commit
Digest: $DIGEST" -m "$MARKER"

push=true
if git ls-remote --exit-code --heads origin "$branch" > /dev/null; then
	git fetch -q origin "$branch"
	theirs=$(git rev-list --count "origin/main..origin/$branch")
	ours=$(git rev-list --count --grep="^$MARKER\$" "origin/main..origin/$branch")
	if git diff --quiet "origin/$branch" HEAD -- stacks/tripwire/compose.yaml; then
		push=false # same pin already on the branch; keep it (and anything pushed on top)
	elif [ "$theirs" = "$ours" ]; then
		: # only commits made by this script: replace them
	else
		push=false
		echo "::warning::$branch has commits by people and a different pin; not overwriting it"
		summary "- **Warning:** \`$branch\` has human commits and a different image pin; left as is."
	fi
fi
if $push; then git push -q --force origin "HEAD:refs/heads/$branch"; fi

pr=$(infra_gh pr list --repo "$INFRA_REPO" --head "$branch" --state open --json number --jq '.[0].number // empty')
if [ -n "$pr" ]; then
	infra_gh pr edit "$pr" --repo "$INFRA_REPO" --title "$title" --body-file "$body" > /dev/null
	verb=Updated
else
	url=$(infra_gh pr create --repo "$INFRA_REPO" --base main --head "$branch" --title "$title" --body-file "$body")
	pr="${url##*/}"
	verb=Opened
fi
pr_url="$SERVER/$INFRA_REPO/pull/$pr"
summary "- $verb [$INFRA_REPO#$pr]($pr_url): \`petdog/tripwire:$current\` -> \`$VERSION\`"

# Older bump PRs are superseded (this one carries their changes too)
for old in $(infra_gh pr list --repo "$INFRA_REPO" --state open --json number,headRefName \
	--jq ".[] | select(.headRefName | startswith(\"bump/tripwire-\")) | select(.number != $pr) | .number"); do
	infra_gh pr close "$old" --repo "$INFRA_REPO" --delete-branch \
		--comment "Superseded by #$pr (Tripwire $VERSION), which deploys these changes too." > /dev/null || true
	summary "- Closed superseded #$old"
done

if $auto; then
	if infra_gh pr merge "$pr" --repo "$INFRA_REPO" --auto --squash; then
		summary "- Auto-merge (squash) enabled: merges and deploys once the required checks pass."
	else
		echo "::warning::Could not enable auto-merge on $INFRA_REPO#$pr (is 'Allow auto-merge' on in its settings?). Merge it by hand."
		summary "- **Warning:** auto-merge could not be enabled; merge $pr_url by hand."
	fi
else
	infra_gh pr merge "$pr" --repo "$INFRA_REPO" --disable-auto > /dev/null 2>&1 || true
	summary "- **Manual deploy** ($reason): auto-merge off; review and merge $pr_url yourself."
fi
