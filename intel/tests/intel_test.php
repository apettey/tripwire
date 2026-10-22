<?php
// Fork-owned: tests for the pure parts of intel/intel.inc.php (parsing and validation); no database, no network.
//   docker compose -f docker-compose.dev.yml exec -T app php intel/tests/intel_test.php
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }

require_once(__DIR__ . '/../intel.inc.php');

$failures = 0;
$count = 0;
function check($name, $actual, $expected) {
    global $failures, $count;
    $count++;
    if ($actual !== $expected) {
        $failures++;
        fwrite(STDERR, "FAIL $name\n  expected: " . var_export($expected, true) . "\n  actual:   " . var_export($actual, true) . "\n");
    }
}

// --- Distances ---
check('km with comma', intel_parse_distance_km('1,234 km'), 1234.0);
check('km with dot (German)', intel_parse_distance_km('1.234 km'), 1234.0);
check('km with non-breaking space', intel_parse_distance_km("12\xC2\xA0345 km"), 12345.0);
check('km with narrow non-breaking space', intel_parse_distance_km("12\xE2\x80\xAF345 km"), 12345.0);
check('km with apostrophe', intel_parse_distance_km("12'345 km"), 12345.0);
check('metres', intel_parse_distance_km('3,225 m'), 3.2);
check('AU', intel_parse_distance_km('4.2 AU'), round(4.2 * INTEL_AU_KM, 1));
check('AU German', intel_parse_distance_km('4,2 AE'), round(4.2 * INTEL_AU_KM, 1));
check('AU Russian', intel_parse_distance_km('10,4 а.е.'), round(10.4 * INTEL_AU_KM, 1));
check('AU half tenth rounds up (1.5)', intel_parse_distance_km('1.5 AU'), 224396806.1);
check('AU half tenth rounds up (3.5)', intel_parse_distance_km('3.5 AU'), 523592547.5);
check('AU half tenth rounds up (8.5)', intel_parse_distance_km('8.5 AU'), 1271581901.0);
check('Russian km', intel_parse_distance_km('2 500 км'), 2500.0);
check('dash', intel_parse_distance_km('-'), null);
check('empty', intel_parse_distance_km(''), null);
check('unknown unit', intel_parse_distance_km('12 parsecs'), null);
check('garbage', intel_parse_distance_km('<img src=x onerror=alert(1)>'), null);
check('14.3 AU is in range', intel_parse_distance_km('14.3 AU'), round(14.3 * INTEL_AU_KM, 1));
check('beyond d-scan range', intel_parse_distance_km('999999999999999999999 km'), null);
check('16 AU is beyond range', intel_parse_distance_km('16 AU'), null);
check('Unicode spaces around the value', intel_parse_distance_km("\u{00A0}1,234\u{00A0}km\u{2003}"), 1234.0);
check('bidi control before the value', intel_parse_distance_km("\u{202E}1,234 km"), 1234.0);

// --- Kind detection ---
check('detect dscan', intel_detect_kind("670\tCapsule\tCapsule\t-"), 'dscan');
check('detect local', intel_detect_kind("Chribba\nSome Pilot"), 'local');

// --- D-scan: current format with type IDs ---
$dscan = "22456\tBob's Sabre\tSabre\t1,234 km\r\n"
    . "12034\tHound\tHound\t12 km\n"
    . "\n"
    . "35832\tJ123456 - Home\tAstrahus\t4.2 AU\n"
    . "670\tCapsule\tCapsule\t-\n"
    . "abc\tbroken\n";
$parsed = intel_parse_dscan($dscan);
check('dscan rows', $parsed['rows'], [
    [22456, 'Sabre', "Bob's Sabre", 1234.0],
    [12034, 'Hound', 'Hound', 12.0],
    [35832, 'Astrahus', 'J123456 - Home', round(4.2 * INTEL_AU_KM, 1)],
    [670, 'Capsule', 'Capsule', null],
]);
check('dscan invalid lines counted', $parsed['invalid'], 1);

