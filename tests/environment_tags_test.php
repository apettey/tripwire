<?php
// Fork-owned: tests for environment_tags.inc.php (stripping, atomic copy, stale copy keeps its age); no network.
//   docker compose -f docker-compose.dev.yml exec -T app php tests/environment_tags_test.php
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }
require_once(__DIR__ . '/../environment_tags.inc.php');

$failures = 0;
function check($name, $actual, $expected) {
	global $failures;
	if ($actual !== $expected) {
		$failures++;
		fwrite(STDERR, "FAIL $name\n  expected: " . var_export($expected, true) . "\n  actual:   " . var_export($actual, true) . "\n");
	}
}

$body = json_encode(array(
	array('id' => '1', 'created_at' => '2026-10-12T02:15:34.000Z', 'created_by_id' => 5, 'created_by_name' => 'Tamayo', 'observed_in_person' => false,
		'observation_type' => 'gamma_a', 'observation_category' => 'storm', 'display_name' => '<img src=x onerror=alert(1)>', 'hours_in_system' => 1,
		'system_id' => 30000563, 'system_name' => 'R0-DMM', 'region_id' => 1, 'region_name' => 'x'),
	array('observation_category' => 'space_oddity', 'observation_type' => 'toms_shuttle', 'system_id' => 31001918),
	'junk',
));
check('strip keeps storms with the five fields only', environment_tags_strip_observations($body),
	'[{"observation_category":"storm","observation_type":"gamma_a","system_id":30000563,"created_at":"2026-10-12T02:15:34.000Z","hours_in_system":1}]');
check('strip: not json', environment_tags_strip_observations('<html>'), null);
check('strip: not a list', environment_tags_strip_observations('5'), null);

$file = tempnam(sys_get_temp_dir(), 'envtags-') . '.json';
@unlink($file);
$retry = preg_replace('/\.json$/', '', $file) . '.retry.json';
@unlink($retry);
$calls = 0;
$ok = function() use (&$calls, $body) { $calls++; return $body; };
$fail = function() use (&$calls) { $calls++; return null; };

check('no copy, fetch fails: nothing to serve', environment_tags_refresh('u', $file, 600, $fail, 1000), false);
check('...asked once', $calls, 1);
check('retry backoff: not asked again within 60 s', environment_tags_refresh('u', $file, 600, $ok, 1030), false);
check('...no call', $calls, 1);
// filemtime of the retry marker is the real clock; use real time for the remaining steps
$t = time();
@unlink($retry);
check('fetch ok', environment_tags_refresh('u', $file, 600, $ok, $t), true);
check('copy written stripped', strpos((string) file_get_contents($file), 'created_by_name'), false);
check('no temp files left', glob($file . '.*.tmp.json'), array());
touch($file, $t - 1000);
check('fresh copy not refetched', environment_tags_refresh('u', $file, 600, $fail, $t - 1000 + 100), true);
check('stale + failing fetch: stale copy is served', environment_tags_refresh('u', $file, 600, $fail, $t), true);
check('...and keeps its age', filemtime($file), $t - 1000);
@unlink($file); @unlink($retry);

echo $failures ? "$failures failure(s)\n" : "environment_tags_test: all passed\n";
exit($failures ? 1 : 0);
