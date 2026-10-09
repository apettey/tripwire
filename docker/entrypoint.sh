#!/usr/bin/env bash
set -euo pipefail

DB_HOST="${DB_HOST:-mysql}"
DB_PORT="${DB_PORT:-3306}"
DB_NAME="${DB_NAME:-tripwire_database}"
DB_USER="${DB_USER:-tripwire}"
DB_PASSWORD="${DB_PASSWORD:-}"
DB_INIT_USER="${DB_INIT_USER:-$DB_USER}"
DB_INIT_PASSWORD="${DB_INIT_PASSWORD:-$DB_PASSWORD}"
DB_AUTO_INIT="${DB_AUTO_INIT:-true}"
DB_WAIT_SECONDS="${DB_WAIT_SECONDS:-60}"

# Cache dir must be writable by php-fpm (may be a bind mount in dev)
mkdir -p /opt/app/cache
chown -R www-data:www-data /opt/app/cache 2>/dev/null || true

# Trust X-Forwarded-For only from TRUSTED_PROXIES (comma/space separated CIDRs)
realip_conf=/etc/nginx/http.d/realip.conf
: > "$realip_conf"
IFS=', ' read -ra proxies <<< "${TRUSTED_PROXIES:-}"
if [ "${#proxies[@]}" -gt 0 ]; then
  for cidr in "${proxies[@]}"; do
    echo "set_real_ip_from $cidr;" >> "$realip_conf"
  done
  printf 'real_ip_header X-Forwarded-For;\nreal_ip_recursive on;\n' >> "$realip_conf"
fi
if ! nginx -t -q; then
  echo "[tripwire] ERROR: invalid nginx config (check TRUSTED_PROXIES)" >&2
  exit 1
fi

if [ "$DB_AUTO_INIT" = "true" ]; then
  export MYSQL_PWD="$DB_INIT_PASSWORD"
  mysql_cmd=(mariadb --ssl --skip-ssl-verify-server-cert -h"$DB_HOST" -P"$DB_PORT" -u"$DB_INIT_USER")

  echo "[tripwire] Waiting up to ${DB_WAIT_SECONDS}s for MySQL at $DB_HOST:$DB_PORT..."
  for i in $(seq 1 "$DB_WAIT_SECONDS"); do
    if "${mysql_cmd[@]}" -e "SELECT 1" >/dev/null 2>&1; then break; fi
    if [ "$i" -eq "$DB_WAIT_SECONDS" ]; then
      echo "[tripwire] ERROR: could not connect to MySQL" >&2
      "${mysql_cmd[@]}" -e "SELECT 1" || true
      exit 1
    fi
    sleep 1
  done

  "${mysql_cmd[@]}" -e "CREATE DATABASE IF NOT EXISTS \`$DB_NAME\`;" 2>/dev/null || true
  count_tables() {
    "${mysql_cmd[@]}" -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$DB_NAME' $1;"
  }
  TOTAL=$(count_tables "")
  CORE=$(count_tables "AND table_name IN ('accounts','signatures','wormholes')")
  if [ "$TOTAL" = "0" ]; then
    echo "[tripwire] Importing schema into $DB_NAME as $DB_INIT_USER..."
    "${mysql_cmd[@]}" "$DB_NAME" < /opt/app/.docker/mysql/tripwire.sql
    echo "[tripwire] Schema imported"
  elif [ "$CORE" = "3" ]; then
    echo "[tripwire] Schema already present in $DB_NAME"
  else
    echo "[tripwire] ERROR: $DB_NAME has $TOTAL tables but is missing accounts/signatures/wormholes." >&2
    echo "[tripwire] Refusing to import over existing data. Fix or empty the database, or set DB_AUTO_INIT=false." >&2
    exit 1
  fi
  unset MYSQL_PWD
fi

exec "$@"
