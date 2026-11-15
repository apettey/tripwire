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

// cache/db-update-state.php counts the diffs that ran; it lives in the cache volume, so it outlives a database restore
// (db-update.php would then skip diffs the restored database never had). It can also lag behind: db-update.php only
// writes it after running a diff, not after skipping one already in update_history, so a lost file stays at 1 and every
// map load re-checks the rest. On the map page only (the one page that runs db-update.php; polls pay nothing), set the
// file to the index of the first diff whose name update_history doesn't have, whenever the two differ. Under the file's
// lock, which db-update.php also takes. A restored pre-2.0 backup keeps the newer update_history table: see
// docker/README.md#database-updates.
if (isset($mysql) && $mysql instanceof PDO && in_array(__DIR__ . '/tripwire.php', get_included_files(), true)) {
    (function (PDO $db, $stateFile) {
        if (!is_file($stateFile)) return;   // first run: db-update.php starts from 0
        // The diff names in their order, read from db-update.php (it runs its update when loaded, so it isn't included here)
        if (!preg_match_all("/\\['name'\\s*=>\\s*'([^']*)'/", (string)@file_get_contents(__DIR__ . '/db-update.php'), $names)) return;
        $fp = @fopen($stateFile, 'c+');
        if (!$fp) return;
        if (flock($fp, LOCK_EX)) {
            try {
                $done = array_flip($db->query('SELECT diff_name FROM update_history')->fetchAll(PDO::FETCH_COLUMN));
            } catch (Throwable $e) {
                $done = [];   // no update_history: a database from before 2.0
            }
            // The next diff to run: the first one in the list that update_history doesn't have
            $applied = count($names[1]);
            foreach ($names[1] as $i => $name) { if (!isset($done[$name])) { $applied = $i; break; } }
            $claimed = preg_match('/\$version\s*=\s*(\d+)/', (string)stream_get_contents($fp), $m) ? (int)$m[1] : 0;
            if ($claimed !== $applied) {
                if ($applied < $claimed) error_log("db-update: next diff by update_history is $applied, the state file claimed $claimed; checking again");
                ftruncate($fp, 0);
                rewind($fp);
                fwrite($fp, '<?php $version = ' . $applied . ';');
                fflush($fp);
            }
            flock($fp, LOCK_UN);
        }
        fclose($fp);
    })($mysql, __DIR__ . '/cache/db-update-state.php');
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
