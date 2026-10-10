<?php
// Fork-owned: d-scan and local scans shared with the mask, pinned to a system (feature "D-scan & local intel").
//
// Pilots paste a directional scan or a local member list into the Intel dialog; public/intel_scans.php validates
// and normalises it here (the browser's own parse in app/js/fork/intel-scans.js is only a preview) and stores the
// normalised rows, not the pasted text. The browser builds the summary (ship classes, on grid / off grid) from the
// rows and the static type data in public/intel/types.json. No ESI or other third-party calls.
//
// D-scan copy format (one object per line, tab-separated):
//   current clients:  <typeID> \t <name> \t <type name> \t <distance>     e.g. "22456\tBob's Sabre\tSabre\t1,234 km"
//   older clients:    <name> \t <type name> \t <distance>
// Distances: "1,234 km", "1 234 km" (also with non-breaking spaces), "500 m", "4.2 AU" / "4,2 AE", or "-".

const INTEL_MAX_BYTES     = 200000;   // pasted text
const INTEL_MAX_LINES     = 2000;     // non-empty lines
const INTEL_FIELD_MAX     = 100;      // characters per name / type name
const INTEL_RETENTION_H   = 24;       // rows are deleted after this many hours
const INTEL_MAX_PER_SYSTEM = 30;      // newest scans kept per mask and system
const INTEL_LIST_LIMIT    = 20;       // scans returned for a system
const INTEL_RATE_PER_MIN  = 20;       // scans a user may share per minute
const INTEL_AU_KM         = 149597870.7;
const INTEL_MAX_KM        = 15 * INTEL_AU_KM;  // d-scan reaches about 14.3 AU; farther distances are junk

// Whitespace and invisible characters are matched with the same explicit classes as app/js/fork/intel-scans.js
// (PCRE's \s and JavaScript's \s differ on non-breaking and other Unicode spaces)
const INTEL_WS = '[\t\n\x0B\f\r\p{Z}]';

/** Drop control characters (\x00-\x1F except tab and line breaks, \x7F) and format characters such as bidi controls */
function intel_strip_invisible($value) {
    $value = preg_replace('/[\x00-\x08\x0E-\x1F\x7F\p{Cf}]/u', '', (string) $value);
    return $value === null ? '' : $value;
}

/** Trim whitespace including Unicode spaces */
function intel_trim($value) {
    $value = preg_replace('/^' . INTEL_WS . '+|' . INTEL_WS . '+$/u', '', (string) $value);
    return $value === null ? '' : $value;
}

/** 'dscan' if any line has a tab, else 'local' */
function intel_detect_kind($text) {
    return strpos((string) $text, "\t") !== false ? 'dscan' : 'local';
}

/** Non-empty lines (CR stripped, right-trimmed of spaces only, so a trailing empty field keeps its tab) */
function intel_lines($text) {
    $out = [];
    foreach (preg_split('/\r\n|\r|\n/', (string) $text) as $line) {
        $line = rtrim($line, " \x0B\0");
        if (intel_trim(intel_strip_invisible($line)) !== '') $out[] = $line;
    }
    return $out;
}

/** Cut to $max characters and drop control and format characters */
function intel_clean_field($value, $max = INTEL_FIELD_MAX) {
    $value = preg_replace('/[\x00-\x1F\x7F\p{Cf}]/u', '', (string) $value);
    return mb_substr(intel_trim($value === null ? '' : $value), 0, $max, 'UTF-8');
}

/**
 * Distance in km (rounded to 0.1 km), or null for "-", empty or unreadable values.
 * Thousands separators (",", ".", spaces, non-breaking spaces, "'") are ignored for m and km, which the client shows
 * as whole numbers; for AU the last "," or "." is the decimal point.
 */
function intel_parse_distance_km($value) {
    $km = intel_parse_distance_raw($value);
    return $km === null || $km > INTEL_MAX_KM ? null : $km;
}

