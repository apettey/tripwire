-- Fork-owned: tables of the REST API's personal access tokens (docs: docker/README.md#rest-api).
-- Reference copy of API_TOKEN_DDL in api/tokens.inc.php (keep in sync); the tables are created on first use.

-- One row per token. Only the SHA-256 of the 32-byte secret is stored (the token is "twp_<id>_<64 hex>", shown once).
-- A token is for one character (of `userID`) and exactly one mask; scope `read` is the only one for now.
CREATE TABLE IF NOT EXISTS `fork_api_tokens` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `userID` int NOT NULL,
  `characterID` int NOT NULL,
  `name` varchar(40) NOT NULL,
  `maskID` decimal(12,1) NOT NULL,
  `scope` varchar(10) NOT NULL DEFAULT 'read',
  `tokenHash` char(64) NOT NULL,
  `createdAt` datetime NOT NULL,
  `expiresAt` datetime DEFAULT NULL,
  `lastUsedAt` datetime DEFAULT NULL,
  `lastUsedIP` varchar(45) DEFAULT NULL,
  `revokedAt` datetime DEFAULT NULL,
  `revokedBy` int DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `user` (`userID`, `revokedAt`),
  KEY `mask` (`maskID`, `revokedAt`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Requests per token and minute (the rate limit); rows older than an hour are deleted.
CREATE TABLE IF NOT EXISTS `fork_api_rate` (
  `tokenID` bigint unsigned NOT NULL,
  `windowStart` int unsigned NOT NULL,
  `hits` int unsigned NOT NULL DEFAULT 0,
  PRIMARY KEY (`tokenID`, `windowStart`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
