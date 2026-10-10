-- zKillboard integration (fork): tables of the pooled module in zkill/ (see docker/README.md#zkillboard-integration).
-- Reference only: zkill_feed.worker.php creates them on start and endpoints on first use (CREATE TABLE IF NOT EXISTS);
-- keep this file in sync with ZK_DDL in zkill/schema.php. Kill Reporting's zkill_kills / zkill_feed_state are in
-- kill-reporting.sql.

-- Every kill the instance knows about (stream: all of New Eden; back-fill: requested systems), pruned after
-- ZKILL_RETENTION_HOURS. attackerCount = attackers with a character (pilots), attackerTotal = all attackers.
-- `id` is the since-cursor handed to readers (monotonic, single writer: the worker); killID dedupes.
CREATE TABLE IF NOT EXISTS `zkill_killmails` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `killID` bigint unsigned NOT NULL,
  `systemID` int unsigned NOT NULL,
  `killTime` datetime NOT NULL,
  `receivedAt` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `source` varchar(8) NOT NULL DEFAULT 'feed',
  `hash` varchar(64) NOT NULL DEFAULT '',
  `victimCharacterID` bigint unsigned DEFAULT NULL,
  `victimCorporationID` bigint unsigned DEFAULT NULL,
  `victimAllianceID` bigint unsigned DEFAULT NULL,
  `victimShipTypeID` int unsigned DEFAULT NULL,
  `finalBlowCharacterID` bigint unsigned DEFAULT NULL,
  `finalBlowCorporationID` bigint unsigned DEFAULT NULL,
  `finalBlowAllianceID` bigint unsigned DEFAULT NULL,
  `finalBlowShipTypeID` int unsigned DEFAULT NULL,
  `attackerCount` smallint unsigned NOT NULL DEFAULT 0,
  `attackerTotal` smallint unsigned NOT NULL DEFAULT 0,
  `totalValue` decimal(20,2) NOT NULL DEFAULT 0,
  `npc` tinyint(1) NOT NULL DEFAULT 0,
  `solo` tinyint(1) NOT NULL DEFAULT 0,
  `awox` tinyint(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `killID` (`killID`),
  KEY `system_time` (`systemID`, `killTime`),
  KEY `system_id` (`systemID`, `id`),
  KEY `killTime` (`killTime`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Key/value state: stream.coveredSince (since when the stream has stored every kill without a gap) and
-- stream.highWater (up to when: upload time of the last processed killmail, or the time it was last caught up)
CREATE TABLE IF NOT EXISTS `zkill_state` (
  `name` varchar(64) NOT NULL,
  `value` varchar(255) NOT NULL,
  `updatedAt` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Back-fill queue, one row per system. Web endpoints queue (status 'queued'), the worker drains it
-- ('running' -> 'done' / 'failed'), highest priority first (chain 20 > panel 10), then oldest request.
-- coveredFrom..completedAt is the window the last successful back-fill covered; requestedBy = Tripwire userID.
CREATE TABLE IF NOT EXISTS `zkill_backfill` (
  `systemID` int unsigned NOT NULL,
  `windowSeconds` int unsigned NOT NULL,
  `status` varchar(8) NOT NULL DEFAULT 'queued',
  `priority` tinyint unsigned NOT NULL DEFAULT 10,
  `requestedBy` int unsigned NOT NULL DEFAULT 0,
  `requestedAt` datetime NOT NULL,
  `attemptedAt` datetime DEFAULT NULL,
  `completedAt` datetime DEFAULT NULL,
  `coveredFrom` datetime DEFAULT NULL,
  `attempts` smallint unsigned NOT NULL DEFAULT 0,
  `error` varchar(255) NOT NULL DEFAULT '',
  PRIMARY KEY (`systemID`),
  KEY `queue` (`status`, `priority`, `requestedAt`),
  KEY `requested_by` (`requestedBy`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ESI name cache (characters, corporations, alliances, types). name NULL = queued for the worker;
-- '' = ESI does not know the ID.
CREATE TABLE IF NOT EXISTS `zkill_names` (
  `id` bigint unsigned NOT NULL,
  `name` varchar(255) DEFAULT NULL,
  `category` varchar(32) NOT NULL DEFAULT '',
  `requestedAt` datetime NOT NULL,
  `resolvedAt` datetime DEFAULT NULL,
  `attempts` smallint unsigned NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `pending` (`resolvedAt`, `requestedAt`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Per-system zKillboard stats (System Threat, zkill/stats.php): a compact JSON cache entry per system, also the
-- queue (status 'queued' -> 'running' -> 'done' / 'failed'; chain 10 < detail 20). wantedAt = last time an
-- endpoint asked for the system (rows nobody asked for in 14 days are pruned).
CREATE TABLE IF NOT EXISTS `zkill_system_stats` (
  `systemID` int unsigned NOT NULL,
  `status` varchar(8) NOT NULL DEFAULT 'queued',
  `priority` tinyint unsigned NOT NULL DEFAULT 10,
  `requestedBy` int unsigned NOT NULL DEFAULT 0,
  `requestedAt` datetime NOT NULL,
  `wantedAt` datetime NOT NULL,
  `attemptedAt` datetime DEFAULT NULL,
  `fetchedAt` datetime DEFAULT NULL,
  `attempts` smallint unsigned NOT NULL DEFAULT 0,
  `error` varchar(255) NOT NULL DEFAULT '',
  `data` mediumtext DEFAULT NULL,
  PRIMARY KEY (`systemID`),
  KEY `queue` (`status`, `priority`, `requestedAt`),
  KEY `requested_by` (`requestedBy`, `status`),
  KEY `wanted` (`wantedAt`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
