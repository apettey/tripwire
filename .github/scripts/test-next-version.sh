#!/usr/bin/env bash
# Tests for next-version.sh. Run from anywhere: .github/scripts/test-next-version.sh
set -uo pipefail

script="$(dirname "$0")/next-version.sh"
pass=0
fail=0

# check <name> <expected "bump release version"> <stdin files> [next-version args...]
check() {
	local name="$1" expected="$2" files="$3"
	shift 3
	local out actual
	if ! out="$(printf '%s' "$files" | bash "$script" "$@" 2>&1)"; then
		actual="error"
	else
		actual="$(printf '%s\n' "$out" | sed -n 's/^bump=//p; s/^release=//p; s/^version=//p' | tr '\n' ' ' | sed 's/ $//')"
	fi
	if [ "$actual" = "$expected" ]; then
		pass=$((pass + 1))
		printf 'ok    %-58s %s\n' "$name" "$actual"
	else
		fail=$((fail + 1))
		printf 'FAIL  %-58s expected [%s] got [%s]\n' "$name" "$expected" "$actual"
		printf '%s\n' "$out" | sed 's/^/        /'
	fi
}

code=$'docker/Dockerfile\napp/js/whats-new.js\n'
docs=$'docs/guide.md\nchanges/2026-10-10-x/README.md\nchanges/2026-10-10-x/after.png\nAGENTS.md\n.claude/settings.json\ndocker/README.md\n'
feature=$'app/js/foo.js\npublic/whats-new/features.json\n'

# First release
check "first release, code change"               "patch true 1.0.0"  "$code"
check "first release, feature"                   "minor true 1.0.0"  "$feature"
check "first release, label major"               "major true 1.0.0"  "$code" -l "semver:major"
check "first release, docs only"                 "skip false "       "$docs"

# File rules
check "code change -> patch"                     "patch true 1.4.3"  "$code"    -t v1.4.2
check "features.json -> minor"                   "minor true 1.5.0"  "$feature" -t v1.4.2
check "features.json only -> minor"              "minor true 1.5.0"  $'public/whats-new/features.json\n' -t v1.4.2
check "docs only -> skip"                        "skip false 1.4.2"  "$docs"    -t v1.4.2
check "docs + one code file -> patch"            "patch true 1.4.3"  "${docs}settings.php"$'\n' -t v1.4.2
check "screenshot in whats-new img -> patch"     "patch true 1.4.3"  $'public/whats-new/img/pr-9-x.png\n' -t v1.4.2
check "CRLF and no trailing newline"             "skip false 1.4.2"  $'README.md\r\nchanges/a/README.md' -t v1.4.2
check "no files reported -> patch"               "patch true 1.4.3"  ""         -t v1.4.2

# Labels
check "label minor beats code"                   "minor true 1.5.0"  "$code"    -t v1.4.2 -l "semver:minor"
check "label patch beats features.json"          "patch true 1.4.3"  "$feature" -t v1.4.2 -l "semver:patch"
check "label patch beats docs-only skip"         "patch true 1.4.3"  "$docs"    -t v1.4.2 -l "semver:patch"
check "label major"                              "major true 2.0.0"  "$code"    -t v1.4.2 -l "bug,semver:major"
check "several labels, highest wins"             "major true 2.0.0"  "$code"    -t v1.4.2 -l "semver:patch,semver:major,semver:minor"
check "skip label beats everything"              "skip false 1.4.2"  "$feature" -t v1.4.2 -l "semver:major,semver:skip"
check "newline-separated labels with spaces"     "minor true 1.5.0"  "$code"    -t v1.4.2 -l $' enhancement \n semver:minor '
check "unrelated labels ignored"                 "patch true 1.4.3"  "$code"    -t v1.4.2 -l "semver,semver:huge,minor"

# Direct push / forced
check "direct push -> patch"                     "patch true 1.4.3"  "$docs"    -t v1.4.2 -d
check "direct push, first release"               "patch true 1.0.0"  ""         -d
check "forced major (manual run)"                "major true 2.0.0"  ""         -t v1.4.2 -b major
check "forced minor resets patch"                "minor true 1.5.0"  ""         -t v1.4.9 -b minor
check "forced skip"                              "skip false 1.4.2"  ""         -t v1.4.2 -b skip
check "double-digit components"                  "patch true 10.20.31" "$code"  -t v10.20.30
check "tag without v prefix accepted"            "patch true 1.4.3"  "$code"    -t 1.4.2

# Invalid input
check "invalid forced bump"                      "error"             ""         -t v1.4.2 -b huge
check "invalid tag"                              "error"             "$code"    -t v1.4
check "pre-release tag rejected"                 "error"             "$code"    -t v1.4.2-rc1

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
