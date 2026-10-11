<?php
// Adapted from mogglemoss/tripwire d9a458f (MIT).

/**
 * Sanitize rich HTML stored in system notes.
 *
 * This is intentionally enforced on the server as well as in the browser.
 * Notes are shared stored content, and an older client must never be handed
 * executable markup merely because it predates the client-side sanitizer.
 */
function noteHtmlSanitizerAvailable() {
    return class_exists('DOMDocument');
}

/**
 * Whether a note contains visible text or an actual image after sanitising.
 * Editor-only wrappers, line breaks, whitespace, and invisible spacing do not
 * make an otherwise blank note saveable.
 */
function noteHtmlHasContent($html) {
    $text = html_entity_decode(strip_tags((string)$html), ENT_QUOTES | ENT_HTML5, 'UTF-8');
    $text = preg_replace('/[\s\x{00A0}\x{200B}\x{FEFF}]+/u', '', $text);
    return $text !== '' || preg_match('/<img\b[^>]*\bsrc\s*=/i', (string)$html) === 1;
}

function sanitizeNoteHtml($html) {
    if ($html === null || $html === '') {
        return '';
    }

    // Fast path: without a '<' there is no markup to clean (entities stay escaped text).
    if (strpos((string)$html, '<') === false) {
        return (string)$html;
    }

    // Fail closed on installations missing the PHP DOM extension.
    if (!noteHtmlSanitizerAvailable()) {
        static $reportedMissingDom = false;
        if (!$reportedMissingDom) {
            error_log('Tripwire note sanitizer requires the PHP DOM extension; rendering notes as plain text.');
            $reportedMissingDom = true;
        }
        return htmlspecialchars((string)$html, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    }

    $allowedTags = array_fill_keys([
        'b', 'i', 'em', 'strong', 'u', 's', 'strike', 'sub', 'sup', 'code', 'small',
        'font', 'span', 'p', 'br', 'hr', 'div', 'pre', 'blockquote',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'ul', 'ol', 'li',
        'table', 'thead', 'tbody', 'tr', 'td', 'th',
        'a', 'img'
    ], true);
    $globalAttributes = array_fill_keys(['style', 'title', 'dir'], true);
    $tagAttributes = [
        'a' => array_fill_keys(['href', 'target', 'rel'], true),
        'font' => array_fill_keys(['color', 'size', 'face'], true),
        'table' => array_fill_keys(['border', 'cellpadding', 'cellspacing', 'align', 'width'], true),
        'td' => array_fill_keys(['colspan', 'rowspan', 'align', 'width'], true),
        'th' => array_fill_keys(['colspan', 'rowspan', 'align', 'width'], true),
        'img' => array_fill_keys(['src', 'alt', 'width', 'height'], true)
    ];
    $safeStyles = [
        'color' => '/^(?:#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([0-9.,%\s+-]+\)|[a-z]+)$/i',
        'background-color' => '/^(?:#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([0-9.,%\s+-]+\)|[a-z]+)$/i',
        'font-size' => '/^(?:(?:8|9|10|11|12|13|14|16|18|20|22|24|26|28|32|36|48|72)px|(?:0\.75|0\.875|1|1\.125|1\.25|1\.5|2|2\.5|3)(?:em|rem)|(?:75|80|87\.5|100|112\.5|125|150|200|250|300)%|xx-small|x-small|small|medium|large|x-large|xx-large)$/i',
        'text-align' => '/^(?:left|right|center|justify|start|end)$/i',
        'font-weight' => '/^(?:normal|bold|bolder|lighter|[1-9]00)$/i',
        'font-style' => '/^(?:normal|italic|oblique)$/i',
        'text-decoration' => '/^(?:(?:none|underline|overline|line-through)\s*)+$/i',
        'font-family' => '/^[a-z0-9 ,\'"\-]+$/i',
        'margin-left' => '/^\d+px$/',
        'padding-left' => '/^\d+px$/'
    ];

    $document = new DOMDocument('1.0', 'UTF-8');
    $previousErrors = libxml_use_internal_errors(true);
    $loaded = $document->loadHTML(
        '<!doctype html><html><head><meta charset="utf-8"></head><body>' . (string)$html . '</body></html>',
        LIBXML_NONET | LIBXML_NOERROR | LIBXML_NOWARNING
    );
    libxml_clear_errors();
    libxml_use_internal_errors($previousErrors);

    if (!$loaded) {
        return htmlspecialchars((string)$html, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    }

    $body = $document->getElementsByTagName('body')->item(0);
    if (!$body) {
        return '';
    }

    $cleanNode = function ($node) use (&$cleanNode, $allowedTags, $globalAttributes, $tagAttributes, $safeStyles) {
        if ($node->nodeType === XML_CDATA_SECTION_NODE) {
            // libxml would serialise CDATA raw; make it text so it is escaped
            $node->parentNode->replaceChild($node->ownerDocument->createTextNode($node->nodeValue), $node);
            return;
        }
        if ($node->nodeType === XML_COMMENT_NODE) {
            $node->parentNode->removeChild($node);
            return;
        }
        if ($node->nodeType !== XML_ELEMENT_NODE) {
            return;
        }

        $dropWithContent = ['script', 'style', 'xmp', 'iframe', 'noscript', 'template', 'object', 'embed', 'noembed', 'noframes', 'plaintext', 'textarea', 'title', 'head', 'svg', 'math'];
        if (in_array(strtolower($node->nodeName), $dropWithContent, true)) {
            $node->parentNode->removeChild($node);
            return;
        }

        // Descendants must be cleaned before a forbidden wrapper is removed;
        // otherwise newly promoted children never reach the attribute checks.
        foreach (iterator_to_array($node->childNodes) as $child) {
            $cleanNode($child);
        }

        $tag = strtolower($node->nodeName);
        if (!isset($allowedTags[$tag])) {
            $parent = $node->parentNode;
            while ($node->firstChild) {
                $parent->insertBefore($node->firstChild, $node);
            }
            $parent->removeChild($node);
            return;
        }

        $permitted = isset($tagAttributes[$tag]) ? $tagAttributes[$tag] : [];
        foreach (iterator_to_array($node->attributes) as $attribute) {
            $name = strtolower($attribute->nodeName);
            $value = $attribute->nodeValue;

            if (!isset($permitted[$name]) && !isset($globalAttributes[$name])) {
                $node->removeAttributeNode($attribute);
                continue;
            }

            if (($name === 'href' || $name === 'src') &&
                !preg_match($name === 'src' ? '/^https?:\/\//i' : '/^(?:https?:|mailto:|\/|#|\.{0,2}\/)/i', trim($value))) {
                $node->removeAttributeNode($attribute);
                continue;
            }
            if ($name === 'href' && preg_match('/\.php/i', preg_split('/[?#]/', trim($value))[0])) {
                $node->removeAttributeNode($attribute);
                continue;
            }
            if (in_array($tag, ['table', 'td', 'th'], true) && $name !== 'colspan' && $name !== 'rowspan' &&
                !preg_match('/^(?:\d+%?|left|right|center)$/i', trim($value))) {
                $node->removeAttributeNode($attribute);
                continue;
            }

            if ($name === 'style') {
                $declarations = [];
                if (!preg_match(
                    '/(?:expression|javascript:|vbscript:|url\s*\(|@import|behaviou?r\s*:|-moz-binding)/i',
                    $value
                )) {
                    foreach (explode(';', $value) as $declaration) {
                        $parts = explode(':', $declaration, 2);
                        if (count($parts) !== 2) {
                            continue;
                        }
                        $property = strtolower(trim($parts[0]));
                        $propertyValue = trim($parts[1]);
                        if (isset($safeStyles[$property]) && preg_match($safeStyles[$property], $propertyValue)) {
                            $declarations[] = $property . ': ' . $propertyValue;
                        }
                    }
                }

                if ($declarations) {
                    $node->setAttribute('style', implode('; ', $declarations));
                } else {
                    $node->removeAttributeNode($attribute);
                }
            }

            if ($tag === 'font' && $name === 'size' && !preg_match('/^[1-7]$/', trim($value))) {
                $node->removeAttribute($attribute->nodeName);
            }
        }

        if ($tag === 'a' && $node->hasAttribute('target')) {
            $node->setAttribute('rel', 'noopener noreferrer');
        }
    };

    foreach (iterator_to_array($body->childNodes) as $child) {
        $cleanNode($child);
    }

    $result = '';
    foreach ($body->childNodes as $child) {
        $result .= $document->saveHTML($child);
    }
    return $result;
}
