<?php
// Fork-owned: message templates of the Discord notifications (see discord/discord.inc.php).
//
// A template is admin-authored text with {placeholders}. Placeholder values that come from the game (pilot, corp,
// alliance, ship, system names, mapper names, signature names) are escaped: Discord markdown is backslash-escaped
// and '@' / '<@' get a zero-width space, so a pilot called "@everyone" or "<@&123>" can never ping or format.
// allowed_mentions is built only from what the admin wrote (template + the type's "ping" field): <@&role>, <@user>,
// @here/@everyone. Discord ignores every other mention in the message, so kill data can never mass-ping.

const DISCORD_CONTENT_MAX = 2000;
const DISCORD_ZWSP = "\u{200B}";

const DISCORD_KINDS = ['kspace', 'chainKill', 'corpKill', 'corpLoss'];

/** Placeholders per notification type (UI help and validation) */
function discord_placeholders() {
    $common = ['pings' => 'the ping field of this type', 'mask' => 'mask name', 'system' => 'system name',
        'security' => 'security status, e.g. 0.5', 'class' => 'HS / LS / NS / C1-C6 / Thera...', 'region' => 'region',
        'map' => 'Tripwire link to the system', 'dotlan' => 'Dotlan link'];
    $kill = ['victim' => 'victim pilot', 'ship' => 'victim ship', 'corp' => 'victim corporation', 'alliance' => 'victim alliance',
        'attackers' => 'number of attacking pilots', 'finalblow' => 'final blow pilot', 'attackercorp' => 'final blow corporation',
        'isk' => 'value, e.g. 1.2b', 'zkill' => 'zKillboard link', 'time' => 'kill time (EVE time)'];
    return [
        'kspace'    => $common + ['jumps' => 'e.g. "4 jumps from Jita"', 'hub' => 'closest ping system', 'hubjumps' => 'jumps to it',
            'hubs' => 'every ping system in range, e.g. "Jita 4, Amarr 9"', 'sig' => 'signature ID of the hole', 'hole' => 'wormhole type',
            'from' => 'system the hole is in', 'mapper' => 'who mapped it'],
        'chainKill' => $common + $kill,
        'corpKill'  => $common + $kill,
        'corpLoss'  => $common + $kill,
    ];
}

/** Escape game data for Discord: markdown characters, mentions, line breaks */
function discord_escape($text) {
    $text = preg_replace('/[\r\n\t]+/', ' ', (string) $text);
    $text = preg_replace('/([\\\\*_~`|>#\[\]()<:-])/u', '\\\\$1', $text);
    return str_replace('@', '@' . DISCORD_ZWSP, $text);
}

/** Mentions an admin wrote: ['roles' => [...], 'users' => [...], 'everyone' => bool] */
function discord_mentions_in($text) {
    $text = (string) $text;
    preg_match_all('/<@&(\d{17,21})>/', $text, $roles);
    preg_match_all('/<@!?(\d{17,21})>/', $text, $users);
    return [
        'roles'    => array_values(array_unique($roles[1])),
        'users'    => array_values(array_unique($users[1])),
        'everyone' => (bool) preg_match('/@(everyone|here)\b/', $text),
    ];
}

/** allowed_mentions for a message from the admin-authored texts only (never from game data) */
function discord_allowed_mentions(...$texts) {
    $mentions = discord_mentions_in(implode("\n", $texts));
    $allowed = ['parse' => $mentions['everyone'] ? ['everyone'] : []];
    if ($mentions['roles']) $allowed['roles'] = array_slice($mentions['roles'], 0, 100);
    if ($mentions['users']) $allowed['users'] = array_slice($mentions['users'], 0, 100);
    return $allowed;
}

/** The "ping" field of a type: only mentions (<@&id>, <@id>, @here, @everyone), space separated; null if invalid */
function discord_ping_normalise($ping) {
    $ping = trim(preg_replace('/\s+/', ' ', (string) $ping));
    if ($ping === '') return '';
    foreach (explode(' ', $ping) as $token) {
        if (!preg_match('/^(<@[&!]?\d{17,21}>|@here|@everyone)$/', $token)) return null;
    }
    return strlen($ping) <= 300 ? $ping : null;
}

/**
 * Fill a template. $values: placeholder => value; values are escaped unless the key is listed in $raw (links and
 * other text we build ourselves). Unknown placeholders stay as they are. Truncated to Discord's 2000 characters.
 */
