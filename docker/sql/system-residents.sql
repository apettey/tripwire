-- Fork-owned: Set residents (Intel panel > Threat & residents; docs: docker/README.md#system-stats-system-threat).
-- Reference copy of system_residents_ensure_table() in system_residents.inc.php (keep in sync);
-- public/system_residents.php creates it on first use.

-- Who lives in a system, per mask: entities = JSON [{kind: corporation|alliance, id, name, ticker}] (at most 10,
-- names and tickers from ESI), note = plain text, setBy = character name
CREATE TABLE IF NOT EXISTS fork_system_residents (
  maskID decimal(12,1) NOT NULL,
  systemID int NOT NULL,
  entities text NOT NULL,
  note varchar(200) NOT NULL DEFAULT '',
  setBy varchar(100) DEFAULT NULL,
  setAt timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (maskID, systemID)
) DEFAULT CHARSET=utf8mb4;
