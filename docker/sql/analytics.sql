-- Fork-owned: tables of the product analytics (docs: docker/README.md#product-analytics).
-- Reference copy of ANALYTICS_DDL / ANALYTICS_RAW_DDL in analytics/analytics.inc.php (keep in sync); the tables are created
-- on first use. No account, character, corporation or mask ids or names, systems, IPs, user agents or free text: `uid` and
-- `maskHash` are 8 bytes of HMAC-SHA256 with the salt in fork_analytics_meta, replaced every ANALYTICS_DAYS.

-- Daily counters: one row per UTC day, feature, action and user. Deleted after ANALYTICS_DAYS (default 90).
CREATE TABLE IF NOT EXISTS `fork_analytics_daily` (
  `day` date NOT NULL,
  `feature` varchar(40) CHARACTER SET ascii NOT NULL,
  `action` varchar(24) CHARACTER SET ascii NOT NULL,
  `uid` char(16) CHARACTER SET ascii NOT NULL,
  `n` int unsigned NOT NULL DEFAULT 0,
  `firstMinute` smallint unsigned NOT NULL DEFAULT 0,
  PRIMARY KEY (`day`, `feature`, `action`, `uid`),
  KEY `uid` (`uid`, `day`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Milestones: first and last time (UTC, to the minute) a user did an action of a feature, for funnels without raw events.
-- Deleted ANALYTICS_DAYS after lastAt.
CREATE TABLE IF NOT EXISTS `fork_analytics_user` (
  `uid` char(16) CHARACTER SET ascii NOT NULL,
  `feature` varchar(40) CHARACTER SET ascii NOT NULL,
  `action` varchar(24) CHARACTER SET ascii NOT NULL,
  `firstAt` datetime NOT NULL,
  `lastAt` datetime NOT NULL,
  `n` int unsigned NOT NULL DEFAULT 0,
  PRIMARY KEY (`uid`, `feature`, `action`),
  KEY `lastAt` (`lastAt`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Masks using a feature: a row per day, feature and mask hash, written for "use" actions only. Only ever counted.
CREATE TABLE IF NOT EXISTS `fork_analytics_mask` (
  `day` date NOT NULL,
  `maskHash` char(16) CHARACTER SET ascii NOT NULL,
  `feature` varchar(40) CHARACTER SET ascii NOT NULL,
  PRIMARY KEY (`day`, `feature`, `maskHash`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Requests per user in the current window (ANALYTICS_RATE_MAX per ANALYTICS_RATE_WINDOW seconds); rows older than a day are
-- deleted by the prune.
CREATE TABLE IF NOT EXISTS `fork_analytics_rate` (
  `uid` char(16) CHARACTER SET ascii NOT NULL,
  `windowStart` datetime NOT NULL,
  `n` int unsigned NOT NULL DEFAULT 0,
  PRIMARY KEY (`uid`),
  KEY `windowStart` (`windowStart`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- k = 'salt': v = '<YYYY-MM-DD it was made>:<64 hex>'
CREATE TABLE IF NOT EXISTS `fork_analytics_meta` (
  `k` varchar(32) CHARACTER SET ascii NOT NULL,
  `v` varchar(255) CHARACTER SET ascii NOT NULL,
  PRIMARY KEY (`k`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Only while ANALYTICS_RAW_DAYS > 0 (debugging): single events, deleted after ANALYTICS_RAW_DAYS; dropped when it is 0.
CREATE TABLE IF NOT EXISTS `fork_analytics_raw` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `at` datetime NOT NULL,
  `uid` char(16) CHARACTER SET ascii NOT NULL,
  `feature` varchar(40) CHARACTER SET ascii NOT NULL,
  `action` varchar(24) CHARACTER SET ascii NOT NULL,
  `n` int unsigned NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `at` (`at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
