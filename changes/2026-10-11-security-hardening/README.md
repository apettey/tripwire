# Security hardening

**Date:** 2026-10-11

## Description

Three security fixes ported from mogglemoss/tripwire (MIT): system notes are sanitised with a DOM allow-list instead of a bypassable regex, firebase/php-jwt is upgraded past CVE-2021-46743, and a refused EVE token is reported to the user instead of tracking silently stopping.

## Settings

No toggle, because these are security fixes.

## Change

1. **Note / comment XSS** (adapted from mogglemoss `d9a458f`). The old regex in `comments.js` let `<img src=x onerror =alert(1)>`, `ONERROR=` and `<a href="javascript:...">` through, and the server stored and returned notes untouched.
   - New `app/js/fork/sanitise-html.js` (`sanitiseHtml`, parses with `DOMParser`, keeps allow-listed tags/attributes, http(s)/mailto/relative URLs only, safe inline styles only).
   - New `note-html.inc.php` (`sanitizeNoteHtml`, same rules with `DOMDocument`), applied in `public/comments.php` on save (503 if the DOM extension is missing) and in `public/refresh.php` on output, so existing stored notes are cleaned too.
   - Tests: `app/js-test/fork/sanitise-html.test.js` (mocha, uses jsdom, added as a devDependency) and `tests/note_html_test.php`; both run the shared cases in `app/js-test/testdata/note-html-cases.json`.
   - Smart notes are unaffected: they enhance the already sanitised DOM.
   - Not ported: the "a note must contain content" check (422) from the original; it is unrelated to the XSS fix.
2. **php-jwt 5.4 to 7.1** (CVE-2021-46743; mogglemoss `ed48079`). `composer.json`, new `composer.lock`, `vendor/`; `JWT::decode()` no longer takes an algorithm list (each JWK carries its own algorithm).
3. **Refused ESI token** (mogglemoss `23da334`). `public/refresh.php` ends the session and answers 403 when the account's SSO refresh gets `invalid_grant` (other 4xx errors are still only logged). `app/js/tripwire/esi.js` shows a yellow notice naming the tracked character the server dropped because its token was refused. The server already deleted such characters (upstream behaviour), so there is no row left to mark in the tracking list.

Upstream files touched: `app/js/tripwire/comments.js`, `app/js/tripwire/esi.js`, `public/comments.php`, `public/refresh.php`, `esi.class.php`, `composer.json`, `vendor/`, `package.json`, `package-lock.json`.

4. **Tracked characters are only dropped on a real refusal** (`public/refresh.php`): 400 with `invalid_grant`, 401 or 403. On 420/429/5xx, or while the ESI rate-limit pause is active, the character is kept (with its old token) and retried on the next poll, so a rate-limit hiccup no longer drops it or shows the notice.
5. **Sanitiser review fixes**: script/style/xmp/iframe/noscript/template/textarea/svg etc. are removed with their content (CDATA is turned into text on the server); CKEditor sizes (22/26/72px), font-family, margin/padding-left, table/td/th attributes and code/small are kept; img src must be absolute http(s); a href may be relative but not a .php path; note output without a `<` skips the DOM pass.
6. **comments.php is POST-only** (405 otherwise; the app already POSTs), so a note image pointing at our own host cannot fire a delete/sticky with a GET. Image URLs whose path ends in .php and links containing .php are dropped after percent-decoding (so `%2e` does not hide it).
