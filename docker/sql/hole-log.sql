-- Fork-owned: tables of Hole statistics (docs: docker/README.md#hole-statistics).
-- Reference copy of HOLESTATS_DDL / HOLESTATS_BACKFILL_DDL in holestats/holestats.inc.php (keep in sync); the tables are
-- created on first use.

-- One row per wormhole seen with one end in a mask's home system (Mask Admin > Discord > Home system): the home-side
-- signature id and type ('K162', a static type such as H296, '' = not known), the far system (0 = not known) and type,
-- when it was first seen and last updated (UTC). source: 'live' (recorded when it was saved) or 'backfill' (read once
-- from the audit log and the map); guessed = 1 when the backfill had to guess which end carried the type.
-- Kept for ever (research data, a few hundred bytes a hole).
CREATE TABLE IF NOT EXISTS `fork_hole_log` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `maskID` decimal(12,1) NOT NULL,
  `homeSystemID` int NOT NULL,
  `wormholeID` int NOT NULL DEFAULT 0,
  `auditID` bigint unsigned NULL DEFAULT NULL,
  `homeSig` varchar(10) NOT NULL DEFAULT '',
  `homeType` varchar(12) NOT NULL DEFAULT '',
  `farSystemID` int NOT NULL DEFAULT 0,
  `farSig` varchar(10) NOT NULL DEFAULT '',
  `farType` varchar(12) NOT NULL DEFAULT '',
  `firstSeen` datetime NOT NULL,
  `lastUpdated` datetime NOT NULL,
  `source` varchar(8) NOT NULL DEFAULT 'live',
  `guessed` tinyint NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `mask_audit` (`maskID`, `auditID`),
  KEY `mask_home` (`maskID`, `homeSystemID`, `firstSeen`),
  KEY `mask_wormhole` (`maskID`, `wormholeID`),
  KEY `mask_sig` (`maskID`, `homeSystemID`, `homeSig`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- The backfill ran for this mask and home (once; deleting the row lets it run again, which never duplicates rows)
CREATE TABLE IF NOT EXISTS `fork_hole_log_backfill` (
  `maskID` decimal(12,1) NOT NULL,
  `homeSystemID` int NOT NULL,
  `doneAt` datetime NOT NULL,
  `rows` int NOT NULL DEFAULT 0,
  PRIMARY KEY (`maskID`, `homeSystemID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
