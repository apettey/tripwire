-- tripwire.sql
-- Updated for MySQL 8.4.4 LTS
-- Using newer utf8mb4_0900_ai_ci collation, optimized indexes, and proper foreign key constraints

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;

--
-- Table structure for table `_history_login`
--

DROP TABLE IF EXISTS `_history_login`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `_history_login` (
  `ip` varchar(42) NOT NULL,
  `username` varchar(25) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL,
  `method` enum('user','api','cookie','sso') NOT NULL,
  `result` enum('success','fail') NOT NULL,
  `time` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`ip`,`time`),
  KEY `username` (`username`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `_history_signatures`
--

DROP TABLE IF EXISTS `_history_signatures`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `_history_signatures` (
  `historyID` int NOT NULL AUTO_INCREMENT,
  `id` int NOT NULL,
  `signatureID` char(6) DEFAULT NULL,
  `systemID` int DEFAULT NULL,
  `type` enum('unknown','combat','data','relic','ore','gas','wormhole') NOT NULL,
  `name` varchar(100) DEFAULT NULL,
  `bookmark` varchar(100) DEFAULT NULL,
  `lifeTime` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `lifeLeft` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `lifeLength` int NOT NULL,
  `createdByID` int NOT NULL,
  `createdByName` varchar(100) NOT NULL,
  `modifiedByID` int NOT NULL,
  `modifiedByName` varchar(100) NOT NULL,
  `modifiedTime` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `maskID` decimal(12,1) NOT NULL,
  `status` enum('add','update','delete','undo:add','undo:update','undo:delete') NOT NULL,
  PRIMARY KEY (`historyID`),
  KEY `systemID` (`systemID`) USING BTREE,
  KEY `id` (`id`) USING BTREE,
  KEY `maskID` (`maskID`) USING BTREE,
  KEY `status` (`status`) USING BTREE
) ENGINE=InnoDB AUTO_INCREMENT=0 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `_history_wormholes`
--

DROP TABLE IF EXISTS `_history_wormholes`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `_history_wormholes` (
  `historyID` int NOT NULL AUTO_INCREMENT,
  `id` int NOT NULL,
  `initialID` int NOT NULL,
  `secondaryID` int NOT NULL,
  `type` char(4) DEFAULT NULL,
  `parent` char(9) DEFAULT NULL,
  `life` enum('stable','critical') NOT NULL,
  `mass` enum('stable','destab','critical') NOT NULL,
  `maskID` decimal(12,1) NOT NULL,
  `status` enum('add','update','delete','undo:add','undo:update','undo:delete') NOT NULL,
  PRIMARY KEY (`historyID`),
  KEY `id_index` (`id`) USING BTREE,
  KEY `mask_index` (`maskID`) USING BTREE
) ENGINE=InnoDB AUTO_INCREMENT=0 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `accounts`
--

DROP TABLE IF EXISTS `accounts`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `accounts` (
  `id` int NOT NULL AUTO_INCREMENT,
  `username` varchar(25) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  `password` char(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `ban` tinyint NOT NULL DEFAULT '0',
  `super` tinyint NOT NULL DEFAULT '0',
  `created` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `logins` int NOT NULL DEFAULT '0',
  `lastLogin` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `username` (`username`) USING BTREE,
  KEY `ban` (`ban`) USING BTREE
) ENGINE=InnoDB AUTO_INCREMENT=0 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `active`
--

DROP TABLE IF EXISTS `active`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `active` (
  `ip` char(42) NOT NULL,
  `instance` decimal(13,3) NOT NULL DEFAULT '0.000',
  `session` char(50) NOT NULL,
  `userID` mediumint NOT NULL,
  `maskID` decimal(12,1) NOT NULL,
  `systemID` int DEFAULT NULL,
  `systemName` char(50) DEFAULT NULL,
  `activity` char(25) DEFAULT NULL,
  `notify` char(150) DEFAULT NULL,
  `version` varchar(100) DEFAULT NULL,
  `time` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`ip`,`instance`,`session`,`userID`),
  KEY `notify` (`notify`) USING BTREE,
  KEY `activity` (`activity`) USING BTREE,
  KEY `instance` (`instance`) USING BTREE,
  KEY `maskID` (`maskID`) USING BTREE,
  KEY `time` (`time`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `characters`
--

DROP TABLE IF EXISTS `characters`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `characters` (
  `userID` int NOT NULL,
  `characterID` int NOT NULL,
  `characterName` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `corporationID` int NOT NULL,
  `corporationName` varchar(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `admin` tinyint NOT NULL DEFAULT '0',
  `ban` tinyint NOT NULL DEFAULT '0',
  `added` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`userID`),
  UNIQUE KEY `characterID` (`characterID`) USING BTREE,
  KEY `ban` (`ban`) USING BTREE,
  KEY `admin` (`admin`) USING BTREE,
  KEY `corporationID` (`corporationID`) USING BTREE,
  CONSTRAINT `characters_ibfk_1` FOREIGN KEY (`userID`) REFERENCES `accounts` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `comments`
--

DROP TABLE IF EXISTS `comments`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `comments` (
  `id` int NOT NULL AUTO_INCREMENT,
  `systemID` int NOT NULL,
  `comment` text NOT NULL,
  `created` datetime NOT NULL,
  `createdByID` int NOT NULL,
  `createdByName` varchar(100) NOT NULL,
  `modified` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `modifiedByID` int NOT NULL,
  `modifiedByName` varchar(100) NOT NULL,
  `maskID` decimal(12,2) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `maskID` (`maskID`) USING BTREE,
  KEY `system_mask_idx` (`maskID`,`systemID`) USING BTREE
) ENGINE=InnoDB AUTO_INCREMENT=0 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `esi`
--

DROP TABLE IF EXISTS `esi`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `esi` (
  `userID` int NOT NULL,
  `characterID` int NOT NULL,
  `characterName` varchar(100) NOT NULL,
  `accessToken` varchar(3000) NOT NULL,
  `refreshToken` varchar(1000) NOT NULL,
  `tokenExpire` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`userID`,`characterID`),
  KEY `characterID` (`characterID`) USING BTREE,
  KEY `userID` (`userID`) USING BTREE,
  CONSTRAINT `esi_ibfk_1` FOREIGN KEY (`userID`) REFERENCES `accounts` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Trigger: trackingRemove (Remove DEFINER, use plain CREATE TRIGGER)
--

DELIMITER ;;
CREATE TRIGGER `trackingRemove`
AFTER DELETE ON `esi`
FOR EACH ROW
BEGIN
    DELETE FROM tracking WHERE characterID = OLD.characterID;
END;;
DELIMITER ;

--
-- Table structure for table `flares`
--

DROP TABLE IF EXISTS `flares`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `flares` (
  `maskID` decimal(12,1) NOT NULL,
  `systemID` int NOT NULL,
  `flare` enum('red','yellow','green') NOT NULL,
  `time` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`maskID`,`systemID`),
  KEY `time` (`time`) USING BTREE,
  KEY `maskID` (`maskID`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `groups`
--

DROP TABLE IF EXISTS `groups`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `groups` (
  `maskID` decimal(12,1) NOT NULL,
  `joined` tinyint NOT NULL DEFAULT '0',
  `eveID` int NOT NULL,
  `eveType` smallint NOT NULL,
  PRIMARY KEY (`maskID`,`eveType`,`eveID`),
  KEY `joined` (`joined`) USING BTREE,
  KEY `eveType` (`eveType`) USING BTREE,
  KEY `eveID` (`eveID`) USING BTREE,
  KEY `maskID` (`maskID`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `jumps`
--

DROP TABLE IF EXISTS `jumps`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `jumps` (
  `wormholeID` int NOT NULL,
  `characterID` int NOT NULL,
  `characterName` varchar(50) NOT NULL,
  `fromID` int NOT NULL,
  `fromName` varchar(20) DEFAULT NULL,
  `toID` int NOT NULL,
  `toName` varchar(20) DEFAULT NULL,
  `shipTypeID` int DEFAULT NULL,
  `shipType` varchar(50) DEFAULT NULL,
  `maskID` decimal(12,1) NOT NULL DEFAULT '0.0',
  `time` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY `shipTypeID` (`shipTypeID`) USING BTREE,
  KEY `maskID` (`maskID`) USING BTREE,
  KEY `wormholeID` (`wormholeID`) USING BTREE,
  KEY `time` (`time`) USING BTREE,
  KEY `massSearch` (`maskID`,`wormholeID`,`time`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `masks`
--

DROP TABLE IF EXISTS `masks`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `masks` (
  `maskID` decimal(12,1) NOT NULL,
  `name` varchar(100) NOT NULL,
  `ownerID` int NOT NULL,
  `ownerType` smallint NOT NULL,
  PRIMARY KEY (`maskID`),
  UNIQUE KEY `name` (`name`,`ownerID`,`ownerType`) USING BTREE,
  KEY `ownerID` (`ownerID`) USING BTREE,
  KEY `ownerType` (`ownerType`) USING BTREE,
  KEY `maskSearch` (`maskID`,`ownerType`,`ownerID`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci ROW_FORMAT=COMPACT;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `preferences`
--

DROP TABLE IF EXISTS `preferences`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `preferences` (
  `userID` int NOT NULL,
  `options` json DEFAULT NULL,
  PRIMARY KEY (`userID`),
  CONSTRAINT `preferences_ibfk_1` FOREIGN KEY (`userID`) REFERENCES `accounts` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `signatures`
--

DROP TABLE IF EXISTS `signatures`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `signatures` (
  `id` int NOT NULL AUTO_INCREMENT,
  `signatureID` char(6) DEFAULT NULL,
  `systemID` int DEFAULT NULL,
  `type` enum('unknown','combat','data','relic','ore','gas','wormhole') NOT NULL,
  `name` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL,
  `bookmark` varchar(100) DEFAULT NULL,
  `lifeTime` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `lifeLeft` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `lifeLength` int NOT NULL,
  `createdByID` int NOT NULL,
  `createdByName` varchar(100) NOT NULL,
  `modifiedByID` int NOT NULL,
  `modifiedByName` varchar(100) NOT NULL,
  `modifiedTime` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `maskID` decimal(12,1) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `system_mask_idx` (`systemID`,`maskID`) USING BTREE,
  KEY `modifiedTime` (`modifiedTime`) USING BTREE,
  KEY `maskID` (`maskID`) USING BTREE,
  KEY `life_idx` (`lifeLeft`,`lifeLength`) USING BTREE,
  KEY `type` (`type`) USING BTREE
) ENGINE=InnoDB AUTO_INCREMENT=0 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `statistics`
--

DROP TABLE IF EXISTS `statistics`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `statistics` (
  `userID` int NOT NULL,
  `characterID` int NOT NULL,
  `maskID` decimal(12,1) NOT NULL,
  `signatures_added` int NOT NULL DEFAULT '0',
  `signatures_updated` int NOT NULL DEFAULT '0',
  `signatures_deleted` int NOT NULL DEFAULT '0',
  `wormholes_added` int NOT NULL DEFAULT '0',
  `wormholes_updated` int NOT NULL DEFAULT '0',
  `wormholes_deleted` int NOT NULL DEFAULT '0',
  `comments_added` int NOT NULL DEFAULT '0',
  `comments_updated` int NOT NULL DEFAULT '0',
  `comments_deleted` int NOT NULL DEFAULT '0',
  PRIMARY KEY (`userID`,`characterID`,`maskID`),
  CONSTRAINT `statistics_ibfk_1` FOREIGN KEY (`userID`) REFERENCES `accounts` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `system_activity`
--

DROP TABLE IF EXISTS `system_activity`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `system_activity` (
  `systemID` int NOT NULL,
  `time` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `shipJumps` mediumint NOT NULL DEFAULT '0',
  `shipKills` mediumint NOT NULL DEFAULT '0',
  `podKills` mediumint NOT NULL DEFAULT '0',
  `npcKills` mediumint NOT NULL DEFAULT '0',
  PRIMARY KEY (`systemID`,`time`),
  KEY `time_idx` (`time`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `system_visits`
--

DROP TABLE IF EXISTS `system_visits`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `system_visits` (
  `userID` int NOT NULL,
  `characterID` int NOT NULL,
  `systemID` int NOT NULL,
  `date` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`userID`,`characterID`,`systemID`,`date`),
  CONSTRAINT `system_visits_ibfk_1` FOREIGN KEY (`userID`) REFERENCES `accounts` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci ROW_FORMAT=COMPACT;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `tokens`
--

DROP TABLE IF EXISTS `tokens`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `tokens` (
  `userID` int NOT NULL,
  `token` varchar(400) NOT NULL,
  PRIMARY KEY (`userID`),
  CONSTRAINT `tokens_ibfk_1` FOREIGN KEY (`userID`) REFERENCES `accounts` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `tracking`
--

DROP TABLE IF EXISTS `tracking`;
/*!40101 SET @saved_cs_client      = @@character_set_client */;
/*!40101 SET character_set_client  = utf8mb4 */;
CREATE TABLE `tracking` (
  `userID` int NOT NULL,
  `characterID` int NOT NULL,
  `characterName` varchar(100) NOT NULL,
  `systemID` int NOT NULL,
  `systemName` varchar(100) NOT NULL,
  `stationID` int DEFAULT NULL,
  `stationName` varchar(100) DEFAULT NULL,
  `shipID` bigint DEFAULT NULL,
  `shipName` varchar(100) DEFAULT NULL,
  `shipTypeID` int DEFAULT NULL,
  `shipTypeName` varchar(100) DEFAULT NULL,
  `maskID` decimal(12,1) NOT NULL,
  PRIMARY KEY (`maskID`,`characterID`),
  KEY `systemID` (`systemID`) USING HASH,
  KEY `occupantSearch` (`maskID`,`systemID`) USING HASH,
  KEY `characterID` (`characterID`) USING HASH,
  KEY `maskID` (`maskID`) USING HASH,
  KEY `userID` (`userID`) USING HASH,
  KEY `system_mask_idx` (`maskID`,`systemID`) USING HASH,
  CONSTRAINT `tracking_ibfk_1` FOREIGN KEY (`userID`) REFERENCES `accounts` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=MEMORY DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Trigger: systemVisits (Remove DEFINER, plain CREATE TRIGGER)
--

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

--
-- Trigger: jumpHistory (Remove DEFINER, plain CREATE TRIGGER)
--

DELIMITER ;;
CREATE TRIGGER `jumpHistory`
AFTER UPDATE ON `tracking`
FOR EACH ROW
BEGIN
    IF NEW.systemID <> OLD.systemID THEN
        SET @wormholeID = (
          SELECT w.id
          FROM wormholes w
          INNER JOIN signatures a ON initialID = a.id
          INNER JOIN signatures b ON secondaryID = b.id
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

--
-- Table structure for table `wormholes`
--

DROP TABLE IF EXISTS `wormholes`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `wormholes` (
  `id` int NOT NULL AUTO_INCREMENT,
  `initialID` int NOT NULL,
  `secondaryID` int NOT NULL,
  `type` char(4) DEFAULT NULL,
  `parent` char(9) DEFAULT NULL,
  `life` enum('stable','critical') NOT NULL,
  `mass` enum('stable','destab','critical') NOT NULL,
  `maskID` decimal(12,1) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `maskID` (`maskID`) USING BTREE,
  KEY `initialID` (`initialID`) USING BTREE,
  KEY `secondaryID` (`secondaryID`) USING BTREE,
  CONSTRAINT `wormholes_initialID_fk` FOREIGN KEY (`initialID`) REFERENCES `signatures` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `wormholes_secondaryID_fk` FOREIGN KEY (`secondaryID`) REFERENCES `signatures` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=0 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Event: activeClean, flaresClean, etc. (Remove DEFINER, use CREATE EVENT)
-- If needed, rename or keep them as is if MySQL 5.7+ allows them to run.

DROP EVENT IF EXISTS `activeClean`;
DELIMITER ;;
CREATE EVENT `activeClean`
ON SCHEDULE EVERY 15 SECOND
STARTS CURRENT_TIMESTAMP
ON COMPLETION NOT PRESERVE
ENABLE
DO
  DELETE FROM active WHERE time < NOW() - INTERVAL 15 SECOND;
;;
DELIMITER ;

DROP EVENT IF EXISTS `flaresClean`;
DELIMITER ;;
CREATE EVENT `flaresClean`
ON SCHEDULE EVERY 1 HOUR
STARTS CURRENT_TIMESTAMP
ON COMPLETION NOT PRESERVE
ENABLE
DO
  DELETE FROM flares WHERE time < NOW() - INTERVAL 24 HOUR;
;;
DELIMITER ;

DROP EVENT IF EXISTS `jumpsClean`;
DELIMITER ;;
CREATE EVENT `jumpsClean`
ON SCHEDULE EVERY 1 HOUR
STARTS CURRENT_TIMESTAMP
ON COMPLETION NOT PRESERVE
ENABLE
DO
  DELETE FROM `jumps`
   WHERE wormholeID NOT IN (
     SELECT id FROM wormholes WHERE type <> 'GATE'
   );
;;
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
      SET modifiedByID = 0, modifiedByName = "Tripwire"
      WHERE lifeLeft < NOW()
        AND lifeLength <> '0'
        AND type <> 'wormhole';

    DELETE FROM signatures
      WHERE lifeLeft < NOW()
        AND lifeLength <> '0'
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
  DELETE FROM tracking WHERE userID NOT IN (SELECT userID FROM active);
;;
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
    INNER JOIN wormholes w ON (s.id = initialID OR s.id = secondaryID)
      AND life = 'stable'
      SET modifiedByID = 0,
          modifiedByName = "Tripwire",
          modifiedTime = NOW()
      WHERE s.type = 'wormhole'
        AND lifeLength <> '0'
        AND lifeLeft < NOW() + INTERVAL 4 HOUR;

    UPDATE wormholes w
    INNER JOIN signatures s ON (s.id = initialID OR s.id = secondaryID)
      AND (s.type = 'wormhole'
           AND life = 'stable'
           AND lifeLength <> '0'
           AND lifeLeft < NOW() + INTERVAL 4 HOUR)
      SET life = 'critical';

    DELETE FROM signatures
      WHERE lifeLeft < NOW() - INTERVAL 0.1 * lifeLength SECOND
        AND lifeLength <> 0
        AND type = 'wormhole';

    DELETE FROM wormholes
      WHERE  NOT EXISTS (
               SELECT 1
               FROM signatures s
               WHERE s.id = wormholes.secondaryID
             )
         OR NOT EXISTS (
               SELECT 1
               FROM signatures s
               WHERE s.id = wormholes.initialID
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
       ON (s.id = initialID OR s.id = secondaryID)
       AND life = 'stable'
      SET modifiedByID = 0,
          modifiedByName = 'Tripwire',
          modifiedTime = NOW()
      WHERE s.type = 'wormhole'
        AND lifeLength <> '0'
        AND lifeLeft < NOW() + INTERVAL 4 HOUR;

    UPDATE wormholes w
    INNER JOIN signatures s
       ON (s.id = initialID OR s.id = secondaryID)
       AND s.type = 'wormhole'
       AND life = 'stable'
       AND lifeLength <> '0'
       AND lifeLeft < NOW() + INTERVAL 4 HOUR
      SET life = 'critical';
END;;
DELIMITER ;

--
-- Cleanup
--

/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;
/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

-- Dump completed on 2024-05-12 12:00:00
