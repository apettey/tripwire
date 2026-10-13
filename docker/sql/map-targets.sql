-- Fork-owned: region map targets per mask (systems marked for the whole mask, in order, with a note and an expiry; docs:
-- docker/README.md). Reference copy of the DDL in map_targets.inc.php (keep in sync); public/map_targets.php creates it on
-- first use. Times are unix seconds.
CREATE TABLE IF NOT EXISTS `fork_map_targets` (
  `maskID` decimal(12,1) NOT NULL,
  `systemID` int NOT NULL,
  `note` varchar(60) NOT NULL DEFAULT '',
  `ord` int NOT NULL DEFAULT 0,
  `createdByID` bigint NOT NULL DEFAULT 0,
  `createdByName` varchar(100) NOT NULL DEFAULT '',
  `created` int unsigned NOT NULL,
  `expires` int unsigned NOT NULL,
  PRIMARY KEY (`maskID`, `systemID`),
  KEY `expires` (`expires`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