function discord_render($template, array $values, array $raw = []) {
    $raw = array_fill_keys($raw, true);
    $out = preg_replace_callback('/\{([a-z]+)\}/', function ($m) use ($values, $raw) {
        if (!array_key_exists($m[1], $values)) return $m[0];
        $value = (string) $values[$m[1]];
        return isset($raw[$m[1]]) ? $value : discord_escape($value);
    }, (string) $template);
    $out = trim(preg_replace('/[ \t]{2,}/', ' ', $out));
    return discord_truncate($out, DISCORD_CONTENT_MAX);
}

function discord_truncate($text, $max) {
    $text = (string) $text;
    return mb_strlen($text) <= $max ? $text : mb_substr($text, 0, $max - 1) . '…';
}

/** ISK like the game's short form: 1.23b, 456.7m, 12.3k */
function discord_isk($value) {
    $value = (float) $value;
    foreach ([[1e12, 't'], [1e9, 'b'], [1e6, 'm'], [1e3, 'k']] as [$unit, $suffix]) {
        if ($value >= $unit) return rtrim(rtrim(number_format($value / $unit, $value / $unit >= 100 ? 0 : 2, '.', ''), '0'), '.') . $suffix;
    }
    return number_format($value, 0, '.', '');
}

/** Security status as EVE shows it: one decimal, rounded; anything above 0 shows at least 0.1 */
function discord_security_text($security) {
    $security = (float) $security;
    if ($security > 0 && $security < 0.05) return '0.1';
    return number_format(round($security, 1), 1, '.', '');
}

/** Default templates per type */
function discord_default_templates() {
    return [
        'kspace'    => '{pings} New k-space connection: **{system}** ({class} {security}, {region}), {jumps}. Hole {sig} in {from}, mapped by {mapper}.',
        'chainKill' => '{pings} Kill in the chain: {victim} ({corp}) lost a {ship} in {system}, {isk} ISK. {zkill}',
        'corpKill'  => '{pings} Corp kill: {victim} ({corp}) lost a {ship} in {system}, {isk} ISK, {attackers} pilots. {zkill}',
        'corpLoss'  => '{pings} Corp loss: {victim} lost a {ship} in {system}, {isk} ISK. {zkill}',
    ];
}

/** Embed colours */
function discord_colour($kind, $class = null) {
    if ($kind === 'kspace') return ['HS' => 0x2ecc71, 'LS' => 0xe67e22, 'NS' => 0xe74c3c][$class] ?? 0x95a5a6;
    return ['chainKill' => 0x3498db, 'corpKill' => 0x2ecc71, 'corpLoss' => 0xe74c3c, 'test' => 0x7289da][$kind] ?? 0x95a5a6;
}

/** One embed field (game data escaped by the caller), within Discord's limits */
function discord_field($name, $value, $inline = true) {
    return ['name' => discord_truncate($name, 256), 'value' => discord_truncate($value === '' ? '-' : $value, 1024), 'inline' => $inline];
}

/**
 * The webhook payload for a notification. $ctx: everything the message needs, resolved (names etc.):
 *   common: kind, template, ping, mask, system, systemID, security, class, region, map, dotlan, time (unix)
 *   kspace: hubs [[name, jumps], ...] (closest first), sig, hole, from, mapper
 *   kills:  killID, victim, victimID, ship, shipTypeID, corp, alliance, attackers, finalblow, attackercorp, value, zkill
 */
