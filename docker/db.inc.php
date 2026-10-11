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