// --- D-scan: older format without type IDs ---
$old = intel_parse_dscan("+\tNoctis\t3,225 m\nsome dude's Stabber Fleet Issue\tStabber Fleet Issue\t-\nOtanuomi V - Moon 11\tMoon\t10.4 AU");
check('old format rows', array_map(function ($r) { return [$r[0], $r[1]]; }, $old['rows']), [[null, 'Noctis'], [null, 'Stabber Fleet Issue'], [null, 'Moon']]);

// --- D-scan: hostile and odd content is kept as text (the browser escapes it), control characters dropped ---
$hostile = intel_parse_dscan("22456\t<img src=x onerror=alert(1)>\tSabre\t5 km\n0\tZero\tSabre\t5 km\n1\tName\t\t5 km\n" . "11567\t" . str_repeat('A', 300) . "\tAvatar\t-");
check('hostile name kept verbatim', $hostile['rows'][0][2], '<img src=x onerror=alert(1)>');
check('type ID 0 and empty type are invalid', $hostile['invalid'], 2);
check('long names cut', mb_strlen($hostile['rows'][1][2]), INTEL_FIELD_MAX);
check('control characters dropped', intel_clean_field("ab\x07c\x1b"), 'abc');
check('bidi and format characters dropped', intel_parse_dscan("22456\tEvil\u{202E}epyT\u{200B}\tSabre\t5 km")['rows'][0][2], 'EvilepyT');
check('type ID with non-breaking spaces', intel_parse_dscan("\u{00A0}22456\u{00A0}\tSabre\tSabre\t5 km")['rows'][0][0], 22456);

// --- Local ---
$local = intel_parse_local("Chribba\n  Some Pilot  \nchribba\nO'Neil Smith-Jones\n<script>alert(1)</script>\nab\n" . str_repeat('x', 40) . "\nZoë Mäkinen");
check('local names: unique, trimmed, valid', $local['names'], ['Chribba', 'Some Pilot', "O'Neil Smith-Jones", 'Zoë Mäkinen']);
check('local invalid lines', $local['invalid'], 3);
$nbsp = intel_parse_local("\u{00A0}Some\u{00A0}Pilot\u{00A0}\n\u{00A0}\u{3000}\nAnn\u{2003}Example");
check('non-breaking spaces count as spaces (same as the browser)', [$nbsp['names'], $nbsp['invalid']], [['Some Pilot', 'Ann Example'], 0]);
check('only invisible characters: nothing pasted', intel_parse("\u{00A0}\n\u{200B}"), [null, 'Nothing pasted']);
check('have param', intel_have_param('3, 5,x,-1,0,5,' . str_repeat('7,', 10)), [3, 5, 7]);

// --- intel_parse: limits and errors ---
check('empty paste', intel_parse('  '), [null, 'Nothing pasted']);
check('not a string', intel_parse(['x']), [null, 'Nothing pasted']);
check('too big', intel_parse(str_repeat('a', INTEL_MAX_BYTES + 1))[0], null);
check('too many lines', intel_parse(str_repeat("Pilot Name\n", INTEL_MAX_LINES + 1))[0], null);
check('max lines ok', intel_parse(str_repeat("Pilot Name\n", INTEL_MAX_LINES))[0], 'local');
check('invalid UTF-8', intel_parse("Pilot\xFF\xFE"), [null, 'The text is not valid UTF-8']);
check('d-scan without valid rows', intel_parse("a\tb")[0], null);
check('local without valid names', intel_parse("<b>\n!!")[0], null);
[$kind, $data] = intel_parse("22456\tSabre\tSabre\t10 km");
check('valid d-scan', [$kind, count($data['rows'])], ['dscan', 1]);

echo "$count checks, $failures failures\n";
exit($failures ? 1 : 0);
