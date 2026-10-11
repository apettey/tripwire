-- Fork-owned: cyno-jammed systems marked by hand per mask, for the Jump planner (docs: docker/README.md).
-- Reference copy of the DDL in jumprange/jammed.inc.php (keep in sync); public/jump_jammed.php creates it on first use.
CREATE TABLE IF NOT EXISTS `fork_jump_jammed` (
  `maskID` decimal(12,1) NOT NULL,
  `systemID` int NOT NULL,
  `setBy` varchar(100) DEFAULT NULL,
  `setAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`maskID`, `systemID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