function intel_parse_distance_raw($value) {
    $s = preg_replace('/\p{Z}/u', ' ', intel_strip_invisible($value));
    $s = intel_trim($s === null ? '' : $s);
    if ($s === '' || $s === '-') return null;
    if (!preg_match('/^([0-9][0-9 .,\']*) *([^ 0-9][^ ]*)$/u', $s, $m)) return null;
    $number = str_replace([' ', "'"], '', $m[1]);
    $unit = mb_strtolower(str_replace('.', '', $m[2]), 'UTF-8');
    if (in_array($unit, ['m', 'м', '米'], true)) {
        return round(((int) preg_replace('/\D/', '', $number)) / 1000, 1);
    }
    if (in_array($unit, ['km', 'км', '公里', '千米'], true)) {
        return (float) (int) preg_replace('/\D/', '', $number);
    }
    if (in_array($unit, ['au', 'ae', 'ua', 'ае', '天文单位'], true)) {
        $lastDot = strrpos($number, '.');
        $lastComma = strrpos($number, ',');
        $decimal = max($lastDot === false ? -1 : $lastDot, $lastComma === false ? -1 : $lastComma);
        if ($decimal >= 0) {
            $separators = substr_count($number, '.') + substr_count($number, ',');
            if ($separators > 1 && substr_count($number, $number[$decimal]) > 1) {
                $number = preg_replace('/\D/', '', $number);	// "1,234,567" style: all thousands separators
            } else {
                $number = preg_replace('/\D/', '', substr($number, 0, $decimal)) . '.' . preg_replace('/\D/', '', substr($number, $decimal + 1));
            }
        }
        if (!is_numeric($number)) return null;
        return round(((float) $number) * INTEL_AU_KM, 1);
    }
    return null;
}

/**
 * Parse a d-scan paste. @return array [rows: [[typeID|null, typeName, name, km|null], ...], invalid: n]
 */
function intel_parse_dscan($text) {
    $rows = [];
    $invalid = 0;
    foreach (intel_lines($text) as $line) {
        $f = explode("\t", $line);
        if (count($f) >= 4 && preg_match('/^[0-9]{1,10}$/', intel_trim(intel_strip_invisible($f[0])))) {
            $typeID = (int) intel_trim(intel_strip_invisible($f[0]));
            [$name, $type, $distance] = [$f[1], $f[2], $f[3]];
        } elseif (count($f) === 3) {
            $typeID = null;
            [$name, $type, $distance] = $f;
        } else {
            $invalid++;
            continue;
        }
        $type = intel_clean_field($type);
        if ($type === '' || ($typeID !== null && $typeID <= 0)) { $invalid++; continue; }
        $rows[] = [$typeID, $type, intel_clean_field($name), intel_parse_distance_km($distance)];
    }
    return ['rows' => $rows, 'invalid' => $invalid];
}

/** Whether a line looks like an EVE character name (3-37 letters, digits, spaces, ' . - _) */
function intel_valid_character_name($name) {
    $length = mb_strlen($name, 'UTF-8');
    return $length >= 3 && $length <= 37 && preg_match('/^[\p{L}\p{N}][\p{L}\p{N} .\'_-]*$/u', $name) === 1;
}

/** Parse a local member list. @return array [names: [...] (unique, in paste order), invalid: n] */
function intel_parse_local($text) {
    $names = [];
    $seen = [];
    $invalid = 0;
    foreach (intel_lines($text) as $line) {
        $name = preg_replace('/' . INTEL_WS . '+/u', ' ', intel_trim(intel_strip_invisible($line)));
        if (!intel_valid_character_name($name)) { $invalid++; continue; }
        $key = mb_strtolower($name, 'UTF-8');
        if (isset($seen[$key])) continue;
        $seen[$key] = true;
        $names[] = $name;
    }
    return ['names' => $names, 'invalid' => $invalid];
}

/**
 * Validate and normalise a paste. @return array [kind, data] on success, or [null, error message]
 */
function intel_parse($text) {
    if (!is_string($text)) return [null, 'Nothing pasted'];
    if (strlen($text) > INTEL_MAX_BYTES) return [null, 'Too much text (at most ' . round(INTEL_MAX_BYTES / 1000) . ' kB)'];
    if (!mb_check_encoding($text, 'UTF-8')) return [null, 'The text is not valid UTF-8'];
    if (!intel_lines($text)) return [null, 'Nothing pasted'];
    if (count(intel_lines($text)) > INTEL_MAX_LINES) return [null, 'Too many lines (at most ' . INTEL_MAX_LINES . ')'];
    $kind = intel_detect_kind($text);
    if ($kind === 'dscan') {
        $data = intel_parse_dscan($text);
        if (!$data['rows']) return [null, 'No d-scan lines found (copy the d-scan results with Ctrl+A, Ctrl+C)'];
    } else {
        $data = intel_parse_local($text);
        if (!$data['names']) return [null, 'No character names found (copy the local member list, one name per line)'];
    }
    return [$kind, $data];
}

