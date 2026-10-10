<?php
// Fork-owned: checks that a fatal error inside the rally Discord lock still releases it (needs the dev database).
//   docker compose -f docker-compose.dev.yml exec -T app php tests/rally_discord_lock_test.php
// Expected output: "lock released after fatal error: yes" (the script itself ends with the deliberate fatal).
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }

require_once(__DIR__ . '/../rally_discord.inc.php');

function rally_lock_test_pdo() {
	$dsn = 'mysql:host=' . getenv('DB_HOST') . ';dbname=' . getenv('DB_NAME');
	return new PDO($dsn, getenv('DB_USER'), getenv('DB_PASSWORD'), array(PDO::ATTR_PERSISTENT => true));
}

$name = 'rally_discord_test_' . getmypid();
$mysql = rally_lock_test_pdo();
// A stale re-entrant hold from an earlier "request" on this connection
$mysql->query("SELECT GET_LOCK('$name', 0)");
if (!rally_discord_lock($mysql, $name, 5)) { echo "FAIL could not lock\n"; exit(1); }

// Registered after rally_discord_lock's shutdown function, so it runs after it: check from another connection
register_shutdown_function(function() use ($name) {
	$other = new PDO('mysql:host=' . getenv('DB_HOST') . ';dbname=' . getenv('DB_NAME'), getenv('DB_USER'), getenv('DB_PASSWORD'));
	$free = (int)$other->query("SELECT IS_FREE_LOCK('$name')")->fetchColumn() === 1;
	echo "\nlock released after fatal error: " . ($free ? 'yes' : 'NO') . "\n";
});

echo "locked, now dying inside the locked section (no finally runs)\n";
rally_discord_fatal_on_purpose();	// undefined function: fatal error
