<?php
// Local dev only: fills the product analytics tables with made-up usage so the analytics dashboard has something to show
// (docker/README.md#product-analytics). 40 fake users over 35 days, a dozen features, masks, settings turned off.
//
//   docker compose -f docker-compose.dev.yml exec -T app php docker/dev-seed-analytics.php          # add / replace
//   docker compose -f docker-compose.dev.yml exec -T app php docker/dev-seed-analytics.php --clear  # remove them again
//   ... --keep-salt: leave the salt date (dated back by default so the made-up days are not split by it)
//
// Fake rows have uids starting with "f0e5" (real ones are HMAC hex, so a clash is possible but harmless in dev); a run
// first deletes the earlier fake rows. Deterministic (fixed random seed) for a given day. Never run it in production.
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }
chdir(__DIR__ . '/..');
require('config.php');
require('db.inc.php');
require_once('analytics/dashboard.inc.php');

const FAKE = 'f0e5';
const USERS = 40;
const DAYS = 35;
const MASKS = 8;

analytics_ensure_schema($mysql);
foreach (['fork_analytics_daily', 'fork_analytics_user'] as $t) $mysql->exec("DELETE FROM $t WHERE uid LIKE '" . FAKE . "%'");
$mysql->exec("DELETE FROM fork_analytics_mask WHERE maskHash LIKE '" . FAKE . "%'");
if (in_array('--clear', $argv, true)) { echo "analytics seed: fake rows removed\n"; exit(0); }

mt_srand(42);
$rand = function () { return mt_rand() / mt_getrandmax(); };
$features = dash_features();
$today = gmdate('Y-m-d');

// feature => [share of users who adopt it, chance an adopter uses it on an active day, extra use action or null]
$profile = [
    'commandPalette' => [0.6, 0.5, null], 'sigInline' => [0.55, 0.6, 'edited'], 'jumpReturn' => [0.45, 0.4, 'copied'],
    'intelScans' => [0.4, 0.35, 'pasted'], 'jumpPlanner' => [0.35, 0.3, 'route_planned'], 'panelModes' => [0.3, 0.25, 'mode'],
    'favouritesPanel' => [0.3, 0.3, 'added'], 'regionMap' => [0.25, 0.2, null], 'soundMute' => [0.2, 0.15, 'toggled'],
    'structures' => [0.15, 0.2, 'saved'], 'watchlist' => [0.12, 0.1, 'configured'], 'skyhooks' => [0.1, 0.15, null],
    'preserveMass' => [0.1, 0.1, 'marked'], 'mapTargets' => [0.06, 0.1, 'marked'], 'apiTokens' => [0.03, 0.05, 'created'],
];
// features some users keep turned off: feature => share
$offShare = ['sizeTags' => 0.15, 'systemThreat' => 0.1, 'sigAge' => 0.05, 'killReporting' => 0.2, 'jumpSigPrompt' => 0.12];
$exposedOnly = ['sizeTags', 'highsecRegion', 'systemThreat', 'environmentTags', 'sigAge', 'fightHere', 'rally', 'killReporting', 'jumpSigPrompt', 'lootBuyers'];

