# Login page on jQuery 3.7.1

**Date:** 2026-10-24

## Description

The login/register page still loaded its own jQuery 1.7.1 (CVE-2012-6708, CVE-2015-9251, CVE-2019-11358,
CVE-2020-7656, CVE-2020-11022/11023). It now uses the jQuery 3.7.1 the main app ships, and the page navigation no longer
builds selectors from raw `location.hash` text.

## Before / After

`#register#user` deep link; the page looks the same.

| Before | After |
| --- | --- |
| ![before](before.jpg) | ![after](after.jpg) |

## Settings

No toggle: a library upgrade with no behaviour to turn off.

## Change

- `landing.php` loads `js/jquery-3.7.1.min.js` instead of `js/landing/jquery-1.7.1.min.js`, and no longer loads
  fancybox 1.3.4, jquery.easing, echoslider or touchSwipe. Nothing on the page used them (no `a.fancybox`, no
  `#slider`; fancybox also needed `$.browser`, gone since jQuery 1.9), so their files are deleted.
- `public/js/landing/landing.js`: `$("a[href*=#]")` → `$('a[href*="#"]')` (invalid selector in jQuery 3);
  `FluidNav.goTo` only accepts a page that is a plain id of a `.page` element (otherwise Login) and a plain-id tab
  section (otherwise none), so the hash can't inject selector text; the echoSlider and fancybox calls are removed.
- Kept: tipsy, mobilemenu, infieldlabel and html5shiv, which work unchanged on jQuery 3.
- Checked in the dev stack: Login/Register/Home nav, Tripwire/EVE SSO and User/Admin tabs, deep links
  (`#register#user`, `#login#reg`), hostile hashes fall back to Login, a failed and a successful Tripwire login,
  the mobile nav select, in-field labels and a tipsy tooltip; no console errors. retire.js finds nothing under
  `public/js/landing` (before: jQuery 1.7.1 flagged with the CVEs above and end-of-life).
- Upstream files touched: `landing.php`, `public/js/landing/landing.js`; upstream files deleted:
  `public/js/landing/jquery-1.7.1.min.js`, `jquery.echoslider.js`, `jquery.touchSwipe.js`, `fancybox/`.
