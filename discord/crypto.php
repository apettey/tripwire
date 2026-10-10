<?php
// Fork-owned: webhook URLs at rest (see discord/discord.inc.php).
//
// A webhook URL is a bearer secret: anyone who has it can post to the channel. With DISCORD_SECRET_KEY set, URLs are
// stored encrypted (libsodium secretbox, key = BLAKE2b-256 of the setting): 'v1:' . base64(nonce . ciphertext).
// Without it they are stored as 'plain:<url>' (still never sent to a browser); the worker encrypts such rows once a
// key is configured. A row that can't be decrypted (key removed or changed) marks its webhook broken.

const DISCORD_CRYPTO_PREFIX = 'v1:';
const DISCORD_PLAIN_PREFIX  = 'plain:';

/** 32-byte key derived from DISCORD_SECRET_KEY, or null when no key is configured */
function discord_secret_key($override = null) {
    $secret = $override !== null ? $override : discord_config('DISCORD_SECRET_KEY');
    if ($secret === '') return null;
    return sodium_crypto_generichash($secret, '', SODIUM_CRYPTO_SECRETBOX_KEYBYTES);
}

function discord_encryption_enabled() {
    return discord_secret_key() !== null;
}

/** Stored form of a webhook URL (encrypted when a key is set) */
function discord_seal($url, $key = false) {
    if ($key === false) $key = discord_secret_key();
    if ($key === null) return DISCORD_PLAIN_PREFIX . $url;
    $nonce = random_bytes(SODIUM_CRYPTO_SECRETBOX_NONCEBYTES);
    return DISCORD_CRYPTO_PREFIX . base64_encode($nonce . sodium_crypto_secretbox($url, $nonce, $key));
}

/** The webhook URL from its stored form, or null when it can't be read (no key / wrong key / damaged) */
function discord_unseal($stored, $key = false) {
    $stored = (string) $stored;
    if (strpos($stored, DISCORD_PLAIN_PREFIX) === 0) return substr($stored, strlen(DISCORD_PLAIN_PREFIX));
    if (strpos($stored, DISCORD_CRYPTO_PREFIX) !== 0) return null;
    if ($key === false) $key = discord_secret_key();
    if ($key === null) return null;
    $raw = base64_decode(substr($stored, strlen(DISCORD_CRYPTO_PREFIX)), true);
    if ($raw === false || strlen($raw) <= SODIUM_CRYPTO_SECRETBOX_NONCEBYTES) return null;
    $plain = sodium_crypto_secretbox_open(substr($raw, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES),
        substr($raw, 0, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES), $key);
    return $plain === false ? null : $plain;
}

function discord_is_sealed_plain($stored) {
    return strpos((string) $stored, DISCORD_PLAIN_PREFIX) === 0;
}

/** Worker: encrypt webhook URLs stored in plain text once a key is configured. Returns the number re-sealed. */
function discord_reseal_plain(PDO $db) {
    if (!discord_encryption_enabled()) return 0;
    $rows = $db->query("SELECT id, url FROM discord_webhooks WHERE url LIKE 'plain:%'")->fetchAll(PDO::FETCH_ASSOC);
    $update = $db->prepare('UPDATE discord_webhooks SET url = ? WHERE id = ? AND url = ?');
    $count = 0;
    foreach ($rows as $row) {
        $update->execute([discord_seal(discord_unseal($row['url'])), $row['id'], $row['url']]);
        $count += $update->rowCount();
    }
    return $count;
}
