-- Kill Reporting (fork): tables used by zkill_feed.worker.php and public/kills.php.
-- Reference only: the worker creates them itself on start (CREATE TABLE IF NOT EXISTS); keep this file
-- in sync with ZKF_DDL in zkill_feed.worker.php.

-- Kills in chain systems, kept for 24 h. `id` is the cursor handed to browsers (monotonic, single writer);
-- `killID` dedupes kills that R2Z2 re-publishes under a new sequence.
CREATE TABLE IF NOT EXISTS `zkill_kills` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `killID` bigint unsigned NOT NULL,
  `systemID` int unsigned NOT NULL,
  `killTime` datetime NOT NULL,
  `receivedAt` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `victimCharacterID` bigint unsigned DEFAULT NULL,
  `victimCorporationID` bigint unsigned DEFAULT NULL,
  `victimAllianceID` bigint unsigned DEFAULT NULL,
  `victimShipTypeID` int unsigned DEFAULT NULL,
  `attackerCharacterCount` smallint unsigned NOT NULL DEFAULT 0,
  `attackerCorporationIDs` text NOT NULL,
  `finalBlowCharacterID` bigint unsigned DEFAULT NULL,
  `finalBlowShipTypeID` int unsigned DEFAULT NULL,
  `totalValue` decimal(20,2) NOT NULL DEFAULT 0,
  `solo` tinyint(1) NOT NULL DEFAULT 0,
  `hash` varchar(64) NOT NULL DEFAULT '',
  PRIMARY KEY (`id`),
  UNIQUE KEY `killID` (`killID`),
  KEY `receivedAt` (`receivedAt`),
  KEY `systemID` (`systemID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Single row (id = 1): the next R2Z2 sequence to fetch, so a restart resumes where it left off.
CREATE TABLE IF NOT EXISTS `zkill_feed_state` (
  `id` tinyint unsigned NOT NULL,
  `sequence` bigint unsigned NOT NULL,
  `updatedAt` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
