-- Fork-owned: table of the audit log (docs: docker/README.md#audit-log).
-- Reference copy of AUDIT_DDL in audit/audit.inc.php (keep in sync); the table is created on first use.

-- One row per signature / wormhole change: who (character id and name at the time), when (UTC), what (entity + action),
-- the system(s) it is about (a wormhole: both ends) and a small JSON summary or before/after in `detail`.
-- Rows older than AUDIT_LOG_DAYS (default 60) are deleted by audit_prune().
CREATE TABLE IF NOT EXISTS `fork_audit_log` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `maskID` decimal(12,1) NOT NULL,
  `at` datetime NOT NULL,
  `characterID` int NOT NULL,
  `characterName` varchar(50) NOT NULL DEFAULT '',
  `entity` varchar(10) NOT NULL,
  `action` varchar(10) NOT NULL,
  `systemID` int NOT NULL DEFAULT 0,
  `toSystemID` int NOT NULL DEFAULT 0,
  `subject` varchar(40) NOT NULL DEFAULT '',
  `detail` varchar(1000) NOT NULL DEFAULT '',
  PRIMARY KEY (`id`),
  KEY `mask` (`maskID`, `at`),
  KEY `mask_system` (`maskID`, `systemID`, `at`),
  KEY `at` (`at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