// ---- Database ----

function intel_schema(PDO $db) {
    // Don't change the connection's error mode (it may be persistent and shared); check results instead
    $ok = $db->exec('CREATE TABLE IF NOT EXISTS fork_intel_scans (
        id int unsigned NOT NULL AUTO_INCREMENT,
        maskID decimal(12,1) NOT NULL,
        systemID int NOT NULL,
        kind varchar(8) NOT NULL,
        data mediumtext NOT NULL,
        createdBy varchar(100) DEFAULT NULL,
        createdByUser int DEFAULT NULL,
        createdAt datetime NOT NULL,
        expiresAt datetime NOT NULL,
        PRIMARY KEY (id),
        KEY mask_system (maskID, systemID, createdAt),
        KEY expires (expiresAt),
        KEY user_created (createdByUser, createdAt)
    ) DEFAULT CHARSET=utf8mb4');
    if ($ok === false) throw new PDOException('Could not create fork_intel_scans: ' . implode(' ', $db->errorInfo()));
}

/** Delete expired rows, and all but the newest INTEL_MAX_PER_SYSTEM scans of the mask's system. @return int rows deleted */
function intel_prune(PDO $db, $mask = null, $systemID = null) {
    $deleted = $db->exec('DELETE FROM fork_intel_scans WHERE expiresAt <= UTC_TIMESTAMP()');
    if ($deleted === false) throw new PDOException('Could not prune fork_intel_scans');
    if ($mask !== null && $systemID !== null) {
        $stmt = $db->prepare('SELECT id FROM fork_intel_scans WHERE maskID = :mask AND systemID = :systemID
            ORDER BY createdAt DESC, id DESC LIMIT 1000 OFFSET ' . (int) INTEL_MAX_PER_SYSTEM);
        $stmt->bindValue(':mask', $mask);
        $stmt->bindValue(':systemID', (int) $systemID, PDO::PARAM_INT);
        if (!$stmt->execute()) throw new PDOException('Could not read fork_intel_scans');
        $old = array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN));
        if ($old) {
            $del = $db->prepare('DELETE FROM fork_intel_scans WHERE id IN (' . implode(',', array_fill(0, count($old), '?')) . ')');
            if (!$del->execute($old)) throw new PDOException('Could not prune fork_intel_scans');
            $deleted += $del->rowCount();
        }
    }
    return $deleted;
}

/** Scans the user shared in the last minute */
function intel_recent_count(PDO $db, $userID) {
    $stmt = $db->prepare('SELECT COUNT(*) FROM fork_intel_scans WHERE createdByUser = :user AND createdAt > UTC_TIMESTAMP() - INTERVAL 1 MINUTE');
    $stmt->bindValue(':user', (int) $userID, PDO::PARAM_INT);
    if (!$stmt->execute()) throw new PDOException('Could not read fork_intel_scans');
    return (int) $stmt->fetchColumn();
}

