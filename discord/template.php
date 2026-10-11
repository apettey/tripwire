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

const DISCORD_KINDS = ['kspace', 'chainKill', 'corpKill', 'corpLoss', 'rally', 'watchlist', 'preserveMass'];

/** Placeholders per notification type (UI help and validation) */
function discord_placeholders() {
    $common = ['pings' => 'the ping field of this type', 'mask' => 'mask name', 'system' => 'system name',
        'security' => 'security status, e.g. 0.5', 'class' => 'HS / LS / NS / C1-C6 / Thera...', 'region' => 'region',
        'map' => 'Tripwire link to the system', 'dotlan' => 'Dotlan link'];
    $kill = ['victim' => 'victim pilot', 'ship' => 'victim ship', 'corp' => 'victim corporation', 'alliance' => 'victim alliance',
        'attackers' => 'number of attacking pilots', 'finalblow' => 'final blow pilot', 'attackercorp' => 'final blow corporation',
        'isk' => 'value, e.g. 1.2b', 'zkill' => 'zKillboard link', 'time' => 'kill time (EVE time)'];
    $label = ['label' => 'chain label of the system: the name of the wormhole signature leading into it, e.g. AABCA (empty when it has none)',
        'labelSystem' => 'label and system, e.g. "AABCA · J123456", or only the system without a label'];
    return [
        'kspace'    => $common + $label + ['jumps' => 'e.g. "4 jumps from Jita"', 'hub' => 'closest ping system', 'hubjumps' => 'jumps to it',
            'hubs' => 'every ping system in range, e.g. "Jita 4, Amarr 9"', 'sig' => 'signature ID of the hole', 'hole' => 'wormhole type',
            'from' => 'system the hole is in', 'mapper' => 'who mapped it'],
        'chainKill' => $common + $label + $kill,
        'corpKill'  => $common + $label + $kill,
        'corpLoss'  => $common + $label + $kill,
        'rally'     => $common + $label + ['who' => 'who set, moved or cleared it',
            'comp' => 'the fleet comp it is for, e.g. Armor HACs (empty without one; comps: Mask Admin > Fight here)',
            'compNote' => 'the fleet comp\'s note (empty without one)',
            'withComp' => '" — comp: Armor HACs" when a fleet comp is chosen, else empty',
            'time' => 'when it was set, moved or cleared, shown in each reader\'s own time zone (Discord timestamp)',
            'rally' => 'cleared text: the fight message as it was last posted, struck through, without its pings and link line (put in front of the cleared text when it doesn\'t use {rally})',
            'was' => 'cleared text: " (was on AABCA · J123456)" when the system it was on is known, else empty'],
        'watchlist' => $common + ['filter' => 'name of the watchlist filter that matched', 'effect' => 'system effect, e.g. Wolf-Rayet (empty when none)',
            'details' => 'class and effect, e.g. "C5, Wolf-Rayet"', 'sig' => 'signature ID of the hole into the system, in the system it is off',
            'hole' => 'wormhole type of that signature (K162 when it is the exit side, empty when not scanned)', 'from' => 'system the hole is in'],
        'preserveMass' => ['pings' => 'the ping field of this type', 'mask' => 'mask name',
            'connection' => 'both ends with their chain labels, e.g. "AB · J163701 ↔ J152820" (the end closer to home first)',
            'from' => 'the end closer to home, e.g. "AB · J163701"', 'to' => 'the other end, e.g. "J152820"',
            'hole' => 'the hole\'s type seen from {from} (K162 when it was scanned on the other side, empty when unknown)',
            'class' => 'class of {to}, e.g. C5 / HS', 'details' => 'hole and class, e.g. "K162, C5"', 'sig' => 'signature ID of the hole in {from}',
            'mass' => 'mass: stable / destabilized / critical', 'life' => 'life: stable / EOL',
            'who' => 'who marked, changed or cleared it', 'reason' => 'the reason given with the mark (empty without one)',
            'withReason' => '": home static" when a reason is given, else empty', 'map' => 'Tripwire link to {from}',
            'time' => 'when it was cleared, shown in each reader\'s own time zone (Discord timestamp)',
            'mark' => 'cleared text: the mark message as it was last posted, struck through, without its pings and link line (put in front of the cleared text when it doesn\'t use {mark})'],
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
        // Only as a word of its own: not inside an address like ops@here.com
        'everyone' => (bool) preg_match('/(?<![\w@.])@(everyone|here)(?![\w@]|\.\w)/', $text),
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
    $out = preg_replace_callback('/\{([a-zA-Z]+)\}/', function ($m) use ($values, $raw) {
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
        'chainKill' => '{pings} Kill in the chain: {victim} ({corp}) lost a {ship} in {labelSystem}, {isk} ISK. {zkill}',
        'corpKill'  => '{pings} Corp kill: {victim} ({corp}) lost a {ship} in {labelSystem}, {isk} ISK, {attackers} pilots. {zkill}',
        'corpLoss'  => '{pings} Corp loss: {victim} lost a {ship} in {labelSystem}, {isk} ISK. {zkill}',
        // Fight here (the rally point, discord/rally.php): set or moved, and cleared. The cleared text replaces the fight
        // message (an edit, nobody pinged): {rally} is that message struck through
        'rally'      => "{pings} Fight here: **{labelSystem}** ({class}){withComp} — set by *{who}*\n{map}",
        'rallyClear' => "{rally}\nCleared by *{who}* at {time}",
        'watchlist'  => "{pings} Watchlist **{filter}**: **{system}** ({details}, {region}), through {sig} {hole} in {from}\n{map}",
        // Preserve mass (discord/preserve_mass.php): marked or changed, and cleared (an edit of the mark message)
        'preserveMass'      => "{pings} Preserve mass on **{connection}** ({details}) by *{who}*{withReason}\n{map}",
        'preserveMassClear' => "{mark}\nCleared by *{who}* at {time}",
    ];
}

/** Default texts of earlier versions, per type and field: a stored text equal to one of them is the default of its
    time (nobody customised it), so it is replaced by today's default (discord_template_upgrade) */
function discord_retired_templates() {
    return [
        // Kills before the chain label ({system}, not {labelSystem})
        'chainKill' => ['template' => ['{pings} Kill in the chain: {victim} ({corp}) lost a {ship} in {system}, {isk} ISK. {zkill}']],
        'corpKill'  => ['template' => ['{pings} Corp kill: {victim} ({corp}) lost a {ship} in {system}, {isk} ISK, {attackers} pilots. {zkill}']],
        'corpLoss'  => ['template' => ['{pings} Corp loss: {victim} lost a {ship} in {system}, {isk} ISK. {zkill}']],
        'rally' => [
            // 1.15 (#30), then 1.17 (#31, chain label); "Fight here" since the fleet comps
            'template' => ["{pings} Tripwire rally point from *{who}*: **{system}** ({class}, {region})\n{map}",
                "{pings} Tripwire rally point from *{who}*: **{labelSystem}** ({class}, {region})\n{map}"],
            // 1.15 (#30) and 1.17 (#31): a new "cleared" message, now an edit of the rally message
            'templateClear' => ['{pings} Tripwire rally point cleared by *{who}*', '{pings} Tripwire rally point cleared by *{who}*{was}'],
        ],
    ];
}

/** $template of $kind's $field ('template' / 'templateClear'), or today's default when it is an earlier default text */
function discord_template_upgrade($kind, $field, $template, $default = null) {
    $template = (string) $template;
    if (!in_array(trim(str_replace("\r", '', $template)), discord_retired_templates()[$kind][$field] ?? [], true)) return $template;
    return $default ?? discord_default_templates()[$field === 'templateClear' ? $kind . 'Clear' : $kind];
}

/** A Discord timestamp: each reader's client shows it in their own time zone ('t': short time, e.g. 19:08) */
function discord_timestamp($unix, $style = 't') {
    return '<t:' . (int) $unix . ':' . (preg_match('/^[tTdDfFR]$/', $style) ? $style : 't') . '>';
}

/** $text without the mentions an admin can write (<@&role>, <@user>, @here, @everyone): game data never has them
    (discord_escape), so only the admin's own pings are removed. Spaces they leave are collapsed per line. */
function discord_strip_mentions($text) {
    $text = preg_replace(['/<@[&!]?\d{17,21}>/', '/(?<![\w@.])@(everyone|here)(?![\w@]|\.\w)/'], '', (string) $text);
    return implode("\n", array_map(function ($line) { return trim(preg_replace('/[ \t]{2,}/', ' ', $line)); }, explode("\n", $text)));
}

/**
 * A rally message as it was posted, struck through for the edit that ends it: without the pings (nobody is pinged
 * again, and no live-looking @here stays), without lines that are only a link (the {map} line of the default text), each
 * remaining line struck on its own (Discord's ~~ does not span lines).
 */
function discord_rally_strike($content) {
    $lines = [];
    foreach (explode("\n", discord_strip_mentions($content)) as $line) {
        if ($line === '' || preg_match('~^<https?://[^\s<>]+>$~', $line)) continue;
        $lines[] = '~~' . $line . '~~';
    }
    return implode("\n", $lines);
}

/** "AABCA · J123456" from a chain label and a system name; only the system without a label */
function discord_label_system($label, $system) {
    $label = (string) $label;
    $system = (string) $system;
    if ($label === '') return $system;
    return $system === '' ? $label : $label . ' · ' . $system;
}

/** Embed colours */
function discord_colour($kind, $class = null) {
    if ($kind === 'kspace') return ['HS' => 0x2ecc71, 'LS' => 0xe67e22, 'NS' => 0xe74c3c][$class] ?? 0x95a5a6;
    return ['chainKill' => 0x3498db, 'corpKill' => 0x2ecc71, 'corpLoss' => 0xe74c3c, 'test' => 0x7289da, 'watchlist' => 0x4fc3f7][$kind] ?? 0x95a5a6;
}

/** One embed field (game data escaped by the caller), within Discord's limits */
function discord_field($name, $value, $inline = true) {
    return ['name' => discord_truncate($name, 256), 'value' => discord_truncate($value === '' ? '-' : $value, 1024), 'inline' => $inline];
}

/**
 * The webhook payload for a notification. $ctx: everything the message needs, resolved (names etc.):
 *   common: kind, template, ping, mask, system, systemID, security, class, region, map, dotlan, time (unix)
 *   kspace: hubs [[name, jumps], ...] (closest first), sig, hole, from, mapper, label (chain label, discord_chain_label)
 *   rally:  who, cleared, label, comp, compNote, template / templateClear (discord/rally.php; "Fight here")
 *   kills:  killID, victim, victimID, ship, shipTypeID, corp, alliance, attackers, finalblow, attackercorp, value, zkill,
 *           label (chain label on the mask, discord_chain_labels; '' = none)
 */
function discord_payload(array $ctx) {
    $kind = $ctx['kind'];
    if ($kind === 'preserveMass') return discord_preserve_payload($ctx);   // discord/preserve_mass.php
    if ($kind === 'chainPaused' || $kind === 'chainResumed') return discord_chain_notice_payload($ctx);   // discord/chain_notice.php
    $values = [
        'pings' => $ctx['ping'] ?? '', 'mask' => $ctx['mask'] ?? '', 'system' => $ctx['system'] ?? '',
        'security' => isset($ctx['security']) ? discord_security_text($ctx['security']) : '', 'class' => $ctx['class'] ?? '',
        'region' => $ctx['region'] ?? '', 'map' => isset($ctx['map']) ? '<' . $ctx['map'] . '>' : '',
        'dotlan' => isset($ctx['dotlan']) ? '<' . $ctx['dotlan'] . '>' : '',
    ];
    $raw = ['pings', 'map', 'dotlan', 'zkill'];
    $embed = ['color' => discord_colour($kind, $ctx['class'] ?? null)];
    if (!empty($ctx['time'])) $embed['timestamp'] = gmdate('Y-m-d\TH:i:s\Z', (int) $ctx['time']);
    // "J105246 (C5), E-R00028": the embed's system line, from the system as shown (with or without its chain label)
    $whereOf = function ($system) use ($ctx, $values) {
        return discord_escape($system) . ' (' . discord_escape(trim(($ctx['class'] ?? '') . ' ' . $values['security'])) . ')'
            . (!empty($ctx['region']) ? ', ' . discord_escape($ctx['region']) : '');
    };
    $where = $whereOf($ctx['system'] ?? '?');

    if ($kind === 'kspace') {
        $hubs = $ctx['hubs'] ?? [];
        $first = $hubs[0] ?? null;
        $values += [
            'jumps' => $first ? $first[1] . ' jump' . ($first[1] == 1 ? '' : 's') . ' from ' . $first[0] : '',
            'hub' => $first ? $first[0] : '', 'hubjumps' => $first ? (string) $first[1] : '',
            'hubs' => implode(', ', array_map(function ($h) { return $h[0] . ' ' . $h[1]; }, $hubs)),
            'sig' => $ctx['sig'] ?? '', 'hole' => $ctx['hole'] ?? '', 'from' => $ctx['from'] ?? '', 'mapper' => $ctx['mapper'] ?? '',
            'label' => $ctx['label'] ?? '', 'labelSystem' => discord_label_system($ctx['label'] ?? '', $ctx['system'] ?? ''),
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
    } elseif ($kind === 'rally') {
        // Short text only, no embed (the message is edited in place while the rally moves, see discord/rally.php).
        // cleared / moved: the edit that ends the rally message ($ctx['previous'], its content as last posted): struck
        // through, then who cleared it / where it moved. Such an edit pings nobody: no pings in it, no allowed mentions.
        $cleared = !empty($ctx['cleared']);
        $ending = $cleared || !empty($ctx['moved']);
        $template = $cleared ? ($ctx['templateClear'] ?? '') : ($ctx['template'] ?? '');
        $values['who'] = $ctx['who'] ?? 'someone';
        $values['label'] = $ctx['label'] ?? '';
        $values['labelSystem'] = discord_label_system($values['label'], $values['system']);
        // Cleared: the system it was on, when known. Built from escaped parts (the parentheses stay plain)
        $values['was'] = $cleared && $values['labelSystem'] !== '' ? ' (was on ' . discord_escape($values['labelSystem']) . ')' : '';
        $values['time'] = discord_timestamp($ctx['time'] ?? time());
        // The fleet comp (an admin's text, escaped like game data): {comp}, {compNote}, and {withComp} built from
        // escaped parts (" — comp: Armor HACs", or empty without a comp)
        $values['comp'] = (string) ($ctx['comp'] ?? '');
        $values['compNote'] = (string) ($ctx['compNote'] ?? '');
        $values['withComp'] = $values['comp'] !== '' ? ' — comp: ' . discord_escape($values['comp']) : '';
        $struck = $ending ? discord_rally_strike($ctx['previous'] ?? '') : '';
        // {rally} goes in last (a marker until then), so a long rally text is what gets cut, never the who / when
        $marker = $ending ? '{rally' . bin2hex(random_bytes(6)) . '}' : '';
        $values['rally'] = $cleared ? $marker : '';
        if ($ending) $values['pings'] = '';
        array_push($raw, 'was', 'time', 'rally', 'withComp');
        if (!empty($ctx['moved']) && !$cleared) {
            // Same system, only the comp changed: "Changed to"
            $content = discord_render((!empty($ctx['changed']) ? 'Changed to' : 'Moved to') . " **{labelSystem}**"
                . ($values['comp'] !== '' ? ' ({comp})' : (!empty($ctx['changed']) ? ' (no comp)' : '')) . " by *{who}* at {time}", $values, $raw);
        } else {
            $content = discord_render($template, $values, $raw);
            if ($content === '' || $content === $marker) {
                $template = discord_default_templates()[$cleared ? 'rallyClear' : 'rally'];
                $content = discord_render($template, $values, $raw);
            }
        }
        if (!$ending) {
            return ['username' => 'Tripwire', 'content' => $content, 'allowed_mentions' => discord_allowed_mentions($template, $ctx['ping'] ?? '')];
        }
        // A cleared text without {rally} (and the moved line) still ends the rally message: the struck message comes first
        $content = trim(discord_strip_mentions($content));
        if (strpos($content, $marker) === false) $content = $marker . "\n" . $content;
        $room = DISCORD_CONTENT_MAX - (mb_strlen($content) - mb_strlen($marker));
        if (mb_strlen($struck) > $room) $struck = $room > 6 ? discord_truncate($struck, $room - 2) . '~~' : '';
        $content = trim(str_replace($marker, $struck, $content));
        return ['content' => discord_truncate($content, DISCORD_CONTENT_MAX), 'allowed_mentions' => ['parse' => []]];
    } elseif ($kind === 'watchlist') {
        // discord/watchlist.php: the filter's name is admin text, everything else game data; all of it escaped
        $effect = (string) ($ctx['effect'] ?? '');
        $values += [
            'filter' => $ctx['filter'] ?? '', 'effect' => $effect,
            'details' => implode(', ', array_filter([$ctx['class'] ?? '', $effect], 'strlen')),
            'sig' => $ctx['sig'] ?? '', 'hole' => $ctx['hole'] ?? '', 'from' => $ctx['from'] ?? '',
        ];
        $through = trim(($ctx['sig'] ?? '') . ' ' . ($ctx['hole'] ?? '')) . ' in ' . ($ctx['from'] ?? '?');
        $embed += [
            'title' => discord_truncate('Watchlist: ' . discord_escape($ctx['filter'] ?? ''), 256),
            'description' => $where . ($effect !== '' ? ' · ' . discord_escape($effect) : ''),
            'fields' => [
                discord_field('Through', discord_escape($through)),
                discord_field('Links', '[Tripwire](' . ($ctx['map'] ?? '') . ')', true),
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
            'label' => $ctx['label'] ?? '', 'labelSystem' => discord_label_system($ctx['label'] ?? '', $ctx['system'] ?? ''),
        ];
        $title = ['chainKill' => 'Kill in the chain', 'corpKill' => 'Corp kill', 'corpLoss' => 'Corp loss'][$kind] ?? 'Kill';
        // The system with its chain label, when it has one: "AABCA · J105246"
        $at = discord_label_system($ctx['label'] ?? '', $ctx['system'] ?? '?');
        // Titles render markdown (bold, spoiler, code, emoji): the label is user text (a signature name), escaped there too
        $atTitle = discord_label_system(discord_escape($ctx['label'] ?? ''), $ctx['system'] ?? '?');
        $embed += [
            'title' => discord_truncate($title . ': ' . ($ctx['ship'] ?? 'ship') . ' in ' . $atTitle, 256),
            'description' => $whereOf($at),
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
