<?php
// Fork-owned: tests for note-html.inc.php (the server-side note sanitiser), using the same cases as the JS
// sanitiser (app/js-test/testdata/note-html-cases.json). No database needed.
//   docker compose -f docker-compose.dev.yml exec -T app php tests/note_html_test.php
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }

require_once(__DIR__ . '/../note-html.inc.php');

$failures = 0;
$count = 0;
function check($name, $ok, $detail = '') {
	global $failures, $count;
	$count++;
	if (!$ok) { $failures++; fwrite(STDERR, "FAIL $name  $detail\n"); }
}

$cases = json_decode(file_get_contents(__DIR__ . '/../app/js-test/testdata/note-html-cases.json'), true);
foreach ($cases as $c) {
	$out = sanitizeNoteHtml($c['input']);
	foreach (isset($c['contains']) ? $c['contains'] : array() as $s) {
		check($c['name'] . ' contains ' . $s, strpos($out, $s) !== false, $out);
	}
	foreach (isset($c['notContains']) ? $c['notContains'] : array() as $s) {
		check($c['name'] . ' not ' . $s, stripos($out, $s) === false, $out);
	}
}
check('null', sanitizeNoteHtml(null) === '');
check('has content: empty editor markup', !noteHtmlHasContent('<div><br></div>&nbsp;'));
check('has content: text', noteHtmlHasContent('<p>x</p>'));
check('has content: image', noteHtmlHasContent('<img src="https://x.example/a.png">'));

echo ($count - $failures) . "/$count passed\n";
exit($failures ? 1 : 0);
