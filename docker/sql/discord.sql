-- Fork-owned: tables of the Discord notifications (discord/, docs: docker/README.md#discord-notifications).
-- Reference copy of DISCORD_DDL in discord/schema.php (keep in sync); discord_notify.worker.php and public/discord.php
-- create them on first use.

CREATE TABLE IF NOT EXISTS `discord_webhooks` (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `discord_settings` (
  `maskID` decimal(12,1) NOT NULL,
  `settings` mediumtext NOT NULL,
  `updatedBy` varchar(100) NOT NULL DEFAULT '',
  `updatedAt` datetime NOT NULL,
  PRIMARY KEY (`maskID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `discord_outbox` (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `discord_sent` (
  `maskID` decimal(12,1) NOT NULL,
  `kind` varchar(16) NOT NULL,
  `ref` varchar(64) NOT NULL,
  `createdAt` datetime NOT NULL,
  PRIMARY KEY (`maskID`, `kind`, `ref`),
  KEY `createdAt` (`createdAt`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `discord_rally` (
  `maskID` decimal(12,1) NOT NULL,
  `webhookID` int unsigned NOT NULL,
  `messageID` varchar(32) NOT NULL,
  `postedAt` datetime NOT NULL,
  PRIMARY KEY (`maskID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
