<?php
// The note sanitiser runs twice: in the browser (app/js/sanitise-html.js) and
// on the server (note-html.inc.php). They must agree on what survives, or a
// note that looks fine in the editor is rewritten on save. This reads both
// sources and compares their allow-lists, then exercises the server one.
// Run: php tests/php/note-html.test.php   (exit 1 on any failure)
$root = dirname(dirname(__DIR__));
require $root . '/note-html.inc.php';
$php = file_get_contents($root . '/note-html.inc.php');
$js  = file_get_contents($root . '/app/js/sanitise-html.js');
$failures = 0;
function check($ok, $label, $detail = '') {
    global $failures;
    echo ($ok ? 'ok   ' : 'FAIL ') . $label . ($ok || $detail === '' ? '' : ' -- ' . $detail) . PHP_EOL;
    if (!$ok) $failures++;
}
function quoted($block) { preg_match_all("/'([a-z0-9-]+)'/i", $block, $m); sort($m[1]); return $m[1]; }
function jskeys($block) { preg_match_all("/(?:^|[\\s{,])'?([a-z0-9*-]+)'?\\s*:/i", $block, $m); $k = array_values(array_unique($m[1])); sort($k); return $k; }
function section($src, $start, $end) { $i = strpos($src, $start); $j = strpos($src, $end, $i); return substr($src, $i, $j - $i); }

// Tags
$phpTags = quoted(section($php, '$allowedTags', '], true);'));
$jsTags  = jskeys(section($js, 'var ALLOWED_TAGS', '};'));
check($phpTags === $jsTags, 'allowed tags match', implode(',', array_diff($phpTags, $jsTags)) . ' | ' . implode(',', array_diff($jsTags, $phpTags)));

// Attributes: global and per tag
$phpGlobal = quoted(section($php, '$globalAttributes', '], true);'));
$jsAttrs = section($js, 'var ALLOWED_ATTRS', '};');
preg_match("/'\\*':\\s*\\{([^}]*)\\}/", $jsAttrs, $m); $jsGlobal = jskeys($m[1]);
check($phpGlobal === $jsGlobal, 'global attributes match', implode(',', $phpGlobal) . ' vs ' . implode(',', $jsGlobal));
preg_match_all("/'([a-z]+)'\\s*=>\\s*array_fill_keys\\(\\[([^\\]]*)\\]/", section($php, '$tagAttributes', '];'), $pm, PREG_SET_ORDER);
preg_match_all("/(?:^|\\n)\\s*([a-z]+):\\s*\\{([^}]*)\\}/", $jsAttrs, $jm, PREG_SET_ORDER);
$phpPer = array(); foreach ($pm as $x) { $phpPer[$x[1]] = quoted($x[2]); }
$jsPer = array();  foreach ($jm as $x) { $jsPer[$x[1]] = jskeys($x[2]); }
ksort($phpPer); ksort($jsPer);
check($phpPer === $jsPer, 'per-tag attributes match', json_encode($phpPer) . ' vs ' . json_encode($jsPer));

// Style properties and their value patterns
preg_match_all("/'([a-z-]+)'\\s*=>\\s*'\\/(.*)\\/i'/", section($php, '$safeStyles', '];'), $sm, PREG_SET_ORDER);
preg_match_all("/(?:^|\\n)\\s*'?([a-z-]+)'?:\\s*\\/(.*)\\/i,?\\s*$/m", section($js, 'var SAFE_STYLES', '};'), $tm, PREG_SET_ORDER);
$phpStyles = array(); foreach ($sm as $x) { $phpStyles[$x[1]] = $x[2]; }
$jsStyles = array();  foreach ($tm as $x) { $jsStyles[$x[1]] = $x[2]; }
ksort($phpStyles); ksort($jsStyles);
check(array_keys($phpStyles) === array_keys($jsStyles), 'style properties match', implode(',', array_keys($phpStyles)) . ' vs ' . implode(',', array_keys($jsStyles)));
check($phpStyles === $jsStyles, 'style value patterns match');

// URL and CSS guards, taken verbatim from both sources
preg_match("/preg_match\\('\\/(\\^\\(\\?:https.*?)\\/i'/", $php, $u1); preg_match("/SAFE_URL = \\/(.*)\\/i;/", $js, $u2);
check(isset($u1[1], $u2[1]) && $u1[1] === $u2[1], 'safe URL pattern matches');
preg_match("/preg_match\\(\\s*'\\/(\\(\\?:expression.*?)\\/i'/s", $php, $c1); preg_match("/UNSAFE_CSS = \\/(.*)\\/i;/", $js, $c2);
check(isset($c1[1], $c2[1]) && $c1[1] === $c2[1], 'unsafe CSS pattern matches');

// Behaviour of the server sanitiser
check(noteHtmlSanitizerAvailable(), 'DOM extension present');
$r = sanitizeNoteHtml('<section><img src="/missing" onerror ="alert(1)"></section>');
check(preg_match('/^<img /', $r) && !preg_match('/onerror/i', $r), 'handler nested in a forbidden wrapper is removed', $r);
$r = sanitizeNoteHtml('<script>alert(1)</script><svg onload="alert(2)"></svg><a href="javascript:alert(3)" onclick="alert(4)">bad</a><span style="background:url(javascript:alert(5))">styled</span>');
check(!preg_match('/<(?:script|svg)\b/i', $r) && !preg_match('/(?:javascript:|onclick|onload|style=)/i', $r), 'executable elements, URLs and CSS removed', $r);
$r = sanitizeNoteHtml('<p><strong>Safe</strong> <span style="color: #fff; font-size: 18px; position: fixed">sized colour</span> <font size="5">large</font> <a href="https://example.com" target="_blank">link</a></p>');
check(preg_match('/<strong>Safe<\/strong>/', $r) && preg_match('/style="color: #fff; font-size: 18px"/', $r) && preg_match('/<font size="5">large<\/font>/', $r) && !preg_match('/position/i', $r) && preg_match('/href="https:\/\/example\.com"/', $r) && preg_match('/rel="noopener noreferrer"/', $r), 'supported formatting kept', $r);
$r = sanitizeNoteHtml('<span style="font-size: 999px">huge</span><font size="99">also huge</font>');
check(!preg_match('/font-size|size=/i', $r), 'unsafe sizes removed', $r);
check(noteHtmlHasContent('') === false && noteHtmlHasContent('<div><br></div><p>&nbsp;' . "\u{200b}" . '</p>') === false && noteHtmlHasContent('<p>Actual note</p>') === true && noteHtmlHasContent('<img src="/map.png" alt="Map">') === true, 'empty rich-text markup is recognised');

echo ($failures ? $failures . ' failure(s)' : 'all passed') . PHP_EOL;
exit($failures ? 1 : 0);
