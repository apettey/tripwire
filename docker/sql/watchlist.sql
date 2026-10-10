-- Fork-owned: tables of the Watchlist (watchlist/, docs: docker/README.md#watchlist).
-- Reference copy of WATCHLIST_DDL in watchlist/watchlist.inc.php (keep in sync); public/watchlist.php and
-- discord_notify.worker.php create them on first use.

-- Filters per mask: a JSON list of {id, name, enabled, conditions, updatedAt (unix), updatedBy}
CREATE TABLE IF NOT EXISTS `fork_watchlist` (
  `maskID` decimal(12,1) NOT NULL,
  `filters` mediumtext NOT NULL,
  `updatedBy` varchar(100) NOT NULL DEFAULT '',
  `updatedAt` datetime NOT NULL,
  PRIMARY KEY (`maskID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- The Discord type "Watchlist match": per mask and filter, the state the matches were last recorded for
CREATE TABLE IF NOT EXISTS `fork_watchlist_baseline` (
  `maskID` decimal(12,1) NOT NULL,
  `filterID` varchar(40) NOT NULL,
  `stamp` varchar(64) NOT NULL,
  `createdAt` datetime NOT NULL,
  PRIMARY KEY (`maskID`, `filterID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ... and every (filter, system, hole) seen matching since; kept while the hole exists
CREATE TABLE IF NOT EXISTS `fork_watchlist_seen` (
  `maskID` decimal(12,1) NOT NULL,
  `filterID` varchar(40) NOT NULL,
  `systemID` int NOT NULL,
  `wormholeID` int NOT NULL,
  `createdAt` datetime NOT NULL,
  PRIMARY KEY (`maskID`, `filterID`, `systemID`, `wormholeID`),
  KEY `wormhole` (`maskID`, `wormholeID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