function discord_payload(array $ctx) {
    $kind = $ctx['kind'];
    $values = [
        'pings' => $ctx['ping'] ?? '', 'mask' => $ctx['mask'] ?? '', 'system' => $ctx['system'] ?? '',
        'security' => isset($ctx['security']) ? discord_security_text($ctx['security']) : '', 'class' => $ctx['class'] ?? '',
        'region' => $ctx['region'] ?? '', 'map' => isset($ctx['map']) ? '<' . $ctx['map'] . '>' : '',
        'dotlan' => isset($ctx['dotlan']) ? '<' . $ctx['dotlan'] . '>' : '',
    ];
    $raw = ['pings', 'map', 'dotlan', 'zkill'];
    $embed = ['color' => discord_colour($kind, $ctx['class'] ?? null)];
    if (!empty($ctx['time'])) $embed['timestamp'] = gmdate('Y-m-d\TH:i:s\Z', (int) $ctx['time']);
    $where = discord_escape($ctx['system'] ?? '?') . ' (' . discord_escape(($ctx['class'] ?? '') . ' ' . $values['security']) . ')'
        . (!empty($ctx['region']) ? ', ' . discord_escape($ctx['region']) : '');

    if ($kind === 'kspace') {
        $hubs = $ctx['hubs'] ?? [];
        $first = $hubs[0] ?? null;
        $values += [
            'jumps' => $first ? $first[1] . ' jump' . ($first[1] == 1 ? '' : 's') . ' from ' . $first[0] : '',
            'hub' => $first ? $first[0] : '', 'hubjumps' => $first ? (string) $first[1] : '',
            'hubs' => implode(', ', array_map(function ($h) { return $h[0] . ' ' . $h[1]; }, $hubs)),
            'sig' => $ctx['sig'] ?? '', 'hole' => $ctx['hole'] ?? '', 'from' => $ctx['from'] ?? '', 'mapper' => $ctx['mapper'] ?? '',
        ];
        $table = implode("\n", array_map(function ($h) { return str_pad(discord_truncate($h[0], 20), 20) . ' ' . str_pad((string) $h[1], 3, ' ', STR_PAD_LEFT); }, $hubs));
        $embed += [
            'title' => discord_truncate('New k-space: ' . ($ctx['system'] ?? '?'), 256),
            'description' => $where,
            'fields' => [
                discord_field('Hole', discord_escape(trim(($ctx['sig'] ?? '') . ' ' . ($ctx['hole'] ?? '')) . ' in ' . ($ctx['from'] ?? '?'))),
                discord_field('Mapped by', discord_escape($ctx['mapper'] ?? '')),
                discord_field('Safe jumps', $table === '' ? '-' : "```\n" . str_replace('`', "'", $table) . "\n```", false),
                discord_field('Links', '[Tripwire](' . ($ctx['map'] ?? '') . ') · [Dotlan](' . ($ctx['dotlan'] ?? '') . ')', false),
            ],
        ];
        if (!empty($ctx['map'])) $embed['url'] = $ctx['map'];
    } elseif ($kind === 'test') {
        $embed += ['title' => 'Tripwire test message', 'description' => discord_escape('Webhook "' . ($ctx['webhook'] ?? '') . '" works.')];
    } else {
        $values += [
            'victim' => $ctx['victim'] ?? '', 'ship' => $ctx['ship'] ?? '', 'corp' => $ctx['corp'] ?? '', 'alliance' => $ctx['alliance'] ?? '',
            'attackers' => (string) ($ctx['attackers'] ?? ''), 'finalblow' => $ctx['finalblow'] ?? '', 'attackercorp' => $ctx['attackercorp'] ?? '',
            'isk' => discord_isk($ctx['value'] ?? 0), 'zkill' => isset($ctx['zkill']) ? '<' . $ctx['zkill'] . '>' : '',
            'time' => !empty($ctx['time']) ? gmdate('Y-m-d H:i', (int) $ctx['time']) : '',
        ];
        $title = ['chainKill' => 'Kill in the chain', 'corpKill' => 'Corp kill', 'corpLoss' => 'Corp loss'][$kind] ?? 'Kill';
        $embed += [
            'title' => discord_truncate($title . ': ' . ($ctx['ship'] ?? 'ship') . ' in ' . ($ctx['system'] ?? '?'), 256),
            'description' => $where,
            'fields' => [
                discord_field('Victim', discord_escape($ctx['victim'] ?? '?') . "\n" . discord_escape(trim(($ctx['corp'] ?? '') . (!empty($ctx['alliance']) ? ' / ' . $ctx['alliance'] : '')))),
                discord_field('Final blow', discord_escape($ctx['finalblow'] ?? '?') . "\n" . discord_escape($ctx['attackercorp'] ?? '')),
                discord_field('Attackers', (string) (int) ($ctx['attackers'] ?? 0)),
                discord_field('Value', discord_isk($ctx['value'] ?? 0) . ' ISK'),
            ],
        ];
        if (!empty($ctx['zkill'])) $embed['url'] = $ctx['zkill'];
        if (!empty($ctx['shipTypeID'])) $embed['thumbnail'] = ['url' => 'https://images.evetech.net/types/' . (int) $ctx['shipTypeID'] . '/render?size=128'];
        if (!empty($ctx['victimID'])) $embed['author'] = ['name' => discord_truncate($ctx['victim'] ?? '', 256), 'icon_url' => 'https://images.evetech.net/characters/' . (int) $ctx['victimID'] . '/portrait?size=64'];
    }
    if (!empty($ctx['mask'])) $embed['footer'] = ['text' => discord_truncate('Tripwire · ' . $ctx['mask'], 2048)];

    $template = $ctx['template'] ?? '';
    $content = $kind === 'test' ? trim(($ctx['ping'] ?? '') . ' Tripwire test message for "' . discord_escape($ctx['webhook'] ?? '') . '"')
        : discord_render($template, $values, $raw);
    return [
        'username' => 'Tripwire',
        'content' => $content,
        'embeds' => [$embed],
        'allowed_mentions' => discord_allowed_mentions($template, $ctx['ping'] ?? ''),
    ];
}
