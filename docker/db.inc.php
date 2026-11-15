<?php
// Docker DB connection: settings come from environment variables.

try {
    $mysql = new PDO(
        sprintf('mysql:host=%s;port=%s;dbname=%s;charset=utf8mb4',
            getenv('DB_HOST') ?: 'mysql',
            getenv('DB_PORT') ?: '3306',
            getenv('DB_NAME') ?: 'tripwire_database'),
        getenv('DB_USER') ?: 'tripwire',
        getenv('DB_PASSWORD') ?: '',
        Array(
            PDO::ATTR_PERSISTENT     => true
        )
    );
} catch (PDOException $error) {
    error_log($error->getMessage());
}

// Upstream 2.0 updates its own schema: tripwire.php runs db-update.php, which applies the diffs it has not applied yet
// with $mysql_update (once per diff, recorded in update_history; cache/db-update-state.php only saves the lookup).
// DB_UPDATE_USER / DB_UPDATE_PASSWORD: an account with ALTER, CREATE, INDEX, EVENT, SELECT, INSERT and UPDATE on the database. Unset = the app's
// own connection, which needs those rights then (the fork's own tables are already created by it on first use).
// See docker/README.md#database-updates.
if (isset($mysql) && !isset($mysql_update)) {
    $tw_update_user = getenv('DB_UPDATE_USER');
    if ($tw_update_user === false || $tw_update_user === '' || $tw_update_user === (getenv('DB_USER') ?: 'tripwire')) {
        $mysql_update = $mysql;
    } else {
        try {
            $mysql_update = new PDO(
                sprintf('mysql:host=%s;port=%s;dbname=%s;charset=utf8mb4',
                    getenv('DB_HOST') ?: 'mysql',
                    getenv('DB_PORT') ?: '3306',
                    getenv('DB_NAME') ?: 'tripwire_database'),
                $tw_update_user,
                getenv('DB_UPDATE_PASSWORD') ?: '',
                Array(PDO::ATTR_PERSISTENT => true, PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION)
            );
        } catch (PDOException $error) {
            error_log('DB_UPDATE_USER connection failed: ' . $error->getMessage());   // db-update.php stops with its own message
        }
    }
    unset($tw_update_user);
}

// Fork: keep the session mask canonical and re-check access to it on every request (mask-guard.inc.php).
require_once(__DIR__ . '/mask-guard.inc.php');
if (isset($mysql)) tripwire_mask_guard($mysql);
// Fork: mask admins / blocked members (see docker/README.md#mask-admins). Every endpoint loads this file, so this is the one
// place that drops a blocked character's session to their corp mask before anything reads $_SESSION['mask'].
// Cheap: one indexed query, and only when the session's mask is a custom mask.
if (isset($mysql) && $mysql instanceof PDO && is_file(__DIR__ . '/maskadmin/maskadmin.inc.php')) {
    require_once __DIR__ . '/maskadmin/maskadmin.inc.php';
    maskadmin_enforce_session($mysql);
}
