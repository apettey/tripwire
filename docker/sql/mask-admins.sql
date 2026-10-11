-- Fork-owned: tables of the mask admins feature (docs: docker/README.md#mask-admins).
-- Reference copy of MASKADMIN_DDL in maskadmin/maskadmin.inc.php (keep in sync); the tables are created on first use.

-- Characters an owner / corp admin made admin of a custom mask (the owner and corp admins are not stored here)
CREATE TABLE IF NOT EXISTS `fork_mask_admins` (
  `maskID` decimal(12,1) NOT NULL,
  `characterID` int NOT NULL,
  `grantedBy` int NOT NULL,
  `grantedByName` varchar(50) NOT NULL DEFAULT '',
  `grantedAt` datetime NOT NULL,
  PRIMARY KEY (`maskID`, `characterID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Characters blocked from a custom mask, with the reason
CREATE TABLE IF NOT EXISTS `fork_mask_blocks` (
  `maskID` decimal(12,1) NOT NULL,
  `characterID` int NOT NULL,
  `characterName` varchar(50) NOT NULL DEFAULT '',
  `reason` varchar(200) NOT NULL DEFAULT '',
  `blockedBy` int NOT NULL,
  `blockedByName` varchar(50) NOT NULL DEFAULT '',
  `blockedAt` datetime NOT NULL,
  PRIMARY KEY (`maskID`, `characterID`),
  KEY `character` (`characterID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Mask-wide default settings: a JSON object {optionsKey: value}
CREATE TABLE IF NOT EXISTS `fork_mask_defaults` (
  `maskID` decimal(12,1) NOT NULL,
  `defaults` mediumtext NOT NULL,
  `updatedBy` varchar(50) NOT NULL DEFAULT '',
  `updatedAt` datetime NOT NULL,
  PRIMARY KEY (`maskID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Who did what (newest 500 per mask)
CREATE TABLE IF NOT EXISTS `fork_mask_audit` (
  `id` int NOT NULL AUTO_INCREMENT,
  `maskID` decimal(12,1) NOT NULL,
  `at` datetime NOT NULL,
  `actorID` int NOT NULL,
  `actorName` varchar(50) NOT NULL DEFAULT '',
  `action` varchar(20) NOT NULL,
  `targetID` int NOT NULL DEFAULT 0,
  `targetName` varchar(50) NOT NULL DEFAULT '',
  `detail` varchar(200) NOT NULL DEFAULT '',
  PRIMARY KEY (`id`),
  KEY `mask` (`maskID`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
