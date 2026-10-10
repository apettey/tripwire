-- Fork-owned: table of the Watchlist (watchlist/, docs: docker/README.md#watchlist).
-- Reference copy of WATCHLIST_DDL in watchlist/watchlist.inc.php (keep in sync); public/watchlist.php creates it on
-- first use.

-- Filters per mask: a JSON list of {id, name, enabled, conditions, updatedAt (unix), updatedBy}
CREATE TABLE IF NOT EXISTS `fork_watchlist` (
  `maskID` decimal(12,1) NOT NULL,
  `filters` mediumtext NOT NULL,
  `updatedBy` varchar(100) NOT NULL DEFAULT '',
  `updatedAt` datetime NOT NULL,
  PRIMARY KEY (`maskID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
