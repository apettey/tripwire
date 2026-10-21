#!/usr/bin/env bash
# Local dev only: runs every PHP test script (tests/*_test.php, */tests/*_test.php) inside the dev stack's app
# container and prints a summary. Each script is run with E_ALL, and any PHP Deprecated / Warning / Notice / Fatal
# message the script itself prints counts as a failure. Endpoint code a test reaches over HTTP runs in php-fpm and
# logs to `docker compose logs app` instead: check that log too after a PHP upgrade.
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
  # PHP prints the marker (then a newline) before each of its own messages, wherever it lands on a line and however
  # many lines the message has; error_prepend_string only applies to errors displayed on stdout
  out=$(php -d error_reporting=E_ALL -d display_errors=1 -d html_errors=0 -d log_errors=0 -d error_prepend_string=@@PHP@@ "$script" 2>&1)
  status=$?
  took=$(( $(date +%s) - start ))
  php_issue=$(awk '/@@PHP@@/ { s = $0; sub(/.*@@PHP@@[[:space:]]*/, "", s); if (s == "") getline s; print s }' <<<"$out" | head -5)
  # A script that ends with a deliberate fatal error documents what it prints instead: // Expected output: "..."
  expected=$(sed -n 's/^\/\/ Expected output: "\(.*\)".*/\1/p' "$script" | head -1)
  ok=$(( status == 0 ))
  if [ -n "$expected" ] && grep -qF -- "$expected" <<<"$out"; then
    ok=1
    php_issue=$(grep -v "Fatal error" <<<"$php_issue")
  fi
  if [ "$ok" -eq 1 ] && [ -z "$php_issue" ]; then
    passed=$((passed + 1))
    printf 'PASS  %-50s %3ss\n' "$script" "$took"
  else
    failed+=("$script")
    printf 'FAIL  %-50s %3ss (exit %s)\n' "$script" "$took" "$status"
    if [ -n "$php_issue" ]; then
      sed 's/^/        /' <<<"$php_issue"
    fi
    # The script's own failure lines too: a PHP message may only be a symptom
    if [ "$ok" -ne 1 ]; then
      grep -v "@@PHP@@" <<<"$out" | tail -15 | sed 's/^/        /'
    fi
  fi
done

echo
echo "$passed passed, ${#failed[@]} failed (of ${#scripts[@]})"
[ "${#failed[@]}" -eq 0 ]
