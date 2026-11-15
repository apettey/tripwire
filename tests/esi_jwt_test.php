<?php
// Fork-owned: EVE SSO access-token validation (esi::validateJWT, php-jwt 7) with stubbed tokens and a stubbed JWKS.
// Keys are generated here; nothing is fetched from EVE. No database needed.
//   docker compose -f docker-compose.dev.yml exec -T app php tests/esi_jwt_test.php
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }

define('EVE_SSO_CLIENT', 'test-client-id');
define('USER_AGENT', 'tripwire-test');
require_once(__DIR__ . '/../esi.class.php');

use Firebase\JWT\JWT;
use Firebase\JWT\JWK;
use Firebase\JWT\Key;

$failures = 0;
$count = 0;
function check($name, $ok, $detail = '') {
	global $failures, $count;
	$count++;
	if (!$ok) { $failures++; fwrite(STDERR, "FAIL $name  $detail\n"); }
}

/** esi with the JWKS stubbed (getJWKS normally fetches login.eveonline.com/oauth/jwks) */
class StubJwksEsi extends esi {
	public $jwks;
	public function getJWKS() { return $this->jwks; }
}

function b64url($bin) { return rtrim(strtr(base64_encode($bin), '+/', '-_'), '='); }
function rsaKey() { return openssl_pkey_new(['private_key_bits' => 2048, 'private_key_type' => OPENSSL_KEYTYPE_RSA]); }
function rsaJwk($key, $kid) {
	$d = openssl_pkey_get_details($key);
	return ['kty' => 'RSA', 'alg' => 'RS256', 'use' => 'sig', 'kid' => $kid, 'n' => b64url($d['rsa']['n']), 'e' => b64url($d['rsa']['e'])];
}
function pem($key) { openssl_pkey_export($key, $out); return $out; }

$eve = rsaKey();
$other = rsaKey();
$jwks = ['keys' => [rsaJwk($eve, 'JWT-Signature-Key')]];
$now = time();
$claims = function ($over = []) use ($now) {
	return array_merge([
		'scp' => ['esi-location.read_location.v1'],
		'jti' => 'abc', 'kid' => 'JWT-Signature-Key', 'sub' => 'CHARACTER:EVE:2112625428', 'azp' => 'test-client-id',
		'tenant' => 'tranquility', 'tier' => 'live', 'region' => 'world', 'aud' => ['test-client-id', 'EVE Online'],
		'name' => 'Test Pilot', 'owner' => 'xyz=', 'exp' => $now + 1200, 'iat' => $now, 'iss' => 'https://login.eveonline.com'
	], $over);
};
$validate = function ($token) use ($jwks) {
	$esi = new StubJwksEsi();
	$esi->jwks = $jwks;
	$result = $esi->validateJWT($token);
	return [$result, $esi->lastError];
};

check('php-jwt is 7.2 or newer', version_compare(\Composer\InstalledVersions::getVersion('firebase/php-jwt'), '7.2.0', '>='),
	\Composer\InstalledVersions::getVersion('firebase/php-jwt'));
check('Key API: decode() takes Key objects', JWT::decode(JWT::encode(['a' => 1], 's3cret-s3cret-s3cret-s3cret-s3cret', 'HS256'),
	new Key('s3cret-s3cret-s3cret-s3cret-s3cret', 'HS256'))->a === 1);

// A good token
[$jwt, $err] = $validate(JWT::encode($claims(), pem($eve), 'RS256', 'JWT-Signature-Key'));
check('valid token accepted', is_object($jwt), $err);
check('valid token: character id', $jwt && (int) explode(':', $jwt->sub)[2] === 2112625428);
check('valid token: name', $jwt && $jwt->name === 'Test Pilot');
[$jwt] = $validate(JWT::encode($claims(['iss' => 'login.eveonline.com']), pem($eve), 'RS256', 'JWT-Signature-Key'));
check('issuer without scheme accepted', is_object($jwt));
[$jwt] = $validate(JWT::encode($claims(['aud' => 'test-client-id']), pem($eve), 'RS256', 'JWT-Signature-Key'));
check('aud as a string accepted', is_object($jwt));

