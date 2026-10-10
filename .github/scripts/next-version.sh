#!/usr/bin/env bash
# Decides the next release version of this fork (SemVer tags vX.Y.Z on main).
# Used by .github/workflows/docker-publish.yml; rules are documented in docker/README.md.
#
# Usage: next-version.sh [-t LATEST_TAG] [-l LABELS] [-b BUMP] [-d] < changed-files
#   -t  latest release tag, e.g. v1.4.2 (omit or empty: no release yet, next is 1.0.0)
#   -l  PR labels, separated by commas or newlines
#   -b  forced bump: major | minor | patch | skip (ignores labels and files)
#   -d  direct push without a PR: patch (labels and files are ignored)
#   stdin: the PR's changed files, one path per line (not read with -b or -d)
#
# Bump for a PR: a semver:* label wins (skip > major > minor > patch); otherwise a change to
# public/whats-new/features.json is minor, docs-only changes are skip, anything else is patch.
# The first release is always 1.0.0, whatever the bump (unless it is skip).
#
# Output (stdout), one key=value per line:
#   bump=major|minor|patch|skip
#   release=true|false
#   version=X.Y.Z    (the new version; the current one, or empty, when release=false)
#   reason=<text>
# Exit 1 on invalid input.
set -euo pipefail

latest=""
labels=""
forced=""
direct=false

die() { echo "next-version: $*" >&2; exit 1; }

while getopts "t:l:b:d" opt; do
	case "$opt" in
		t) latest="$OPTARG" ;;
		l) labels="$OPTARG" ;;
		b) forced="$OPTARG" ;;
		d) direct=true ;;
		*) die "usage: next-version.sh [-t LATEST_TAG] [-l LABELS] [-b BUMP] [-d] < changed-files" ;;
	esac
done

rank() {
	case "$1" in
		patch) echo 1 ;;
		minor) echo 2 ;;
		major) echo 3 ;;
		skip) echo 4 ;;
		*) echo 0 ;;
	esac
}

# Docs-only paths never produce a release on their own
is_docs() {
	case "$1" in
		docs/*|changes/*|.claude/*|*.md|*.MD) return 0 ;;
		*) return 1 ;;
	esac
}

bump=""
reason=""

if [ -n "$forced" ]; then
	[ "$(rank "$forced")" -gt 0 ] || die "invalid bump '$forced' (major, minor, patch or skip)"
	bump="$forced"
	reason="forced: $forced"
elif [ "$direct" = true ]; then
	bump="patch"
	reason="direct push without a PR"
else
	# 1. semver:* labels; skip outranks everything, then the biggest bump
	label_bump=""
	while IFS= read -r label; do
		label="$(printf '%s' "$label" | tr -d '\r' | sed 's/^ *//; s/ *$//')"
		case "$label" in
			semver:major|semver:minor|semver:patch|semver:skip)
				b="${label#semver:}"
				if [ "$(rank "$b")" -gt "$(rank "$label_bump")" ]; then label_bump="$b"; fi
				;;
		esac
	done < <(printf '%s\n' "$labels" | tr ',' '\n')

	# Read the changed files even when a label decides, so stdin is always consumed
	files=()
	while IFS= read -r f || [ -n "$f" ]; do
		f="${f%$'\r'}"
		[ -n "$f" ] && files+=("$f")
	done

	if [ -n "$label_bump" ]; then
		bump="$label_bump"
		reason="label semver:$label_bump"
	elif [ "${#files[@]}" -eq 0 ]; then
		bump="patch"
		reason="no changed files reported"
	else
		features=false
		docs_only=true
		for f in "${files[@]}"; do
			[ "$f" = "public/whats-new/features.json" ] && features=true
			is_docs "$f" || docs_only=false
		done
		if [ "$features" = true ]; then
			bump="minor"
			reason="adds or changes a What's New entry (public/whats-new/features.json)"
		elif [ "$docs_only" = true ]; then
			bump="skip"
			reason="docs-only change (docs/, changes/, .claude/, *.md)"
		else
			bump="patch"
			reason="code or config change"
		fi
	fi
fi

# Current version
current=""
if [ -n "$latest" ]; then
	current="${latest#v}"
	[[ "$current" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] \
		|| die "latest tag '$latest' is not vX.Y.Z"
	major="${BASH_REMATCH[1]}"; minor="${BASH_REMATCH[2]}"; patch="${BASH_REMATCH[3]}"
fi

if [ "$bump" = skip ]; then
	release=false
	version="$current"
elif [ -z "$current" ]; then
	release=true
	version="1.0.0"
	reason="$reason; first release"
else
	release=true
	case "$bump" in
		major) version="$((major + 1)).0.0" ;;
		minor) version="${major}.$((minor + 1)).0" ;;
		patch) version="${major}.${minor}.$((patch + 1))" ;;
	esac
fi

echo "bump=$bump"
echo "release=$release"
echo "version=$version"
echo "reason=$reason"