/** Store a scan. @return int its id */
function intel_insert(PDO $db, $mask, $systemID, $kind, array $data, $createdBy, $userID, $ageSeconds = 0) {
    $stmt = $db->prepare('INSERT INTO fork_intel_scans (maskID, systemID, kind, data, createdBy, createdByUser, createdAt, expiresAt)
        VALUES (:mask, :systemID, :kind, :data, :createdBy, :user,
            UTC_TIMESTAMP() - INTERVAL :age1 SECOND, UTC_TIMESTAMP() - INTERVAL :age2 SECOND + INTERVAL ' . (int) INTEL_RETENTION_H . ' HOUR)');
    $stmt->bindValue(':mask', $mask);
    $stmt->bindValue(':systemID', (int) $systemID, PDO::PARAM_INT);
    $stmt->bindValue(':kind', $kind);
    $stmt->bindValue(':data', json_encode($data, JSON_UNESCAPED_UNICODE));
    $stmt->bindValue(':createdBy', $createdBy === null ? null : mb_substr((string) $createdBy, 0, 100, 'UTF-8'));
    $stmt->bindValue(':user', $userID === null ? null : (int) $userID, $userID === null ? PDO::PARAM_NULL : PDO::PARAM_INT);
    $stmt->bindValue(':age1', (int) $ageSeconds, PDO::PARAM_INT);	// tests insert old rows
    $stmt->bindValue(':age2', (int) $ageSeconds, PDO::PARAM_INT);
    if (!$stmt->execute()) throw new PDOException('Could not store the scan: ' . implode(' ', $stmt->errorInfo()));
    return (int) $db->lastInsertId();
}

/** Scan IDs the browser already has the rows of ("have=12,13"): at most INTEL_LIST_LIMIT * 3 positive integers */
function intel_have_param($value) {
    $ids = [];
    foreach (explode(',', substr((string) $value, 0, 1000)) as $part) {
        $id = filter_var(trim($part), FILTER_VALIDATE_INT);
        if ($id !== false && $id > 0) $ids[$id] = true;
        if (count($ids) >= INTEL_LIST_LIMIT * 3) break;
    }
    return array_keys($ids);
}

/**
 * Newest unexpired scans of a system for the mask. Scans never change, so `data` (the rows) is only included for
 * scans whose ID is not in $have; the browser keeps the rows it has and polls the small metadata.
 */
function intel_list(PDO $db, $mask, $systemID, $userID, array $have = []) {
    $stmt = $db->prepare('SELECT id, systemID, kind, createdBy, createdByUser, TIMESTAMPDIFF(SECOND, createdAt, UTC_TIMESTAMP()) AS age
        FROM fork_intel_scans WHERE maskID = :mask AND systemID = :systemID AND expiresAt > UTC_TIMESTAMP()
        ORDER BY createdAt DESC, id DESC LIMIT ' . (int) INTEL_LIST_LIMIT);
    $stmt->bindValue(':mask', $mask);
    $stmt->bindValue(':systemID', (int) $systemID, PDO::PARAM_INT);
    if (!$stmt->execute()) throw new PDOException('Could not read fork_intel_scans');
    $out = [];
    $need = [];
    $haveSet = array_flip(array_map('intval', $have));
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $id = (int) $row['id'];
        $out[$id] = [
            'id' => $id,
            'systemID' => (int) $row['systemID'],
            'kind' => $row['kind'],
            'createdBy' => $row['createdBy'],
            'mine' => $userID !== null && $row['createdByUser'] !== null && (int) $row['createdByUser'] === (int) $userID,
            'age' => max(0, (int) $row['age']),
        ];
        if (!isset($haveSet[$id])) $need[] = $id;
    }
    if ($need) {
        $data = $db->prepare('SELECT id, data FROM fork_intel_scans WHERE id IN (' . implode(',', array_fill(0, count($need), '?')) . ')');
        if (!$data->execute($need)) throw new PDOException('Could not read fork_intel_scans');
        foreach ($data->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $out[(int) $row['id']]['data'] = json_decode($row['data'], true);
        }
    }
    return array_values($out);
}

/** Age in seconds of the newest unexpired scan of each kind, per system of the mask: [systemID => [kind => age]] */
function intel_latest(PDO $db, $mask) {
    $stmt = $db->prepare('SELECT systemID, kind, MIN(TIMESTAMPDIFF(SECOND, createdAt, UTC_TIMESTAMP())) AS age
        FROM fork_intel_scans WHERE maskID = :mask AND expiresAt > UTC_TIMESTAMP() GROUP BY systemID, kind');
    $stmt->bindValue(':mask', $mask);
    if (!$stmt->execute()) throw new PDOException('Could not read fork_intel_scans');
    $out = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $out[(string) (int) $row['systemID']][$row['kind']] = max(0, (int) $row['age']);
    }
    return $out;
}

/** Delete one of the user's own scans. @return bool whether a row was deleted */
function intel_delete(PDO $db, $mask, $id, $userID) {
    $stmt = $db->prepare('DELETE FROM fork_intel_scans WHERE id = :id AND maskID = :mask AND createdByUser = :user');
    $stmt->bindValue(':id', (int) $id, PDO::PARAM_INT);
    $stmt->bindValue(':mask', $mask);
    $stmt->bindValue(':user', (int) $userID, PDO::PARAM_INT);
    if (!$stmt->execute()) throw new PDOException('Could not delete the scan');
    return $stmt->rowCount() > 0;
}
