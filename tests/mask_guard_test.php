<?php
// Fork-owned: unit tests for mask-guard.inc.php (no database needed).
//   docker compose -f docker-compose.dev.yml exec -T app php tests/mask_guard_test.php
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }

require_once(__DIR__ . '/../mask-guard.inc.php');

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

// Canonical spellings
foreach ([
    '12.0' => '12.0', '12.1' => '12.1', '12.2' => '12.2', '12.3' => '12.3', '012.0' => '12.0', '000012.2' => '12.2',
    '2112345678.1' => '2112345678.1', '9999999999.0' => '9999999999.0', '0000000001.3' => '1.3',
] as $in => $out) {
    check("canonical " . json_encode((string) $in), tripwire_mask_canonical((string) $in), $out);
}
// Rejected
foreach ([
    '12.0abc', '12.00', '12.', '.0', '12', '12.4', '12.9', '12.0.0', ' 12.0', '12.0 ', "12.0\n", "12.0\r\n", "\t12.0", '+12.0',
    '-12.0', '1e1.0', '12.0e0', '120e-1', '0x0C.0', '12,0', '0.0', '00.2', '', 'abc', '12345678901.0', '١٢.0', "12\x00.0",
] as $in) {
    check("rejected " . json_encode($in), tripwire_mask_canonical($in), null);
}
foreach ([12.0, 12, 12.1, true, false, null, ['12.0'], (object) ['a' => '12.0']] as $in) {
    check("rejected non-string " . json_encode($in), tripwire_mask_canonical($in), null);
}

// Access rules for character / corporation / alliance masks (custom masks need the database; tests/mask_access_test.php)
$session = ['characterID' => 1001, 'corporationID' => '2002', 'allianceID' => 3003];
check('own character mask', tripwire_mask_allowed('1001.1', $session, null), '1001.1');
check('own character mask, leading zero', tripwire_mask_allowed('01001.1', $session, null), '1001.1');
check('other character mask -> own', tripwire_mask_allowed('1002.1', $session, null), '1001.1');
check('own corporation mask', tripwire_mask_allowed('2002.2', $session, null), '2002.2');
check('other corporation mask -> own corporation', tripwire_mask_allowed('2003.2', $session, null), '2002.2');
check('own alliance mask', tripwire_mask_allowed('3003.3', $session, null), '3003.3');
check('other alliance mask -> own alliance', tripwire_mask_allowed('3004.3', $session, null), '3003.3');
check('alliance mask without an alliance -> corporation', tripwire_mask_allowed('3003.3', ['allianceID' => null] + $session, null), '2002.2');
check('custom mask without a database -> corporation', tripwire_mask_allowed('4004.0', $session, null), '2002.2');
foreach (['1001.1x', '2002.20', '2003.2x', '4004.0abc', '4004.', ['4004.0'], 4004.0] as $bad) {
    check('malformed ' . json_encode($bad) . ' -> corporation', tripwire_mask_allowed($bad, $session, null), '2002.2');
}

echo ($failures ? "FAILED $failures of $count checks\n" : "OK $count checks\n");
exit($failures ? 1 : 0);
