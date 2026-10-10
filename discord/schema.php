<?php
// Fork-owned: tables of the Discord notifications. Same DDL as docker/sql/discord.sql (keep in sync).

const DISCORD_DDL = [
    // Webhooks per mask. url holds the secret webhook URL, encrypted ('v1:...') when DISCORD_SECRET_KEY is set,
    // else 'plain:...'; it is never sent to a browser. urlHint is what the UI shows instead (e.g. '…/1234').
    // status 'broken' = Discord said the webhook is gone or the URL can't be decrypted; nothing is sent to it.
    "CREATE TABLE IF NOT EXISTS `discord_webhooks` (
      `id` int unsigned NOT NULL AUTO_INCREMENT,
      `maskID` decimal(12,1) NOT NULL,
      `name` varchar(100) NOT NULL,
      `url` text NOT NULL,
      `urlHint` varchar(32) NOT NULL DEFAULT '',
      `status` varchar(16) NOT NULL DEFAULT 'ok',
      `statusMessage` varchar(255) NOT NULL DEFAULT '',
      `lastSentAt` datetime DEFAULT NULL,
      `lastErrorAt` datetime DEFAULT NULL,
      `createdBy` varchar(100) NOT NULL DEFAULT '',
      `createdAt` datetime NOT NULL,
      `updatedAt` datetime NOT NULL,
      PRIMARY KEY (`id`),
      KEY `maskID` (`maskID`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci",
    // Settings per mask (JSON, normalised by discord_settings_normalise())
    "CREATE TABLE IF NOT EXISTS `discord_settings` (
      `maskID` decimal(12,1) NOT NULL,
      `settings` mediumtext NOT NULL,
      `updatedBy` varchar(100) NOT NULL DEFAULT '',
      `updatedAt` datetime NOT NULL,
      PRIMARY KEY (`maskID`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci",
    // Durable outbox: one row per message. discord_notify.worker.php sends 'queued' rows whose nextAttemptAt has
    // passed (higher priority first), then marks them 'sent' or 'failed'. data = JSON the message is rendered from.
    "CREATE TABLE IF NOT EXISTS `discord_outbox` (
      `id` bigint unsigned NOT NULL AUTO_INCREMENT,
      `maskID` decimal(12,1) NOT NULL,
      `webhookID` int unsigned NOT NULL,
      `kind` varchar(16) NOT NULL,
      `priority` tinyint unsigned NOT NULL DEFAULT 10,
      `data` mediumtext NOT NULL,
      `status` varchar(8) NOT NULL DEFAULT 'queued',
      `attempts` smallint unsigned NOT NULL DEFAULT 0,
      `nextAttemptAt` datetime NOT NULL,
      `createdAt` datetime NOT NULL,
      `sentAt` datetime DEFAULT NULL,
      `lastError` varchar(255) NOT NULL DEFAULT '',
      PRIMARY KEY (`id`),
      KEY `queue` (`status`, `nextAttemptAt`),
      KEY `webhook` (`webhookID`, `status`),
      KEY `mask` (`maskID`, `status`),
      KEY `createdAt` (`createdAt`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci",
    // Dedupe: what has been notified (or evaluated) per mask: 'kill:<type>' + killID, 'kspace' + 'sys:<id>'
    // (cooldown) and 'kspace' + 'wh:<wormholeID>:<systemID>' (one look per connection). Pruned after 7 days.
    "CREATE TABLE IF NOT EXISTS `discord_sent` (
      `maskID` decimal(12,1) NOT NULL,
      `kind` varchar(16) NOT NULL,
      `ref` varchar(64) NOT NULL,
      `createdAt` datetime NOT NULL,
      PRIMARY KEY (`maskID`, `kind`, `ref`),
      KEY `createdAt` (`createdAt`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci",
    // Rally point messages (discord/rally.php): the last one posted per mask, so changes within DISCORD_RALLY_WINDOW
    // edit it instead of posting another. Written only by the sender (discord_dispatch).
    "CREATE TABLE IF NOT EXISTS `discord_rally` (
      `maskID` decimal(12,1) NOT NULL,
      `webhookID` int unsigned NOT NULL,
      `messageID` varchar(32) NOT NULL,
      `postedAt` datetime NOT NULL,
      PRIMARY KEY (`maskID`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci",
];

function discord_ensure_schema(PDO $db) {
    foreach (DISCORD_DDL as $ddl) $db->exec($ddl);
}

/** Run $fn($db); if a discord_* table is missing (42S02), create the tables and run it once more */
function discord_with_schema(PDO $db, callable $fn) {
    try {
        return $fn($db);
    } catch (PDOException $error) {
        if ($error->getCode() !== '42S02') throw $error;
        discord_ensure_schema($db);
        return $fn($db);
    }
}
