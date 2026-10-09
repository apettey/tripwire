#!/usr/bin/env bash
set -euo pipefail

echo "[SEED] Starting Tripwire + fuzzworks SDE seed..."

DB_HOST="${DB_HOST:-mysql}"
DB_PORT="${DB_PORT:-3306}"
DB_ROOT_USER="${DB_ROOT_USER:-root}"
DB_ROOT_PASS="${DB_ROOT_PASS:-}"
TRIPWIRE_DB="${TRIPWIRE_DB:-tripwire_database}"
SDE_DB="${SDE_DB:-eve_dump}"

echo "[SEED] DB_HOST=$DB_HOST; DB_PORT=$DB_PORT; TRIPWIRE_DB=$TRIPWIRE_DB; SDE_DB=$SDE_DB"

###############################################################################
# 1) Wait for MySQL to be reachable
###############################################################################
MAX_WAIT=30
echo "[SEED] Waiting up to $MAX_WAIT seconds for MySQL ($DB_HOST:$DB_PORT) to accept connections..."
for i in $(seq 1 "$MAX_WAIT"); do
  if mysqladmin ping -h"$DB_HOST" -P"$DB_PORT" -u"$DB_ROOT_USER" -p"$DB_ROOT_PASS" --silent; then
    echo "[SEED] MySQL is available!"
    break
  fi
  echo -n "."
  sleep 1
  if [ "$i" -eq "$MAX_WAIT" ]; then
    echo "[SEED] ERROR: MySQL did not become available in time. Exiting."
    exit 1
  fi
done

###############################################################################
# 2) Import the Tripwire schema if needed
###############################################################################
if [ -f ./tripwire.sql ]; then
  echo "[SEED] Checking Tripwire DB status..."
  
  # Create DB if not exists:
  mysql -h"$DB_HOST" -P"$DB_PORT" -u"$DB_ROOT_USER" -p"$DB_ROOT_PASS" \
        -e "CREATE DATABASE IF NOT EXISTS \`${TRIPWIRE_DB}\`;"
  
  # Check if key tables already exist (accounts, signatures, wormholes)
  TABLE_COUNT=$(mysql -h"$DB_HOST" -P"$DB_PORT" -u"$DB_ROOT_USER" -p"$DB_ROOT_PASS" \
                -N -e "SELECT COUNT(table_name) FROM information_schema.tables 
                       WHERE table_schema='${TRIPWIRE_DB}' 
                       AND table_name IN ('accounts', 'signatures', 'wormholes');")
  
  if [ "$TABLE_COUNT" -eq "3" ]; then
    echo "[SEED] Key tables already exist in $TRIPWIRE_DB, skipping schema import."
  else
    echo "[SEED] Loading ./tripwire.sql into $TRIPWIRE_DB..."
    # Load the .sql
    mysql -h"$DB_HOST" -P"$DB_PORT" -u"$DB_ROOT_USER" -p"$DB_ROOT_PASS" \
          "$TRIPWIRE_DB" < ./tripwire.sql
    echo "[SEED] Tripwire schema imported into $TRIPWIRE_DB!"
  fi
else
  echo "[SEED] ERROR: tripwire.sql not found! Skipping."
fi

###############################################################################
# 3) Optionally fetch fuzzworks SDE & import it
###############################################################################
echo "[SEED] Checking Fuzzworks SDE logic..."

if [ -z "${SDE_DB:-}" ]; then
  echo "[SEED] SDE_DB is empty. Skipping SDE import."
  exit 0
fi

echo "[SEED] Creating $SDE_DB if not exists..."
mysql -h"$DB_HOST" -P"$DB_PORT" -u"$DB_ROOT_USER" -p"$DB_ROOT_PASS" \
      -e "CREATE DATABASE IF NOT EXISTS \`${SDE_DB}\`;"

# Check if SDE tables already exist
SDE_TABLE_COUNT=$(mysql -h"$DB_HOST" -P"$DB_PORT" -u"$DB_ROOT_USER" -p"$DB_ROOT_PASS" \
                  -N -e "SELECT COUNT(table_name) FROM information_schema.tables 
                         WHERE table_schema='${SDE_DB}' LIMIT 1;")

if [ "$SDE_TABLE_COUNT" -gt "0" ]; then
  echo "[SEED] SDE database already has tables. Skipping SDE import."
else
  echo "[SEED] Downloading fuzzworks SDE..."
  TEMP_DIR=$(mktemp -d)
  cd "$TEMP_DIR"
  
  if ! wget --no-verbose https://www.fuzzwork.co.uk/dump/mysql-latest.tar.bz2; then
    echo "[SEED] ERROR: Failed to download SDE data. Skipping."
    cd - > /dev/null
    rm -rf "$TEMP_DIR"
    exit 1
  fi
  
  echo "[SEED] Extracting SDE data..."
  if ! tar jxf mysql-latest.tar.bz2; then
    echo "[SEED] ERROR: Failed to extract SDE data. Skipping."
    cd - > /dev/null
    rm -rf "$TEMP_DIR"
    exit 1
  fi
  
  # Find the SQL file
  SQL_FILE=$(find . -name "*.sql" | head -1)
  
  if [ -z "$SQL_FILE" ]; then
    echo "[SEED] ERROR: No SQL file found in the SDE archive. Skipping."
    cd - > /dev/null
    rm -rf "$TEMP_DIR"
    exit 1
  fi
  
  echo "[SEED] Importing SDE data into $SDE_DB..."
  if mysql -h"$DB_HOST" -P"$DB_PORT" -u"$DB_ROOT_USER" -p"$DB_ROOT_PASS" "$SDE_DB" < "$SQL_FILE"; then
    echo "[SEED] SDE import complete!"
  else
    echo "[SEED] ERROR: Failed to import SDE data."
  fi
  
  # Clean up
  cd - > /dev/null
  rm -rf "$TEMP_DIR"
fi

echo "[SEED] All done!"
exit 0

