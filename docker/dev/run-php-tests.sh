#!/usr/bin/env bash
# Local dev only: runs every PHP test script (tests/*_test.php, */tests/*_test.php) inside the dev stack's app
# container and prints a summary. Each script is run with E_ALL, and any PHP "Deprecated" / "Warning" / "Notice" /
# "Fatal" line in its output counts as a failure, so a PHP upgrade can't slip a deprecation through.
#
#   docker compose -f docker-compose.dev.yml exec app bash /opt/app/docker/dev-seed.sh   # once, for the dev login
#   docker compose -f docker-compose.dev.yml exec -T app bash /opt/app/docker/dev/run-php-tests.sh [filter]
#
# [filter] is an optional grep -E pattern on the script path (e.g. "discord|rally"). Exit code 1 if any script failed.
set -uo pipefail
cd /opt/app || exit 1

filter="${1:-.}"
shopt -s nullglob
mapfile -t scripts < <(printf '%s\n' tests/*_test.php */tests/*_test.php | grep -E -- "$filter" | sort)
if [ "${#scripts[@]}" -eq 0 ]; then
  echo "No test scripts match '$filter'" >&2
  exit 1
fi

php -v | head -1
passed=0
failed=()
for script in "${scripts[@]}"; do
  start=$(date +%s)
  out=$(php -d error_reporting=E_ALL -d display_errors=stderr -d log_errors=0 "$script" 2>&1)
  status=$?
  took=$(( $(date +%s) - start ))
  # Not anchored: the CLI prints a message straight after any output already on that line
  php_issue=$(grep -oE "(PHP )?(Deprecated|Warning|Notice|Fatal error|Parse error): .* on line [0-9]+" <<<"$out" | head -5)
  # A script that ends with a deliberate fatal error documents what it prints instead: // Expected output: "..."
  expected=$(sed -n 's/^\/\/ Expected output: "\(.*\)".*/\1/p' "$script" | head -1)
  if [ -n "$expected" ] && grep -qF -- "$expected" <<<"$out"; then
    status=0
    php_issue=$(grep -v "Fatal error" <<<"$php_issue")
  fi
  if [ "$status" -eq 0 ] && [ -z "$php_issue" ]; then
    passed=$((passed + 1))
    printf 'PASS  %-50s %3ss\n' "$script" "$took"
  else
    failed+=("$script")
    printf 'FAIL  %-50s %3ss (exit %s)\n' "$script" "$took" "$status"
    if [ -n "$php_issue" ]; then
      sed 's/^/        /' <<<"$php_issue"
    else
      tail -15 <<<"$out" | sed 's/^/        /'
    fi
  fi
done

echo
echo "$passed passed, ${#failed[@]} failed (of ${#scripts[@]})"
[ "${#failed[@]}" -eq 0 ]