// Tokens that must fail without throwing (a failed login, not a 500)
$refused = [
	'signed by another key' => JWT::encode($claims(), pem($other), 'RS256', 'JWT-Signature-Key'),
	'unknown kid' => JWT::encode($claims(), pem($eve), 'RS256', 'other-kid'),
	'expired' => JWT::encode($claims(['exp' => $now - 3600, 'iat' => $now - 4800]), pem($eve), 'RS256', 'JWT-Signature-Key'),
	'issued in the future' => JWT::encode($claims(['iat' => $now + 3600, 'nbf' => $now + 3600]), pem($eve), 'RS256', 'JWT-Signature-Key'),
	'wrong issuer' => JWT::encode($claims(['iss' => 'https://login.evil.example']), pem($eve), 'RS256', 'JWT-Signature-Key'),
	'issuer missing' => JWT::encode(array_diff_key($claims(), ['iss' => 1]), pem($eve), 'RS256', 'JWT-Signature-Key'),
	'issued to another app' => JWT::encode($claims(['aud' => ['other-app', 'EVE Online']]), pem($eve), 'RS256', 'JWT-Signature-Key'),
	'audience missing' => JWT::encode(array_diff_key($claims(), ['aud' => 1]), pem($eve), 'RS256', 'JWT-Signature-Key'),
	'not a character' => JWT::encode($claims(['sub' => 'CORPORATION:EVE:98000001']), pem($eve), 'RS256', 'JWT-Signature-Key'),
	'malformed' => 'not.a.jwt',
	'too many segments' => str_repeat('a.', 50) . 'a',
	'empty' => '',
];
// alg=none and HS256 signed with the public key (key confusion)
$header = ['typ' => 'JWT', 'alg' => 'none', 'kid' => 'JWT-Signature-Key'];
$refused['alg none'] = b64url(json_encode($header)) . '.' . b64url(json_encode($claims())) . '.';
$publicPem = openssl_pkey_get_details($eve)['key'];
$header = ['typ' => 'JWT', 'alg' => 'HS256', 'kid' => 'JWT-Signature-Key'];
$signing = b64url(json_encode($header)) . '.' . b64url(json_encode($claims()));
$refused['HS256 signed with the RSA public key'] = $signing . '.' . b64url(hash_hmac('sha256', $signing, $publicPem, true));
// a valid signature, then the payload swapped
$good = explode('.', JWT::encode($claims(), pem($eve), 'RS256', 'JWT-Signature-Key'));
$refused['payload changed after signing'] = $good[0] . '.' . b64url(json_encode($claims(['sub' => 'CHARACTER:EVE:1']))) . '.' . $good[2];

foreach ($refused as $name => $token) {
	try {
		[$jwt, $err] = $validate($token);
		check("refused: $name", $jwt === false, var_export($jwt, true));
		check("refused: $name sets lastError", is_string($err) && $err !== '');
	} catch (\Throwable $e) {
		check("refused: $name without throwing", false, get_class($e) . ': ' . $e->getMessage());
	}
}

// No JWKS (EVE unreachable) is a failure too
$esi = new StubJwksEsi();
$esi->jwks = false;
check('no JWKS: refused', $esi->validateJWT(JWT::encode($claims(), pem($eve), 'RS256', 'JWT-Signature-Key')) === false);

// A JWKS key below php-jwt 7's minimum size is not accepted
$small = openssl_pkey_new(['private_key_bits' => 1024, 'private_key_type' => OPENSSL_KEYTYPE_RSA]);
$esi = new StubJwksEsi();
$esi->jwks = ['keys' => [rsaJwk($small, 'JWT-Signature-Key')]];
$signing = b64url(json_encode(['typ' => 'JWT', 'alg' => 'RS256', 'kid' => 'JWT-Signature-Key'])) . '.' . b64url(json_encode($claims()));
openssl_sign($signing, $sig, $small, OPENSSL_ALGO_SHA256);	// JWT::encode refuses short keys itself
try {
	$r = $esi->validateJWT($signing . '.' . b64url($sig));
	check('1024-bit RSA key refused', $r === false);
} catch (\Throwable $e) {
	check('1024-bit RSA key refused without throwing', false, get_class($e) . ': ' . $e->getMessage());
}

echo ($count - $failures) . "/$count passed\n";
exit($failures ? 1 : 0);
