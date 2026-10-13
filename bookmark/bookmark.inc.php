<?php
// Fork-owned: mask-wide bookmark naming templates (Mask Admin > Bookmark names, see docker/README.md#bookmark-names).
//
// The strings Tripwire copies for the in-game bookmarks - the one for a named hole ("=A C5 ABC EOL") and the return
// bookmark after a jump ("!A") - are built in the browser from two templates per mask. The mask's owner and the owning
// corporation's Tripwire admins set them; every member of the mask reads them (public/bookmark_template.php). Nothing is
// stored for a mask until an admin saves, and the defaults are the strings Tripwire made before templates existed.
//
// The validation rules are the browser's (app/js/fork/bookmark-template.js, validate): keep the two in step;
// tests/bookmark_template_test.php and app/js-test/fork/bookmark-template.test.js use the same cases.

const BOOKMARK_MAX_OUTPUT = 50;
const BOOKMARK_MAX_TEMPLATE = 80;

const BOOKMARK_DDL = [
    // One row per mask: `data` is a JSON object {hole, back} of templates (bookmark_normalise), so more mask-wide
    // bookmark settings can be added without a schema change. Admins save in one statement (INSERT ... ON DUPLICATE KEY).
    "CREATE TABLE IF NOT EXISTS `fork_bookmark_templates` (
      `maskID` decimal(12,1) NOT NULL,
      `data` text NOT NULL,
      `updatedBy` varchar(100) NOT NULL DEFAULT '',
      `updatedAt` datetime NOT NULL,
      PRIMARY KEY (`maskID`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci",
];

function bookmark_ensure_schema(PDO $db) {
    foreach (BOOKMARK_DDL as $ddl) $db->exec($ddl);
}

/** The built-in templates: what Tripwire copied before templates existed */
function bookmark_defaults() {
    return ['hole' => '={name} {class} {sig} {life}', 'back' => '!{name}'];
}

/** The tokens: name => longest value (for the length check). Same list as the browser's bookmarkTemplate.TOKENS. */
function bookmark_tokens() {
    return [
        'name' => 'ABCDEFGHIJKL', 'sig' => 'ABC', 'sigid' => 'ABC-123', 'type' => 'K162', 'class' => 'Pochven',
        'size' => 'VL', 'life' => 'EOL', 'system' => 'ABCDEFGHIJKLM', 'dir' => 'out',
    ];
}

/** The text of a template with each token replaced from $values (name => text; strings only, unsafe characters dropped) */
function bookmark_expand($template, array $values) {
    $text = preg_replace_callback('/\{([^{}]*)\}/', function ($m) use ($values) {
        $token = strtolower($m[1]);
        if (!array_key_exists($token, bookmark_tokens())) return '';
        return preg_replace('/[^A-Za-z0-9._ -]/', '', (string) ($values[$token] ?? ''));
    }, $template);
    return trim(preg_replace('/\s+/', ' ', $text));
}

/** Why a template can't be used, or '' if it can. $kind: 'hole' | 'back'. */
function bookmark_validate($kind, $template) {
    if (!in_array($kind, ['hole', 'back'], true)) return 'Unknown template';
    if (!is_string($template) || trim($template) === '') return 'The template is empty';
    if (mb_strlen($template) > BOOKMARK_MAX_TEMPLATE) return 'The template can be at most ' . BOOKMARK_MAX_TEMPLATE . ' characters';
    if (!preg_match('/^[A-Za-z0-9 =!<>_.,:;\/|+*()\[\]#@~{}-]*$/D', $template)) {
        return 'Only letters, digits, spaces and = ! < > _ . , : ; / | + * ( ) [ ] # @ ~ - are allowed';
    }
    if (preg_match('/[{}]/', preg_replace('/\{[^{}]*\}/', '', $template))) return 'Unbalanced { } - write tokens like {name}';
    preg_match_all('/\{([^{}]*)\}/', $template, $m);
    $tokens = array_map('strtolower', $m[1]);
    foreach ($tokens as $token) {
        if (!array_key_exists($token, bookmark_tokens())) return 'Unknown token {' . $token . '}';
    }
    if (!in_array('name', $tokens, true)) return 'The template needs {name}';
    $first = substr(trim($template), 0, 1);
    if ($kind === 'back' && strpos('!<', $first) === false) return 'A return bookmark has to start with ! or <';
    if ($kind === 'hole' && strpos('!<', $first) !== false) return 'A hole bookmark can\'t start with ! or < (that marks a return bookmark)';
    if (mb_strlen(bookmark_expand($template, bookmark_tokens())) > BOOKMARK_MAX_OUTPUT) {
        return 'Too long: with the longest values it would be over ' . BOOKMARK_MAX_OUTPUT . ' characters';
    }
    return '';
}

/** The "Which signature did you jump through?" prompt, mask-wide: off, only when the automapper found no sig to tie the jump to (default), or after every jump */
const BOOKMARK_JUMP_PROMPTS = ['off', 'nomatch', 'always'];

/** Validate what an admin saves: $input has 'hole' and 'back', and optionally 'jumpPrompt' (left out = unchanged, see bookmark_save).
    Returns [clean (hole, back, jumpPrompt when given)|null, errors (kind => message)] */
function bookmark_validate_input($input) {
    $input = is_array($input) ? $input : [];
    $clean = [];
    $errors = [];
    foreach (['hole', 'back'] as $kind) {
        $value = isset($input[$kind]) && is_string($input[$kind]) ? trim($input[$kind]) : '';
        $error = bookmark_validate($kind, $value);
        if ($error !== '') $errors[$kind] = $error; else $clean[$kind] = $value;
    }
    if (array_key_exists('jumpPrompt', $input)) {
        if (is_string($input['jumpPrompt']) && in_array($input['jumpPrompt'], BOOKMARK_JUMP_PROMPTS, true)) $clean['jumpPrompt'] = $input['jumpPrompt'];
        else $errors['jumpPrompt'] = 'The jump prompt has to be off, nomatch or always';
    }
    return [$errors ? null : $clean, $errors];
}

/** The mask's templates (defaults for what is missing or no longer valid), who saved them and the jump prompt mode:
    [templates, updatedBy, updatedAt, jumpPrompt] */
function bookmark_load(PDO $db, $mask) {
    $templates = bookmark_defaults();
    $by = '';
    $at = null;
    $jumpPrompt = 'nomatch';
    $stmt = $db->prepare('SELECT `data`, updatedBy, updatedAt FROM fork_bookmark_templates WHERE maskID = ?');
    $stmt->execute([$mask]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    $data = $row ? json_decode($row['data'], true) : null;
    if (is_array($data)) {
        foreach (['hole', 'back'] as $kind) {
            if (isset($data[$kind]) && is_string($data[$kind]) && bookmark_validate($kind, $data[$kind]) === '') $templates[$kind] = $data[$kind];
        }
        if (isset($data['jumpPrompt']) && is_string($data['jumpPrompt']) && in_array($data['jumpPrompt'], BOOKMARK_JUMP_PROMPTS, true)) $jumpPrompt = $data['jumpPrompt'];
        $by = (string) $row['updatedBy'];
        $at = $row['updatedAt'];
    }
    return [$templates, $by, $at, $jumpPrompt];
}

/** Save the mask's settings. $templates: hole, back and optionally jumpPrompt (left out = keep what is stored, else the default) */
function bookmark_save(PDO $db, $mask, array $templates, $by) {
    if (!isset($templates['jumpPrompt'])) $templates['jumpPrompt'] = bookmark_load($db, $mask)[3];
    $stmt = $db->prepare('INSERT INTO fork_bookmark_templates (maskID, `data`, updatedBy, updatedAt) VALUES (?, ?, ?, UTC_TIMESTAMP())'
        . ' ON DUPLICATE KEY UPDATE `data` = VALUES(`data`), updatedBy = VALUES(updatedBy), updatedAt = VALUES(updatedAt)');
    $stmt->execute([$mask, json_encode(['hole' => $templates['hole'], 'back' => $templates['back'], 'jumpPrompt' => $templates['jumpPrompt']]), mb_substr((string) $by, 0, 100)]);
}

/** "Use the built-in names": the templates go back to the defaults, the jump prompt mode (another setting of the same row) stays as it is */
function bookmark_reset(PDO $db, $mask, $by = '') {
    $jumpPrompt = bookmark_load($db, $mask)[3];
    if ($jumpPrompt === 'nomatch') {
        $db->prepare('DELETE FROM fork_bookmark_templates WHERE maskID = ?')->execute([$mask]);
        return;
    }
    $defaults = bookmark_defaults();
    bookmark_save($db, $mask, ['hole' => $defaults['hole'], 'back' => $defaults['back'], 'jumpPrompt' => $jumpPrompt], $by);
}

/** May this character change the mask's templates: the owner of a custom mask, or a Tripwire admin of the owning corporation (the corp mask: its admins) */
function bookmark_can_edit(PDO $db, $mask, $characterID) {
    require_once(__DIR__ . '/../maskadmin/maskadmin.inc.php');
    return $characterID > 0 && maskadmin_base_level($db, (string) $mask, $characterID) !== null;
}
