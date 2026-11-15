-- Tripwire cumulative in-place database update
--
-- Run this against an existing Tripwire database after taking a backup:
--   mysql --database=tripwire_database < tripwire_update.sql
--
-- This file never drops, truncates, or recreates application tables. MySQL DDL
-- commits implicitly, so a backup is still required before running it.

-- Stored objects retain the character set and SQL mode in effect when they are
-- created. Match the canonical schema, then restore the caller's session below.
SET @tripwire_old_character_set_client := @@SESSION.character_set_client;
SET @tripwire_old_character_set_results := @@SESSION.character_set_results;
SET @tripwire_old_collation_connection := @@SESSION.collation_connection;
SET @tripwire_old_sql_mode := @@SESSION.sql_mode;
SET NAMES utf8mb4;
SET SESSION sql_mode = 'NO_AUTO_VALUE_ON_ZERO';

SET @tripwire_database := DATABASE();

DELIMITER ;;

DROP PROCEDURE IF EXISTS `tripwire_require_database`;;
CREATE PROCEDURE `tripwire_require_database`()
BEGIN
    IF @tripwire_database IS NULL OR @tripwire_database = '' THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Select the Tripwire database before running tripwire_update.sql';
    END IF;
END;;
CALL `tripwire_require_database`();;
DROP PROCEDURE `tripwire_require_database`;;

-- Add an index only when no index with the same ordered columns already exists.
DROP PROCEDURE IF EXISTS `tripwire_add_index`;;
CREATE PROCEDURE `tripwire_add_index`(
    IN table_name_in VARCHAR(64),
    IN index_name_in VARCHAR(64),
    IN columns_in VARCHAR(255)
)
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM (
                SELECT INDEX_NAME,
                       GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') AS indexed_columns
                  FROM information_schema.STATISTICS
                 WHERE TABLE_SCHEMA = @tripwire_database
                   AND TABLE_NAME = table_name_in
                 GROUP BY INDEX_NAME
               ) AS existing_indexes
         WHERE existing_indexes.indexed_columns = columns_in
    ) THEN
        SET @tripwire_ddl = CONCAT(
            'ALTER TABLE `', REPLACE(table_name_in, '`', '``'),
            '` ADD INDEX `', REPLACE(index_name_in, '`', '``'),
            '` (`', REPLACE(columns_in, ',', '`,`'), '`)'
        );
        PREPARE tripwire_statement FROM @tripwire_ddl;
        EXECUTE tripwire_statement;
        DEALLOCATE PREPARE tripwire_statement;
    END IF;
END;;

DELIMITER ;

-- Column changes introduced since the original self-hosted schema. These are
-- widening changes and retain existing values.
ALTER TABLE `tracking`
    MODIFY COLUMN `shipID` BIGINT NULL;

ALTER TABLE `esi`
    MODIFY COLUMN `accessToken` VARCHAR(3000) NOT NULL,
    MODIFY COLUMN `refreshToken` VARCHAR(1000) NOT NULL;

ALTER TABLE `tokens`
    MODIFY COLUMN `token` VARCHAR(400) NOT NULL;

ALTER TABLE `signatures`
    MODIFY COLUMN `name` VARCHAR(100) CHARACTER SET utf8mb4 DEFAULT NULL;

-- Indexes added by later Tripwire releases. Existing equivalent indexes are
-- retained even when they have an older name.
CALL `tripwire_add_index`('esi', 'characterID', 'characterID');
CALL `tripwire_add_index`('esi', 'userID', 'userID');
CALL `tripwire_add_index`('comments', 'system_mask_idx', 'maskID,systemID');
CALL `tripwire_add_index`('signatures', 'system_mask_idx', 'systemID,maskID');
CALL `tripwire_add_index`('signatures', 'life_idx', 'lifeLeft,lifeLength');
CALL `tripwire_add_index`('signatures', 'type', 'type');
CALL `tripwire_add_index`('system_activity', 'time_idx', 'time');
CALL `tripwire_add_index`('tracking', 'system_mask_idx', 'maskID,systemID');
CALL `tripwire_add_index`('wormholes', 'initialID', 'initialID');
CALL `tripwire_add_index`('wormholes', 'secondaryID', 'secondaryID');
CALL `tripwire_add_index`('_history_signatures', 'systemID', 'systemID');
CALL `tripwire_add_index`('_history_signatures', 'id', 'id');
CALL `tripwire_add_index`('_history_signatures', 'maskID', 'maskID');
CALL `tripwire_add_index`('_history_signatures', 'status', 'status');
CALL `tripwire_add_index`('_history_wormholes', 'id_index', 'id');
CALL `tripwire_add_index`('_history_wormholes', 'mask_index', 'maskID');

