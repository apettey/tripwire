-- Fork-owned: system status colour, occupier and alias (docs: docker/README.md).
-- Reference copy of system_status_ensure_table() in system_status.inc.php (keep in sync);
-- public/system_status.php creates it on first use.

-- Per mask and solar system (not per signature or hole): status = friendly|hostile|active|empty|unscanned or NULL,
-- alias <= 24 characters, occupier <= 60 characters (free text), setBy = character name of the last change
CREATE TABLE IF NOT EXISTS fork_system_status (
  maskID decimal(12,1) NOT NULL,
  systemID int NOT NULL,
  status varchar(12) DEFAULT NULL,
  alias varchar(24) NOT NULL DEFAULT '',
  occupier varchar(60) NOT NULL DEFAULT '',
  setBy varchar(100) DEFAULT NULL,
  setAt timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (maskID, systemID)
) DEFAULT CHARSET=utf8mb4;
