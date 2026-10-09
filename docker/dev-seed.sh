#!/usr/bin/env bash
# Local dev only: creates a Tripwire login without EVE SSO.
#
#   docker compose -f docker-compose.dev.yml exec app bash /opt/app/docker/dev-seed.sh
#
# Then log in at http://127.0.0.1:8080 on the "Tripwire" tab with DEV_USERNAME / DEV_PASSWORD.
# Login still looks the character up on public ESI, so DEV_CHARACTER must be a real character
# name; the account just borrows its public ID/corp (no tokens, no location tracking).
set -euo pipefail

DEV_USERNAME="${DEV_USERNAME:-dev}"
DEV_PASSWORD="${DEV_PASSWORD:-dev-password}"
DEV_CHARACTER="${DEV_CHARACTER:-Chribba}"

export MYSQL_PWD="$DB_PASSWORD"
db=(mariadb --ssl --skip-ssl-verify-server-cert -h"$DB_HOST" -P"${DB_PORT:-3306}" -u"$DB_USER" "$DB_NAME")

character_id=$(curl -sf -X POST "https://esi.evetech.net/latest/universe/ids/?datasource=tranquility" \
  -H "Content-Type: application/json" -d "[\"$DEV_CHARACTER\"]" \
  | php -r '$r = json_decode(stream_get_contents(STDIN)); echo $r->characters[0]->id ?? "";')
if [ -z "$character_id" ]; then
  echo "Could not resolve EVE character '$DEV_CHARACTER' on ESI" >&2
  exit 1
fi
corporation_id=$(curl -sf "https://esi.evetech.net/latest/characters/$character_id/?datasource=tranquility" \
  | php -r 'echo json_decode(stream_get_contents(STDIN))->corporation_id;')
corporation_name=$(curl -sf "https://esi.evetech.net/latest/corporations/$corporation_id/?datasource=tranquility" \
  | php -r 'echo json_decode(stream_get_contents(STDIN))->name;')

hash=$(DEV_PASSWORD="$DEV_PASSWORD" php -d display_errors=stderr -r 'require "/opt/app/password_hash.php"; $h = new PasswordHash(8, false); echo $h->HashPassword(getenv("DEV_PASSWORD"));')

sql_quote() { printf "'%s'" "${1//\'/\'\'}"; }

"${db[@]}" <<SQL
INSERT INTO accounts (username, password) VALUES ($(sql_quote "$DEV_USERNAME"), $(sql_quote "$hash"))
  ON DUPLICATE KEY UPDATE password = VALUES(password);
SET @uid = (SELECT id FROM accounts WHERE username = $(sql_quote "$DEV_USERNAME"));
DELETE FROM characters WHERE userID = @uid OR characterID = $character_id;
INSERT INTO characters (userID, characterID, characterName, corporationID, corporationName)
  VALUES (@uid, $character_id, $(sql_quote "$DEV_CHARACTER"), $corporation_id, $(sql_quote "$corporation_name"));
SQL

echo "Dev login ready: user '$DEV_USERNAME' (character $DEV_CHARACTER, $character_id, corp $corporation_name)"