DROP PROCEDURE `tripwire_add_index`;

-- Refresh triggers without carrying a dump server's DEFINER account.
DROP TRIGGER IF EXISTS `trackingRemove`;
DELIMITER ;;
CREATE TRIGGER `trackingRemove`
AFTER DELETE ON `esi`
FOR EACH ROW
BEGIN
    DELETE FROM tracking WHERE characterID = OLD.characterID;
END;;
DELIMITER ;

DROP TRIGGER IF EXISTS `systemVisits`;
DELIMITER ;;
CREATE TRIGGER `systemVisits`
AFTER UPDATE ON `tracking`
FOR EACH ROW
BEGIN
    IF NEW.systemID <> OLD.systemID THEN
        INSERT INTO system_visits (userID, characterID, systemID, date)
        VALUES (NEW.userID, NEW.characterID, NEW.systemID, NOW());
    END IF;
END;;
DELIMITER ;

DROP TRIGGER IF EXISTS `jumpHistory`;
DELIMITER ;;
CREATE TRIGGER `jumpHistory`
AFTER UPDATE ON `tracking`
FOR EACH ROW
BEGIN
    IF NEW.systemID <> OLD.systemID THEN
        SET @wormholeID = (
            SELECT w.id
              FROM wormholes w
              INNER JOIN signatures a ON w.initialID = a.id
              INNER JOIN signatures b ON w.secondaryID = b.id
             WHERE (a.systemID = NEW.systemID OR b.systemID = NEW.systemID)
               AND (a.systemID = OLD.systemID OR b.systemID = OLD.systemID)
             LIMIT 1
        );

        IF @wormholeID IS NOT NULL THEN
            INSERT INTO jumps (
                wormholeID, characterID, characterName,
                toID, toName, fromID, fromName,
                shipTypeID, shipType, maskID
            ) VALUES (
                @wormholeID, NEW.characterID, NEW.characterName,
                NEW.systemID, NEW.systemName,
                OLD.systemID, OLD.systemName,
                NEW.shipTypeID, NEW.shipTypeName, NEW.maskID
            );
        END IF;
    END IF;
END;;
DELIMITER ;

-- Refresh scheduled maintenance events. No application tables are dropped.
DROP EVENT IF EXISTS `activeClean`;
DELIMITER ;;
CREATE EVENT `activeClean`
ON SCHEDULE EVERY 15 SECOND
STARTS CURRENT_TIMESTAMP
ON COMPLETION NOT PRESERVE
ENABLE
DO
    DELETE FROM active WHERE time < NOW() - INTERVAL 15 SECOND;;
DELIMITER ;

DROP EVENT IF EXISTS `flaresClean`;
DELIMITER ;;
CREATE EVENT `flaresClean`
ON SCHEDULE EVERY 1 HOUR
STARTS CURRENT_TIMESTAMP
ON COMPLETION NOT PRESERVE
ENABLE
DO
    DELETE FROM flares WHERE time < NOW() - INTERVAL 24 HOUR;;
DELIMITER ;

DROP EVENT IF EXISTS `jumpsClean`;
DELIMITER ;;
CREATE EVENT `jumpsClean`
ON SCHEDULE EVERY 1 HOUR
STARTS CURRENT_TIMESTAMP
ON COMPLETION NOT PRESERVE
ENABLE
DO
    DELETE FROM jumps
     WHERE wormholeID NOT IN (
         SELECT id FROM wormholes WHERE type <> 'GATE'
     );;
DELIMITER ;

