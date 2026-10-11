-- Fork-owned: tables of the Structures panel (docs: docker/README.md#structures).
-- Reference copy of STRUCTURES_DDL in structures/structures.inc.php (keep in sync); public/structures.php creates them
-- on first use. No foreign keys to upstream tables: the data is per mask and system.

CREATE TABLE IF NOT EXISTS fork_structures (
  id int unsigned NOT NULL AUTO_INCREMENT,
  maskID decimal(12,1) NOT NULL,
  systemID int NOT NULL,
  typeID int unsigned DEFAULT NULL,
  typeName varchar(100) NOT NULL,
  kind varchar(12) NOT NULL,
  name varchar(100) NOT NULL DEFAULT '',
  ownerID bigint unsigned DEFAULT NULL,
  ownerType varchar(12) DEFAULT NULL,
  ownerName varchar(255) DEFAULT NULL,
  ownerTicker varchar(10) DEFAULT NULL,
  ownerText varchar(100) DEFAULT NULL,
  state varchar(16) NOT NULL DEFAULT 'unknown',
  timerKind varchar(16) DEFAULT NULL,
  timerAt datetime DEFAULT NULL,
  timerSetBy varchar(100) DEFAULT NULL,
  timerSetAt datetime DEFAULT NULL,
  note varchar(500) NOT NULL DEFAULT '',
  firstSeenAt datetime NOT NULL,
  firstSeenBy varchar(100) DEFAULT NULL,
  lastSeenAt datetime NOT NULL,
  lastSeenBy varchar(100) DEFAULT NULL,
  lastDistanceKm double DEFAULT NULL,
  updatedAt datetime NOT NULL,
  updatedBy varchar(100) DEFAULT NULL,
  goneAt datetime DEFAULT NULL,
  goneBy varchar(100) DEFAULT NULL,
  PRIMARY KEY (id),
  KEY mask_system (maskID, systemID),
  KEY mask_timer (maskID, timerAt),
  KEY gone (goneAt)
) DEFAULT CHARSET=utf8mb4;

-- Rate limit: one row per write request (at most 20 per user per minute), pruned after 10 minutes
CREATE TABLE IF NOT EXISTS fork_structure_writes (
  userID int NOT NULL,
  at datetime NOT NULL,
  KEY user_at (userID, at)
) DEFAULT CHARSET=utf8mb4;
