<?php

try {
    $mysql = new PDO(
        'mysql:host=mysql;dbname=tripwire_database;charset=utf8',
        'usernamefromdockercompose',
        'userpasswordfromdockercompose',
        Array(
            PDO::ATTR_PERSISTENT     => true,
            // Fail loudly. Without this a failed query returns false and the
            // app carries on with no data, which reads as "empty" rather than
            // "broken" -- a dead database looks like a quiet one.
            PDO::ATTR_ERRMODE        => PDO::ERRMODE_EXCEPTION
            // NOTE: do not set PDO::ATTR_EMULATE_PREPARES => false here.
            // Fifteen queries in this codebase bind one named placeholder that
            // appears twice in the statement (login.php:80, refresh.php:135
            // and :228, lib.inc.php:42, masks.inc.php:23 among others).
            // Client-side emulation tolerates that; native prepares reject it
            // with "Invalid parameter number", which breaks login and the
            // refresh poll. Those queries must be rewritten first.
        )
    );
} catch (PDOException $error) {
    // Do not continue with an unset $mysql: every later query would fatal with
    // a confusing error a long way from the actual cause.
    error_log('Tripwire: database connection failed: ' . $error->getMessage());
    http_response_code(503);
    exit('Database unavailable');
}
