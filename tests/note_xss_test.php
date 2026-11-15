<?php
// Fork-owned: the note XSS payload corpus (app/js-test/testdata/note-xss-corpus.json) against the server sanitiser
// (note-html.inc.php), with the HTML5 parser (PHP 8.4+) and with the libxml fallback. app/js-test/fork/note-xss.test.js
// runs the same corpus against the browser sanitiser. No database needed.
//   docker compose -f docker-compose.dev.yml exec -T app php tests/note_xss_test.php
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }

require_once(__DIR__ . '/../note-html.inc.php');

$failures = 0;
$count = 0;
function check($name, $ok, $detail = '') {
	global $failures, $count;
	$count++;
	if (!$ok) { $failures++; fwrite(STDERR, "FAIL $name  $detail\n"); }
}

$TAGS = array_fill_keys(['b', 'i', 'em', 'strong', 'u', 's', 'strike', 'sub', 'sup', 'code', 'small', 'font', 'span', 'p',
	'br', 'hr', 'div', 'pre', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'thead', 'tbody',
	'tr', 'td', 'th', 'a', 'img'], true);
$ATTRS = ['*' => ['style', 'title', 'dir'], 'a' => ['href', 'target', 'rel'], 'font' => ['color', 'size', 'face'],
	'table' => ['border', 'cellpadding', 'cellspacing', 'align', 'width'], 'td' => ['colspan', 'rowspan', 'align', 'width'],
	'th' => ['colspan', 'rowspan', 'align', 'width'], 'img' => ['src', 'alt', 'width', 'height']];

/** Problems with sanitised HTML, parsed the way a browser reads it (HTML5 parser): [] when it is safe */
function problems($html) {
	global $TAGS, $ATTRS;
	$out = [];
	$doc = \Dom\HTMLDocument::createFromString('<!doctype html><body>' . $html, LIBXML_NOERROR, 'UTF-8');
	foreach ($doc->body->querySelectorAll('*') as $el) {
		$tag = strtolower($el->localName);
		if (!isset($TAGS[$tag]) || $el->namespaceURI !== 'http://www.w3.org/1999/xhtml') { $out[] = 'element ' . $tag; }
		foreach ($el->attributes as $a) {
			$name = strtolower($a->name);
			$value = preg_replace('/[\x00-\x20\x7f]/', '', $a->value);
			if (!in_array($name, $ATTRS['*'], true) && !in_array($name, isset($ATTRS[$tag]) ? $ATTRS[$tag] : [], true)) { $out[] = "$tag @$name"; }
			if ($name === 'href' && !preg_match('/^(?:https?:|mailto:|\/|#|\.{0,2}\/)/i', $value)) { $out[] = 'href ' . $a->value; }
			if ($name === 'src' && !preg_match('/^https?:\/\//i', $value)) { $out[] = 'src ' . $a->value; }
			if ($name === 'style' && preg_match('/url|expression|binding|behaviou?r|position|@import|\\\\/i', $a->value)) { $out[] = 'style ' . $a->value; }
		}
	}
	return $out;
}

$cases = json_decode(file_get_contents(__DIR__ . '/../app/js-test/testdata/note-xss-corpus.json'), true);
check('corpus loaded', is_array($cases) && count($cases) > 40);
check('HTML5 parser available (PHP 8.4+)', noteHtmlHtml5Parser());

foreach (['html5' => true, 'libxml' => false] as $parser => $html5) {
	noteHtmlHtml5Parser($html5);
	foreach ($cases as $c) {
		$name = "[$parser] " . $c['name'];
		$out = sanitizeNoteHtml($c['input']);
		$found = problems($out);
		check($name, !$found, implode(', ', $found) . ' in ' . $out);
		foreach (isset($c['contains']) ? $c['contains'] : [] as $s) {
			check("$name contains $s", strpos($out, $s) !== false, $out);
		}
		check("$name stable", sanitizeNoteHtml($out) === $out, $out . ' => ' . sanitizeNoteHtml($out));
		check("$name no end tags on void elements", !preg_match('#</(?:br|hr|img)>#i', $out), $out);
	}
	// Serialised as HTML (not XML): void elements have no end tag, so a <br> stays one line break
	$plain = 'a<br>b<hr><img src="https://images.evetech.net/a.png" alt="x"><b>c</b>';
	check("[$parser] HTML serialisation", sanitizeNoteHtml($plain) === $plain, sanitizeNoteHtml($plain));
	check("[$parser] non-ASCII text kept", sanitizeNoteHtml('<b>Ünïcödé – 日本</b>') === '<b>Ünïcödé – 日本</b>', sanitizeNoteHtml('<b>Ünïcödé – 日本</b>'));
}
noteHtmlHtml5Parser(true);

// The older shared cases (tests/note_html_test.php) with the HTML5 parser too
$shared = json_decode(file_get_contents(__DIR__ . '/../app/js-test/testdata/note-html-cases.json'), true);
foreach ($shared as $c) {
	$out = sanitizeNoteHtml($c['input']);
	foreach (isset($c['contains']) ? $c['contains'] : [] as $s) { check('[html5] ' . $c['name'] . ' contains ' . $s, strpos($out, $s) !== false, $out); }
	foreach (isset($c['notContains']) ? $c['notContains'] : [] as $s) { check('[html5] ' . $c['name'] . ' not ' . $s, stripos($out, $s) === false, $out); }
}

// Every server path that hands notes out sanitises them (a row stored before the sanitiser existed must not leak)
$root = __DIR__ . '/..';
check('refresh.php sanitises both comment lists', substr_count(file_get_contents("$root/public/refresh.php"), "'comment' => sanitizeNoteHtml(\$row->comment)") === 2);
check('comments.php sanitises on save', strpos(file_get_contents("$root/public/comments.php"), '$comment = sanitizeNoteHtml($comment);') !== false);
check('api/comments/get.php sanitises every row', substr_count(file_get_contents("$root/api/comments/get.php"), 'sanitizeNoteHtml($row->comment)') === 2);
check('api/v1 notes sanitised', strpos(file_get_contents("$root/api/v1.inc.php"), "'html' => sanitizeNoteHtml(\$r['comment'])") !== false);

echo ($count - $failures) . "/$count passed\n";
exit($failures ? 1 : 0);