$daily = [];   // "day|feature|action|uid" => [n, firstMinute]
$masks = [];
$add = function ($day, $f, $a, $uid, $n, $minute) use (&$daily) {
    $k = "$day|$f|$a|$uid";
    if (isset($daily[$k])) { $daily[$k][0] += $n; return; }
    $daily[$k] = [$n, $minute];
};
for ($u = 0; $u < USERS; $u++) {
    $uid = FAKE . sprintf('%012x', $u + 1);
    $mask = FAKE . sprintf('%012x', $u % MASKS + 1);
    $p = 0.25 + 0.65 * $rand();
    $start = $u < 6 ? mt_rand(1, 12) : mt_rand(DAYS - 5, DAYS - 1);   // a few new users in the last two weeks
    $hour = (int) round(17 + 4 * ($rand() + $rand() - 1)) % 24;     // evenings UTC, some spread
    $adopt = [];
    foreach ($profile as $f => $x) if ($rand() < $x[0]) $adopt[$f] = mt_rand(0, 10);   // starts after this many active days
    $off = [];
    foreach ($offShare as $f => $s) if ($rand() < $s) $off[$f] = true;
    $activeDays = 0;
    for ($i = $start; $i >= 0; $i--) {
        $day = dash_day($today, -$i);
        if ($rand() > $p * (in_array((int) gmdate('N', strtotime($day)), [6, 7], true) ? 1.2 : 1)) continue;
        $activeDays++;
        $h = ($hour + mt_rand(-2, 2) + 24) % 24;
        $minute = $h * 60 + mt_rand(0, 59);
        $add($day, 'app', 'active', $uid, mt_rand(3, 30), $minute);
        foreach ($off as $f => $_) $add($day, $f, 'disabled', $uid, 1, $minute);
        foreach ($exposedOnly as $f) {
            if (isset($features[$f]) && !isset($off[$f]) && $rand() < 0.5 && (!$features[$f]['released'] || $day >= $features[$f]['released'])) {
                $add($day, $f, 'shown', $uid, 1, $minute + mt_rand(1, 50));
            }
        }
        foreach ($adopt as $f => $after) {
            if (!isset($features[$f]) || ($features[$f]['released'] && $day < $features[$f]['released'])) continue;
            if ($rand() < 0.4) $add($day, $f, 'shown', $uid, 1, $minute + mt_rand(0, 30));
            if ($activeDays <= $after || $rand() > $profile[$f][1]) continue;
            $m = $minute + mt_rand(5, 180);
            $action = $profile[$f][2] && $rand() < 0.7 ? $profile[$f][2] : ($rand() < 0.5 ? 'command' : 'opened');
            if (!in_array($action, $features[$f]['use'], true)) $action = $features[$f]['use'][0];
            $add($day, $f, $action, $uid, mt_rand(1, 12), min(1439, $m));
            $masks["$day|$mask|$f"] = true;
        }
        // What's New opened in the days after a release
        foreach (dash_whatsnew() as $e) {
            if ($day >= $e['date'] && $day <= dash_day($e['date'], 2) && $rand() < 0.08) {
                $add($day, 'whatsNew', 'opened', $uid, 1, $minute + 1);
                $masks["$day|$mask|whatsNew"] = true;
            }
        }
    }
    // Turned off in Settings in the window (some after using the feature)
    if (isset($off['killReporting'])) $add(dash_day($today, -mt_rand(1, 20)), 'killReporting', 'setting_off', $uid, 1, $hour * 60);
    if (isset($off['sizeTags'])) $add(dash_day($today, -mt_rand(1, 20)), 'sizeTags', 'setting_off', $uid, 1, $hour * 60);
    // Feature tips (the names the tips feature sends): a tip per feature, its outcome on feature "hints"
    if ($u < 24) {
        $tipFeature = ['jumpPlanner', 'regionMap', 'intelScans'][$u % 3];
        $tipDay = dash_day($today, -mt_rand(2, 14));
        $add($tipDay, $tipFeature, 'hint_shown', $uid, 1, $hour * 60);
        $add($tipDay, 'hints', 'tip_shown', $uid, 1, $hour * 60);
        $outcome = ['acted', 'got_it', 'closed', 'ignored', 'acted'][mt_rand(0, 4)];
        $add($tipDay, 'hints', $outcome, $uid, 1, $hour * 60 + 1);
        if ($outcome === 'acted') {
            $add($tipDay, $tipFeature, 'hint_acted', $uid, 1, $hour * 60 + 1);
            $add($tipDay, $tipFeature, 'opened', $uid, 1, $hour * 60 + 2);
        }
    }
    if ($u % 9 === 4) $add(dash_day($today, -mt_rand(1, 10)), 'hints', 'setting_off', $uid, 1, $hour * 60);
    if ($u % 7 === 3 && isset($adopt['jumpReturn'])) $add(dash_day($today, -mt_rand(0, 3)), 'jumpReturn', 'setting_off', $uid, 1, min(1439, $hour * 60 + 300));
}

$mysql->beginTransaction();
$user = [];
$stmt = $mysql->prepare('INSERT INTO fork_analytics_daily (day, feature, action, uid, n, firstMinute) VALUES (?, ?, ?, ?, ?, ?)');
foreach ($daily as $k => $v) {
    list($day, $f, $a, $uid) = explode('|', $k);
    $stmt->execute([$day, $f, $a, $uid, $v[0], $v[1] % 1440]);
    $at = $day . ' ' . sprintf('%02d:%02d:00', intdiv($v[1] % 1440, 60), $v[1] % 60);
    $uk = "$uid|$f|$a";
    if (!isset($user[$uk])) $user[$uk] = [$at, $at, 0];
    $user[$uk][0] = min($user[$uk][0], $at);
    $user[$uk][1] = max($user[$uk][1], $at);
    $user[$uk][2] += $v[0];
}
$stmt = $mysql->prepare('INSERT INTO fork_analytics_user (uid, feature, action, firstAt, lastAt, n) VALUES (?, ?, ?, ?, ?, ?)');
foreach ($user as $k => $v) {
    list($uid, $f, $a) = explode('|', $k);
    $stmt->execute([$uid, $f, $a, $v[0], $v[1], $v[2]]);
}
$stmt = $mysql->prepare('INSERT IGNORE INTO fork_analytics_mask (day, maskHash, feature) VALUES (?, ?, ?)');
foreach ($masks as $k => $_) $stmt->execute(explode('|', $k));
$mysql->commit();
// The made-up days are older than this dev database's salt: date the salt back (key unchanged) so the dashboard doesn't
// report a salt replacement in the middle of them. Pass --keep-salt to see that banner instead.
if (!in_array('--keep-salt', $argv, true)) {
    $salt = (string) $mysql->query("SELECT v FROM fork_analytics_meta WHERE k = 'salt'")->fetchColumn();
    $oldest = dash_day($today, -DAYS - 1);
    if (preg_match('/^\d{4}-\d{2}-\d{2}:/', $salt) && substr($salt, 0, 10) > $oldest) {
        $mysql->prepare("UPDATE fork_analytics_meta SET v = ? WHERE k = 'salt' AND v = ?")->execute([$oldest . substr($salt, 10), $salt]);
    }
}
foreach (glob(__DIR__ . '/../cache/fork-analytics-*.json') ?: [] as $f) @unlink($f);
echo 'analytics seed: ', count($daily), ' daily rows, ', count($user), ' milestones, ', count($masks), " mask rows for ", USERS, " fake users\n";