DROP EVENT IF EXISTS `signatureClean`;
DELIMITER ;;
CREATE EVENT `signatureClean`
ON SCHEDULE EVERY 1 MINUTE
STARTS CURRENT_TIMESTAMP
ON COMPLETION NOT PRESERVE
ENABLE
DO
BEGIN
    UPDATE signatures
       SET modifiedByID = 0,
           modifiedByName = 'Tripwire'
     WHERE lifeLeft < NOW()
       AND lifeLength <> 0
       AND type <> 'wormhole';

    DELETE FROM signatures
     WHERE lifeLeft < NOW()
       AND lifeLength <> 0
       AND type <> 'wormhole';
END;;
DELIMITER ;

DROP EVENT IF EXISTS `trackingClean`;
DELIMITER ;;
CREATE EVENT `trackingClean`
ON SCHEDULE EVERY 15 SECOND
STARTS CURRENT_TIMESTAMP
ON COMPLETION NOT PRESERVE
ENABLE
DO
    DELETE FROM tracking
     WHERE userID NOT IN (SELECT userID FROM active);;
DELIMITER ;

DROP EVENT IF EXISTS `wormholeClean`;
DELIMITER ;;
CREATE EVENT `wormholeClean`
ON SCHEDULE EVERY 1 MINUTE
STARTS CURRENT_TIMESTAMP
ON COMPLETION NOT PRESERVE
ENABLE
DO
BEGIN
    UPDATE signatures s
    INNER JOIN wormholes w
       ON (s.id = w.initialID OR s.id = w.secondaryID)
      AND w.life = 'stable'
       SET s.modifiedByID = 0,
           s.modifiedByName = 'Tripwire',
           s.modifiedTime = NOW()
     WHERE s.type = 'wormhole'
       AND s.lifeLength <> 0
       AND s.lifeLeft < NOW() + INTERVAL 4 HOUR;

    UPDATE wormholes w
    INNER JOIN signatures s
       ON (s.id = w.initialID OR s.id = w.secondaryID)
      AND s.type = 'wormhole'
      AND w.life = 'stable'
      AND s.lifeLength <> 0
      AND s.lifeLeft < NOW() + INTERVAL 4 HOUR
       SET w.life = 'critical';

    DELETE FROM signatures
     WHERE lifeLeft < NOW() - INTERVAL 0.1 * lifeLength SECOND
       AND lifeLength <> 0
       AND type = 'wormhole';

    DELETE FROM wormholes
     WHERE NOT EXISTS (
               SELECT 1 FROM signatures s WHERE s.id = wormholes.secondaryID
           )
        OR NOT EXISTS (
               SELECT 1 FROM signatures s WHERE s.id = wormholes.initialID
           );
END;;
DELIMITER ;

DROP EVENT IF EXISTS `wormholeCritical`;
DELIMITER ;;
CREATE EVENT `wormholeCritical`
ON SCHEDULE EVERY 1 MINUTE
STARTS CURRENT_TIMESTAMP
ON COMPLETION NOT PRESERVE
ENABLE
DO
BEGIN
    UPDATE signatures s
    INNER JOIN wormholes w
       ON (s.id = w.initialID OR s.id = w.secondaryID)
      AND w.life = 'stable'
       SET s.modifiedByID = 0,
           s.modifiedByName = 'Tripwire',
           s.modifiedTime = NOW()
     WHERE s.type = 'wormhole'
       AND s.lifeLength <> 0
       AND s.lifeLeft < NOW() + INTERVAL 4 HOUR;

    UPDATE wormholes w
    INNER JOIN signatures s
       ON (s.id = w.initialID OR s.id = w.secondaryID)
      AND s.type = 'wormhole'
      AND w.life = 'stable'
      AND s.lifeLength <> 0
      AND s.lifeLeft < NOW() + INTERVAL 4 HOUR
       SET w.life = 'critical';
END;;
DELIMITER ;

-- The server must have event_scheduler=ON for these events to execute.
SELECT @@event_scheduler AS event_scheduler;

SET SESSION sql_mode = @tripwire_old_sql_mode;
SET SESSION character_set_client = @tripwire_old_character_set_client;
SET SESSION character_set_results = @tripwire_old_character_set_results;
SET SESSION collation_connection = @tripwire_old_collation_connection;
