"""Capture Startup Radar screenshots and assert the frontend rules in a real browser.

Usage (from the repo root, server already running on BASE_URL):
    python scripts/screenshots.py              # parity mode (needs the Express /api)
    SMOKE_ONLY=1 python scripts/screenshots.py # smoke mode (static files only)

Environment:
    BASE_URL      default http://localhost:3000 (a sub-path such as
                  http://localhost:8080/startup-radar is fine)
    PW_CHANNEL    chromium channel, default "msedge" (bundled browsers are not
                  installed on the dev machine; "chrome" also works)
    SMOKE_ONLY    "1" = static-file checks only (home + sources + the trends,
                  funding and YC lens pages against their JSON + the notebook
                  page over localStorage + mobile + the deep link + the service
                  worker incl. notebook survival), usable against GitHub Pages
                  or a dist/ preview. Writes no PNGs.
    STATIC_ROOT   smoke mode only: the directory the server serves BASE_URL
                  from. When set, the service-worker update flow is proven by
                  really deploying a second sw.js version there (restored
                  afterwards); otherwise the flow is attempted with a routed
                  sw.js and recorded as such.
    SCENARIOS     comma-separated scenario names to run instead of the full set
                  (iteration aid), e.g. SCENARIOS=run_drawer,run_sw

Parity mode writes VIEWPORT-ONLY screenshots (never full-page) to docs/screenshots/:
    home.png              desktop 1280x900, dark, unfiltered feed
    home-filtered.png     desktop 1280x900, dark, kind=funding + USA scope
    sources.png           desktop 1280x900, dark, /sources.html
    home-mobile.png       mobile 390x844 at 2x (780x1688 px), dark
    home-dark.png         desktop 1920x1080, dark (three columns + radar panel)
    home-light.png        desktop 1280x900, light theme
    detail.png            desktop 1280x900, dark, detail drawer open
    home-mobile-sheet.png mobile 390x844 at 2x, dark, filter sheet open

Every check prints "PASS  <name>  (<detail>)" or "FAIL ...". Exit code is 1
when any check fails. Parity filter checks compare what the page renders
(client-side filtering of ./data/items.json) against what /api/items returns
for the same query, with the export window (last 90 days) applied to the API.
The audit matrix (design.md section 20) runs every page x width x theme x state
through computed-style checks: font floor, control heights, composited WCAG
contrast against the nearest opaque surface (glass bars against the glass
extreme, body against the dot composite, radar text against its plate), no
horizontal overflow, honest numbers and the review findings of
.agents/tasks/ui-redesign/design-review.md.
"""

import json
import math
import os
import re
import struct
import sys
import time
import traceback
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlencode, urlsplit

from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE_URL", "http://localhost:3000").rstrip("/")
ORIGIN = "%s://%s" % (urlsplit(BASE).scheme, urlsplit(BASE).netloc)
OUT = Path(__file__).resolve().parents[1] / "docs" / "screenshots"
CHANNEL = os.environ.get("PW_CHANNEL", "msedge")
SMOKE_ONLY = os.environ.get("SMOKE_ONLY") == "1"
STATIC_ROOT = os.environ.get("STATIC_ROOT", "").strip()
SCENARIOS = [s.strip() for s in os.environ.get("SCENARIOS", "").split(",") if s.strip()]
WAIT_MS = 30000
DESKTOP = {"width": 1280, "height": 900}
WIDE = {"width": 1920, "height": 1080}
TABLET = {"width": 768, "height": 1024}
MOBILE = {"width": 390, "height": 844}
MOBILE_SCALE = 2
PAGE_SIZE = 30
EXPORT_MAX_DAYS = 90  # mirrors EXPORT_LIMITS.maxDays in src/export.js
ITEMS_PATH = "/data/items.json"
API_ITEMS_PATH = "/api/items"
# A whole ASCII word (>= 4 letters) that is also a whole token for filter.js / FTS5:
# not glued to another letter or digit on either side.
WORD_RE = r"(?<![^\W_])[A-Za-z]{4,}(?![^\W_])"
MIN_FONT_PX = 12
MIN_BODY_FONT_PX = 16
CONTROL_MIN_PX = 40
CONTROL_MAX_PX = 44
MAX_PNG_BYTES = 1024 * 1024
MIN_PNG_BYTES = 20 * 1024
GLASS_EXTREME = {"dark": "#21252D", "light": "#DDE0E5"}
DOT_COMPOSITE = {"dark": "#161A21", "light": "#E6E9ED"}
SHELL = ["./", "./index.html", "./sources.html", "./trends.html", "./funding.html", "./yc.html", "./notebook.html", "./styles.css", "./sources.css", "./pages.css", "./theme.js", "./ui.js", "./app.js", "./filter.js", "./format.js", "./radar.js", "./sources.js", "./trends.js", "./funding.js", "./yc.js", "./notebook.js", "./lens.js", "./nav.js", "./shell.js", "./drawer.js", "./notebook-store.js", "./notebook-tools.js", "./related.js", "./text.js", "./pwa.js", "./icons.svg", "./manifest.webmanifest"]
# page kind -> index of its link in NAV (audit_state asserts aria-current there)
NAV_INDEX = {"home": 0, "trends": 1, "funding": 2, "yc": 3, "notebook": 4, "sources": 5}
# lens pages (FEAT-003/004): (kind, path, selector that proves the data rendered)
LENS_PAGES = [("trends", "/trends.html", "#sector-grid .sparkline"), ("funding", "/funding.html", "#funding-table tbody tr"), ("yc", "/yc.html", "#industry-groups details"), ("notebook", "/notebook.html", "#main[data-ready]")]
NOTEBOOK_KEY = "sr:notebook:v1"
NOTEBOOK_BANNER = "Stored in this browser only \u2014 export to keep it."
SHORTCUT_KEYS = ["/", "j", "k", "\u2193", "\u2191", "Home", "End", "Enter", "o", "Esc", "t", "?", "\u2190", "\u2192", "g"]
# nav.js NAV in order (label, href); every page ships this static list and the shell re-fills it
NAV = [("Feed", "./index.html"), ("Trends", "./trends.html"), ("Funding", "./funding.html"), ("YC", "./yc.html"), ("Notebook", "./notebook.html"), ("Sources", "./sources.html")]

KIND_LABELS = [
    ("launch", "Launch"),
    ("funding", "Funding"),
    ("news", "News"),
    ("accelerator", "Accelerator"),
]
REGION_LABELS = [
    ("usa", "USA"),
    ("europe", "Europe"),
    ("asia", "Asia"),
    ("india", "India"),
    ("latam", "Latin America"),
    ("africa", "Africa"),
    ("global", "Global"),
]
REGION_ORDER = [r for r, _ in REGION_LABELS]
KIND_ORDER = [k for k, _ in KIND_LABELS]

results = []


def check(name, ok, detail=""):
    status = "PASS" if ok else "FAIL"
    line = "%s  %s" % (status, name)
    if detail:
        line += "  (%s)" % detail
    print(line)
    results.append(bool(ok))
    return bool(ok)


def item_key(url):
    """Same as itemKey() in public/filter.js: 64-bit FNV-1a of the UTF-8 url, base 36."""
    h = 0xCBF29CE484222325
    for b in str(url if url is not None else "").encode("utf-8"):
        h ^= b
        h = (h * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    if h == 0:
        return "0"
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    while h:
        out = digits[h % 36] + out
        h //= 36
    return out


# ---------------------------------------------------------------------------
# JavaScript evaluated in the page. Each snippet returns plain JSON data only.
# wait_for_function snippets must be arrow functions (the CSP forbids eval).
# ---------------------------------------------------------------------------

# Shared colour / geometry helpers, prepended to the audit snippets.
JS_PRELUDE = r"""
  const px = (v) => parseFloat(v) || 0;
  const rect = (el) => el.getBoundingClientRect();
  // checkVisibility() also excludes closed <details> content, which Chromium keeps in layout under content-visibility: hidden.
  const visible = (el) => { const r = rect(el); return r.width > 0 && r.height > 0 && (!el.checkVisibility || el.checkVisibility({ visibilityProperty: true })); };
  const describe = (el) => { let d = el.tagName.toLowerCase(); if (el.id) d += '#' + el.id; else if (el.classList && el.classList.length) d += '.' + el.classList[0]; return d; };
  const parseColor = (s) => {
    if (!s || s === 'none' || s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(s);
    if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
    const h = /^#([0-9a-f]{6})$/i.exec(s.trim());
    if (h) { const n = parseInt(h[1], 16); return { r: n >> 16, g: (n >> 8) & 255, b: n & 255, a: 1 }; }
    const h3 = /^#([0-9a-f]{3})$/i.exec(s.trim());
    if (h3) { const n = parseInt(h3[1].split('').map((c) => c + c).join(''), 16); return { r: n >> 16, g: (n >> 8) & 255, b: n & 255, a: 1 }; }
    const m2 = /^rgba?\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.%]+)\s*)?\)$/.exec(s);
    if (m2) return { r: +m2[1], g: +m2[2], b: +m2[3], a: m2[4] === undefined ? 1 : (m2[4].endsWith('%') ? parseFloat(m2[4]) / 100 : +m2[4]) };
    return null;
  };
  const rootStyle = getComputedStyle(document.documentElement);
  const token = (name) => parseColor(rootStyle.getPropertyValue(name).trim());
  const chan = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const lum = (c) => 0.2126 * chan(c.r) + 0.7152 * chan(c.g) + 0.0722 * chan(c.b);
  const ratio = (a, b) => { const la = lum(a), lb = lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
  const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
  const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
  const same = (a, b, tol = 1.5) => !!a && !!b && Math.abs(a.r - b.r) <= tol && Math.abs(a.g - b.g) <= tol && Math.abs(a.b - b.b) <= tol;
  const BG0 = token('--bg-0'), FG0 = token('--fg-0'), FG1 = token('--fg-1'), FG2 = token('--fg-2');
  const GLASS = over({ ...FG0, a: 0.10 }, BG0);
  const DOT = over(token('--dot'), BG0);
  const isGlass = (node) => node.matches && (node.matches('.topbar, header.site-header') || (node.id === 'filter-panel' && getComputedStyle(node).position === 'sticky'));
  const isSvgText = (el) => el.namespaceURI === 'http://www.w3.org/2000/svg' && el.tagName === 'text';
  const surfaceOf = (el) => {
    if (!el) return { color: DOT, glass: false, note: 'root' };
    const layers = [];
    let base = null, glass = false, note = '';
    if (el.closest('#new-items')) { base = parseColor(getComputedStyle(document.getElementById('new-items')).backgroundColor); note = 'pill'; }
    else if (el.closest('.alert')) { base = parseColor(getComputedStyle(el.closest('.alert')).backgroundColor); note = 'alert'; }
    else if (isSvgText(el) && el.closest('svg.radar')) {
      const p = el.previousElementSibling;
      if (!p || !p.matches('rect.radar-plate')) return { error: 'radar text without a plate: ' + el.textContent };
      base = parseColor(getComputedStyle(p).fill); note = 'plate';
    } else if (el.tagName === 'CAPTION') { base = DOT; note = 'caption-on-body'; }
    else {
      let node = el;
      while (node && node !== document.documentElement) {
        if (isGlass(node)) { base = GLASS; glass = true; note = 'glass'; break; }
        if (node === document.body) { base = DOT; note = 'body'; break; }
        const bg = parseColor(getComputedStyle(node).backgroundColor);
        if (!bg) return { error: 'unparsable background ' + getComputedStyle(node).backgroundColor + ' on ' + describe(node) };
        if (bg.a >= 0.999) { base = bg; break; }
        if (bg.a > 0) layers.unshift(bg);
        node = node.parentElement;
      }
      if (!base) base = DOT;
    }
    let c = base;
    for (const l of layers) c = over(l, c);
    return { color: c, glass, note };
  };
"""

# Current result list as rendered.
SNAPSHOT_JS = r"""
() => {
  const text = (el) => (el ? el.textContent.trim() : '');
  const countText = text(document.querySelector('#result-count'));
  const m = /^(\d+) (?:recent )?items/.exec(countText);
  const total = m ? parseInt(m[1], 10) : (countText.startsWith('No items') ? 0 : null);
  const cards = Array.from(document.querySelectorAll('#results article')).map((a) => {
    const t = a.querySelector('time');
    const kindBadge = a.querySelector('.badge:not(.badge-source):not(.badge-region):not(.badge-sector)');
    return {
      title: text(a.querySelector('h2 a')),
      source: text(a.querySelector('.badge-source')),
      kind: text(kindBadge),
      region: text(a.querySelector('.badge-region')),
      time: t ? t.getAttribute('datetime') : null,
      text: text(a),
      key: a.dataset.key || null,
    };
  });
  const lm = document.querySelector('#load-more');
  return {
    total,
    countText,
    shown: cards.length,
    cards,
    loadMoreVisible: !!lm && !lm.hidden && lm.getBoundingClientRect().height > 0,
    emptyShown: !!document.querySelector('#results .empty'),
    search: location.search,
  };
}
"""

# True once the URL query matches `expected` ({key: value}, where an empty
# string means "key must be absent") and the results list is no longer
# loading. Filter handlers update the URL and set aria-busy="true" in the
# same synchronous tick, so this cannot pass early.
WAIT_STATE_JS = r"""
(expected) => {
  const p = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(expected)) {
    if (v === '') {
      if (p.has(k)) return false;
    } else if (p.get(k) !== v) {
      return false;
    }
  }
  const r = document.querySelector('#results');
  return !!r && r.getAttribute('aria-busy') === 'false';
}
"""

# Nothing but the intentional loops (sweeps, live dot, fresh blips, skeleton) is animating.
SETTLED_JS = r"""
() => document.getAnimations().filter((a) => a.playState === 'running' && !(a.effect && a.effect.target && a.effect.target.closest && a.effect.target.closest('.radar-mark, .radar-sweep, .live-dot, .blip.is-fresh, .skeleton'))).length === 0
"""

# Computed-style audit over every visible element (the original harness contract).
UI_AUDIT_JS = r"""
() => {
  const px = (v) => parseFloat(v) || 0;
  const rect = (el) => el.getBoundingClientRect();
  const visible = (el) => {
    const r = rect(el);
    return r.width > 0 && r.height > 0 && (!el.checkVisibility || el.checkVisibility({ visibilityProperty: true }));
  };
  const describe = (el) => {
    let d = el.tagName.toLowerCase();
    if (el.id) d += '#' + el.id;
    else if (el.classList.length) d += '.' + el.classList[0];
    return d;
  };

  const bodyFontSize = px(getComputedStyle(document.body).fontSize);

  let minFont = Infinity;
  let minFontDesc = '';
  let visibleEls = 0;
  for (const el of document.body.querySelectorAll('*')) {
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden') continue;
    visibleEls += 1;
    const size = px(cs.fontSize);
    if (size < minFont) {
      minFont = size;
      minFontDesc = describe(el);
    }
  }

  // Interactive controls. A checkbox is measured by its wrapping <label>,
  // which is the element the user actually clicks or taps.
  const controls = [];
  for (const el of document.querySelectorAll('button, input, select, summary')) {
    if (!visible(el)) continue;
    let target = el;
    let viaLabel = false;
    if (el instanceof HTMLInputElement && el.type === 'checkbox') {
      const label = el.closest('label');
      if (label) {
        target = label;
        viaLabel = true;
      }
    }
    controls.push({ desc: describe(el), height: rect(target).height, viaLabel });
  }

  const blankLinks = Array.from(document.querySelectorAll('a[target="_blank"]'));
  const badLinks = blankLinks.filter(
    (a) => !/\bnoopener\b/.test(a.rel) || !/\bnoreferrer\b/.test(a.rel)
  ).length;

  return {
    bodyFontSize,
    minFont: minFont === Infinity ? null : minFont,
    minFontDesc,
    visibleEls,
    controls,
    blankLinks: blankLinks.length,
    badLinks,
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    lastRefreshed: /Last refreshed/.test(document.body.innerText),
  };
}
"""

LAST_REFRESHED_JS = r"""
() => {
  const el = document.querySelector('#last-refreshed');
  return el ? el.textContent.trim() : '';
}
"""

SOURCES_PAGE_JS = r"""
() => {
  const text = (el) => (el ? el.textContent.trim() : '');
  const rows = Array.from(document.querySelectorAll('#sources-table tbody tr')).map((tr) => {
    const cells = Array.from(tr.children).map((c) => text(c));
    const link = tr.querySelector('th a');
    return {
      cells,
      href: link ? link.getAttribute('href') : null,
      target: link ? link.getAttribute('target') : null,
      rel: link ? link.getAttribute('rel') : null,
    };
  });
  const explore = Array.from(document.querySelectorAll('#explore-list li a')).map((a) => ({
    text: text(a),
    href: a.getAttribute('href'),
    target: a.getAttribute('target'),
    rel: a.getAttribute('rel'),
  }));
  return {
    rows,
    explore,
    exploreHeading: text(document.querySelector('#explore-heading')),
    status: text(document.querySelector('#status')),
    lastRefreshed: /Last refreshed/.test(document.body.innerText),
  };
}
"""

# Composited WCAG contrast audit (design.md 5.2 / 19 / AC 4). Returns counts, worst pairs and failures.
CONTRAST_AUDIT_JS = r"""
(theme) => {
""" + JS_PRELUDE + r"""
  const expectGlass = parseColor(theme === 'light' ? '#DDE0E5' : '#21252D');
  const expectDot = parseColor(theme === 'light' ? '#E6E9ED' : '#161A21');
  const failures = [];
  const textPairs = [];
  const nonText = [];
  const opaqueOk = (el) => {
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      if (getComputedStyle(n).opacity !== '1' && !(n.closest && n.closest('.skeleton'))) return false;
    }
    return true;
  };
  const hasText = (el) => Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim() !== '');
  const pushText = (el, fg, surf, label) => {
    if (!surf || surf.error) { failures.push((surf && surf.error) || ('no surface for ' + describe(el))); return; }
    const r = ratio(fg, surf.color);
    textPairs.push({ sel: label || describe(el), fg: hex(fg), bg: hex(surf.color), ratio: +r.toFixed(2), glass: surf.glass, note: surf.note });
    if (r < 4.5) failures.push('text ' + (label || describe(el)) + ' ' + hex(fg) + ' on ' + hex(surf.color) + ' (' + surf.note + ') = ' + r.toFixed(2));
    if (surf.glass && !(same(fg, FG0) || same(fg, FG1))) failures.push('glass text ' + (label || describe(el)) + ' uses ' + hex(fg) + ' (only --fg-0/--fg-1 allowed on the bars)');
  };
  for (const el of document.body.querySelectorAll('*')) {
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    if (el.tagName === 'SELECT') { pushText(el, parseColor(cs.color), surfaceOf(el), describe(el) + '(select)'); continue; }
    if (el.tagName === 'INPUT' && (el.type === 'search' || el.type === 'text')) {
      pushText(el, parseColor(cs.color), surfaceOf(el), describe(el) + '(value)');
      const ph = parseColor(getComputedStyle(el, '::placeholder').color);
      if (ph && ph.a > 0 && el.placeholder) pushText(el, { ...ph, a: 1 }, surfaceOf(el), describe(el) + '(placeholder)');
      continue;
    }
    if (!hasText(el)) continue;
    const fg = parseColor(cs.color);
    if (!fg) { failures.push('unparsable color ' + cs.color + ' on ' + describe(el)); continue; }
    if (fg.a < 1) { failures.push('alpha text colour on ' + describe(el)); continue; }
    if (!opaqueOk(el)) { failures.push('opacity < 1 above text ' + describe(el)); continue; }
    pushText(el, fg, surfaceOf(el));
  }
  const pushNonText = (label, fg, surfColor, min = 3.0) => {
    const r = ratio(fg, surfColor);
    nonText.push({ sel: label, fg: hex(fg), bg: hex(surfColor), ratio: +r.toFixed(2) });
    if (r < min) failures.push('non-text ' + label + ' ' + hex(fg) + ' on ' + hex(surfColor) + ' = ' + r.toFixed(2));
  };
  for (const el of document.querySelectorAll('button, input, select, summary, .btn')) {
    if (!visible(el) || el.disabled) continue;
    const cs = getComputedStyle(el);
    const bc = parseColor(cs.borderTopColor);
    if (!bc || bc.a <= 0 || px(cs.borderTopWidth) <= 0) continue;
    const surf = surfaceOf(el.parentElement);
    if (surf.error) { failures.push(surf.error); continue; }
    const fg = bc.a < 1 ? over(bc, surf.color) : bc;
    pushNonText('border ' + describe(el), fg, surf.color);
  }
  for (const el of document.querySelectorAll('[aria-pressed="true"].chip, [aria-pressed="true"].scope')) {
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    pushNonText('pressed chip border ' + describe(el), parseColor(cs.borderTopColor), parseColor(cs.backgroundColor));
  }
  for (const el of document.querySelectorAll('.live-dot, .badge-region .dot, .health-dot')) {
    if (!visible(el)) continue;
    const surf = surfaceOf(el.parentElement);
    if (!surf.error) pushNonText('dot ' + describe(el.parentElement) + ' > ' + describe(el), parseColor(getComputedStyle(el).backgroundColor), surf.color);
  }
  const bg1 = token('--bg-1');
  for (const c of document.querySelectorAll('circle.blip')) {
    if (!visible(c)) continue;
    const fill = parseColor(getComputedStyle(c).fill);
    if (!fill) continue;
    pushNonText('blip ' + c.getAttribute('fill'), fill, bg1);
    if (c.classList.contains('is-fresh')) pushNonText('fresh blip trough ' + c.getAttribute('fill'), over({ ...fill, a: 0.75 }, bg1), bg1);
  }
  const openCard = document.querySelector('.card.is-open');
  if (openCard && visible(openCard)) {
    const m = /rgba?\([^)]*\)/.exec(getComputedStyle(openCard).boxShadow);
    if (m) pushNonText('.card.is-open inset edge', parseColor(m[0]), parseColor(getComputedStyle(openCard).backgroundColor));
  }
  const nav = document.querySelector('nav.site-nav a[aria-current]');
  if (nav && visible(nav)) pushNonText('nav underline', parseColor(getComputedStyle(nav).textDecorationColor), GLASS);
  for (const id of ['retry-items', 'retry-archive']) {
    const b = document.getElementById(id);
    if (!b || !visible(b)) continue;
    const bg = parseColor(getComputedStyle(b).backgroundColor);
    if (!same(bg, token('--accent-fill'))) failures.push('#' + id + ' background is ' + hex(bg) + ', not --accent-fill');
    pushNonText('#' + id + ' block', bg, token('--danger-tint'));
  }
  const worst = (arr) => arr.reduce((w, p) => (!w || p.ratio < w.ratio ? p : w), null);
  return {
    theme,
    textCount: textPairs.length,
    nonTextCount: nonText.length,
    worstText: worst(textPairs),
    worstNonText: worst(nonText),
    glassTextCount: textPairs.filter((p) => p.glass).length,
    glassExtreme: hex(GLASS),
    glassExpected: hex(expectGlass),
    glassOk: same(GLASS, expectGlass, 1.01),
    dotComposite: hex(DOT),
    dotExpected: hex(expectDot),
    dotOk: same(DOT, expectDot, 1.01),
    failures,
  };
}
"""

# Premise behind the glass extreme (AC 4): no composited paint in the document is more extreme than --fg-0.
PREMISE_JS = r"""
(theme) => {
""" + JS_PRELUDE + r"""
  const limit = lum(FG0);
  const offenders = [];
  const props = ['color', 'background-color', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color', 'outline-color', 'fill', 'stroke'];
  const isSvg = (el) => el.namespaceURI === 'http://www.w3.org/2000/svg';
  // text-like controls draw their value/placeholder in `color`; checkboxes, radios and ranges draw nothing with it
  const ownText = (el) => Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim() !== '') || (el.tagName === 'INPUT' && !['checkbox', 'radio', 'range'].includes(el.type)) || el.tagName === 'SELECT';
  // Only paint that is actually drawn counts: text colour needs own text, border colours need a border width,
  // outline-color an outline, fill/stroke an SVG shape (the UA defaults on <html> etc. are never painted;
  // <line> has no fill area). Elements that are not rendered (<head> children, hidden dialogs) paint nothing.
  const drawn = (el, cs, p) => {
    if (p === 'color') return ownText(el);
    if (p.startsWith('border-')) { const side = p.split('-')[1]; return px(cs.getPropertyValue('border-' + side + '-width')) > 0 && cs.getPropertyValue('border-' + side + '-style') !== 'none'; }
    if (p === 'outline-color') return px(cs.outlineWidth) > 0 && cs.outlineStyle !== 'none';
    if (p === 'fill') return isSvg(el) && !['svg', 'g', 'line'].includes(el.tagName);
    if (p === 'stroke') return isSvg(el) && px(cs.strokeWidth) > 0;
    return true;
  };
  let checked = 0;
  for (const el of document.querySelectorAll('*')) {
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    for (const p of props) {
      if (!drawn(el, cs, p)) continue;
      const c = parseColor(cs.getPropertyValue(p));
      if (!c || c.a <= 0) continue;
      const surf = surfaceOf(el.parentElement);
      const composed = c.a < 1 ? over(c, surf.error ? BG0 : surf.color) : c;
      const L = lum(composed);
      checked += 1;
      const bad = theme === 'light' ? L < limit - 1e-6 : L > limit + 1e-6;
      if (bad && offenders.length < 12) offenders.push(describe(el) + ' ' + p + ' ' + hex(composed) + ' L=' + L.toFixed(4));
    }
  }
  return { checked, limit: +limit.toFixed(4), offenders };
}
"""

# Layout / structure assertions per state (AC 1-3, 7, 9, 10, 14, 16, 17, 19; C8, C14, C15, C17).
LAYOUT_JS = r"""
(opts) => {
""" + JS_PRELUDE + r"""
  const out = { problems: [] };
  const problem = (s) => out.problems.push(s);
  out.bodyFont = px(getComputedStyle(document.body).fontSize);
  let minFont = Infinity, minDesc = '', visibleEls = 0;
  for (const el of document.body.querySelectorAll('*')) {
    if (!visible(el)) continue;
    visibleEls += 1;
    const size = px(getComputedStyle(el).fontSize);
    if (size < minFont) { minFont = size; minDesc = describe(el); }
  }
  out.visibleEls = visibleEls; out.minFont = minFont; out.minFontDesc = minDesc;
  const controlH = px(rootStyle.getPropertyValue('--control-h'));
  out.controlH = controlH;
  const controls = [];
  for (const el of document.querySelectorAll('button, input, select, summary')) {
    if (!visible(el)) continue;
    if (el instanceof HTMLInputElement && el.type === 'checkbox') {
      const label = el.closest('label');
      const h = rect(label || el).height;
      if (h < 44) problem('checkbox target ' + describe(el) + ' ' + h.toFixed(1) + 'px < 44');
      continue;
    }
    const h = rect(el).height;
    controls.push({ desc: describe(el), h });
    if (Math.abs(h - controlH) > 0.5) problem('control ' + describe(el) + ' ' + h.toFixed(1) + 'px != --control-h ' + controlH);
  }
  out.controls = controls.length;
  out.controlMin = controls.length ? Math.min(...controls.map((c) => c.h)) : 0;
  out.controlMax = controls.length ? Math.max(...controls.map((c) => c.h)) : 0;
  for (const a of document.querySelectorAll('a.btn, a.card-ext')) {
    if (!visible(a)) continue;
    const r = rect(a);
    if (r.height < controlH - 0.5 || r.width < controlH - 0.5) problem('link box ' + describe(a) + ' ' + r.width.toFixed(1) + 'x' + r.height.toFixed(1) + ' < ' + controlH);
  }
  const reset = document.getElementById('reset');
  if (reset && reset.disabled) problem('#reset is disabled');
  out.scrollWidth = document.documentElement.scrollWidth; out.innerWidth = innerWidth; out.clientWidth = document.documentElement.clientWidth;
  // The layout viewport's right edge: clientWidth minus the gutter that `scrollbar-gutter: stable` reserves for a
  // classic scrollbar. Headless Chromium hides scrollbars but still reserves it, so fixed boxes end here, not at clientWidth.
  out.layoutRight = document.documentElement.getBoundingClientRect().right;
  if (out.scrollWidth > out.innerWidth) problem('horizontal overflow ' + out.scrollWidth + ' > ' + out.innerWidth);
  const sl = document.getElementById('source-list');
  const sf = document.getElementById('sources-filter');
  if (sf && sf.open && sl && visible(sl)) {
    out.popoverRight = rect(sl).right;
    if (rect(sl).right > out.innerWidth + 0.5) problem('#source-list right ' + rect(sl).right + ' > innerWidth');
    const tracks = getComputedStyle(sl.querySelector('.source-grid')).gridTemplateColumns.split(' ').filter(Boolean).length;
    out.gridTracks = tracks;
    if (!sl.querySelector(':scope > legend')) problem('#source-list has no legend child');
    if (getComputedStyle(sl.querySelector('.source-grid')).display !== 'grid') problem('.source-grid is not a grid');
    for (const box of sl.querySelectorAll('input[type="checkbox"]')) {
      const cs = getComputedStyle(box);
      const r = rect(box);
      if (cs.appearance !== 'none') problem('checkbox appearance ' + cs.appearance);
      if (Math.abs(r.width - 24) > 0.5 || Math.abs(r.height - 24) > 0.5) problem('checkbox box ' + r.width + 'x' + r.height);
      if (box.checked) { if (!same(parseColor(cs.backgroundColor), token('--accent-fill'))) problem('checked box background ' + cs.backgroundColor); }
      else if (!same(parseColor(cs.borderTopColor), token('--control-border'))) problem('unchecked box border ' + cs.borderTopColor);
    }
  }
  const panel = document.getElementById('filter-panel');
  if (panel && panel.getAttribute('role') === 'dialog') {
    const r = rect(panel);
    out.sheet = { left: r.left, width: r.width };
    if (r.left !== 0 || Math.abs(r.width - out.layoutRight) > 0.5) problem('sheet geometry left ' + r.left + ' width ' + r.width + ' vs layout viewport ' + out.layoutRight + ' (clientWidth ' + out.clientWidth + ')');
    if (getComputedStyle(document.documentElement).overflow !== 'hidden') problem('html overflow not hidden while the sheet is open');
    const scrim = document.querySelector('.scrim');
    if (!scrim || getComputedStyle(scrim).touchAction !== 'none') problem('scrim touch-action');
    if (getComputedStyle(panel.querySelector('.sheet-body')).overscrollBehavior !== 'contain' && getComputedStyle(panel.querySelector('.sheet-body')).overscrollBehaviorY !== 'contain') problem('sheet-body overscroll-behavior');
    for (const id of ['scope-label', 'since-label']) { const l = document.getElementById(id); if (!l || rect(l).width <= 1) problem('#' + id + ' not visible in the sheet'); }
    const apply = document.getElementById('filters-apply');
    if (!/^(Show \d+ items|No items match)$/.test(apply.textContent.trim())) problem('#filters-apply reads ' + apply.textContent);
  } else if (panel && visible(panel)) {
    for (const id of ['scope-label', 'since-label']) { const l = document.getElementById(id); const r = l ? rect(l) : null; if (!r || r.width > 1) problem('#' + id + ' visible on the bar'); }
  }
  // AC 10 visual rules
  for (const el of document.body.querySelectorAll('*')) {
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    if (cs.backgroundImage.includes('gradient') && !el.matches('.radar-sweep, body')) problem('gradient on ' + describe(el));
    if ((cs.maskImage && cs.maskImage !== 'none') || (cs.webkitMaskImage && cs.webkitMaskImage !== 'none')) problem('mask on ' + describe(el));
    if (cs.filter !== 'none') problem('filter on ' + describe(el));
    const bf = cs.backdropFilter || cs.webkitBackdropFilter;
    if (bf && bf !== 'none' && !(el.matches('.topbar') || (el.id === 'filter-panel' && cs.position === 'sticky'))) problem('backdrop-filter on ' + describe(el));
    if (el.matches('.card') && cs.boxShadow !== 'none' && !cs.boxShadow.includes('inset')) problem('card shadow ' + cs.boxShadow);
  }
  if (getComputedStyle(document.body).backgroundImage.indexOf('radial-gradient') < 0) problem('body dot grid missing');
  // AC 14 columns
  const cards = Array.from(document.querySelectorAll('#results article.card'));
  out.cardCount = cards.length;
  out.columns = new Set(cards.map((c) => Math.round(c.offsetLeft))).size;
  // AC 16 sticky bars
  const header = document.querySelector('header.site-header');
  const topbar = document.querySelector('.topbar');
  out.headerSticky = getComputedStyle(header).position;
  out.topbarBackdrop = getComputedStyle(topbar).backdropFilter || getComputedStyle(topbar).webkitBackdropFilter;
  out.topbarH = rootStyle.getPropertyValue('--topbar-h').trim();
  out.headerOffsetHeight = header.offsetHeight;
  if (Math.abs(px(out.topbarH) - header.offsetHeight) > 0.5) problem('--topbar-h ' + out.topbarH + ' vs header ' + header.offsetHeight);
  if (panel && innerWidth >= 1024) {
    const cs = getComputedStyle(panel);
    if (cs.position !== 'sticky') problem('#filter-panel not sticky at >= 1024');
    if (Math.abs(px(cs.top) - header.offsetHeight) > 0.5) problem('#filter-panel top ' + cs.top + ' vs header ' + header.offsetHeight);
    if (panel.scrollWidth > panel.clientWidth) problem('#filter-panel overflows ' + panel.scrollWidth + ' > ' + panel.clientWidth);
  }
  const fo = document.querySelectorAll('#filters-open');
  if (fo.length) {
    if (fo.length !== 1 || !fo[0].closest('.topbar')) problem('#filters-open count ' + fo.length);
    if (visible(fo[0]) !== (innerWidth < 640)) problem('#filters-open visibility at ' + innerWidth);
  }
  const toolbar = document.querySelector('.toolbar');
  if (toolbar && innerWidth < 640 && toolbar.querySelector('button')) problem('toolbar has a button on a phone');
  // AC 17 card structure
  const kindRe = /^badge-(launch|funding|news|accelerator)$/;
  out.cardIssues = [];
  for (const c of cards) {
    const links = c.querySelectorAll('h2 a');
    if (links.length !== 1 || !links[0].getAttribute('href').startsWith('?item=')) out.cardIssues.push(describe(c) + ' h2 a');
    if (c.querySelectorAll('.badge-source').length !== 1) out.cardIssues.push('badge-source');
    const kinds = Array.from(c.querySelectorAll('.badge')).filter((b) => Array.from(b.classList).some((k) => kindRe.test(k)));
    if (kinds.length !== 1) out.cardIssues.push('kind badge x' + kinds.length);
    if (c.querySelectorAll('.badge-region').length !== 1) out.cardIssues.push('badge-region');
    if (c.querySelectorAll('time[datetime]').length !== 1) out.cardIssues.push('time');
    const ext = c.querySelectorAll('a.card-ext');
    if (ext.length !== 1 || ext[0].target !== '_blank' || !/\bnoopener\b/.test(ext[0].rel) || !/\bnoreferrer\b/.test(ext[0].rel)) out.cardIssues.push('card-ext');
    if (getComputedStyle(links[0], '::after').content !== 'none') out.cardIssues.push('card-link ::after overlay');
  }
  out.cardExt = cards.map((c) => ({ key: c.dataset.key, href: c.querySelector('a.card-ext') ? c.querySelector('a.card-ext').href : null }));
  out.badges = Array.from(document.querySelectorAll('#results .badge:not(.badge-region):not(.badge-sector), #detail .badge:not(.badge-region):not(.badge-sector)')).map((b) => b.textContent.trim());
  out.sectorBadges = Array.from(document.querySelectorAll('#results .badge-sector, #detail .badge-sector')).map((b) => ({ text: b.textContent.trim(), title: b.title }));
  // shell: one nav list with the six static links, the phone toggle only below 640, no second help/toasts
  const navList = document.querySelectorAll('nav.site-nav ul#site-nav-list');
  out.navLinks = navList.length === 1 ? Array.from(navList[0].querySelectorAll('a')).map((a) => [a.textContent.trim(), a.getAttribute('href'), a.getAttribute('aria-current')]) : null;
  const toggle = document.getElementById('nav-toggle');
  if (!toggle) problem('#nav-toggle missing');
  else if (visible(toggle) !== (innerWidth < 640)) problem('#nav-toggle visibility at ' + innerWidth);
  if (innerWidth >= 640 && navList.length === 1) {
    const ul = navList[0];
    const links = Array.from(ul.querySelectorAll('a'));
    if (!links.every(visible)) problem('nav links hidden at ' + innerWidth);
    const brand = document.querySelector('.topbar .brand');
    if (brand && rect(ul).top < rect(brand).bottom - 1) problem('nav is not a second row under the brand row');
    for (const sel of ['dialog#help', '#toasts', 'p.footer-links']) if (document.querySelectorAll(sel).length !== 1) problem(sel + ' x' + document.querySelectorAll(sel).length);
  }
  out.regionBadges = Array.from(document.querySelectorAll('#results .badge-region, #detail .badge-region')).map((b) => b.textContent.trim());
  // AC 19 stat tiles
  out.statN = Array.from(document.querySelectorAll('.stat-n')).map((n) => ({ text: n.textContent.trim(), lines: n.getClientRects().length, ws: getComputedStyle(n).whiteSpace, overflow: n.scrollWidth > n.clientWidth }));
  const tiles = Array.from(document.querySelectorAll('ul.stats > li'));
  out.tileColumns = new Set(tiles.map((t) => Math.round(t.offsetLeft))).size;
  out.tileMinWidth = tiles.length ? Math.min(...tiles.map((t) => rect(t).width)) : 0;
  const radar = document.getElementById('radar-panel');
  out.radarDisplay = radar ? getComputedStyle(radar).display : null;
  if (radar && getComputedStyle(radar).display !== 'none') {
    const heroMain = document.querySelector('.hero-main');
    out.radarInSecondColumn = rect(radar).left >= rect(heroMain).right - 1;
    out.radarTitle = document.getElementById('radar-title').textContent;
    out.radarTitleTransform = getComputedStyle(document.getElementById('radar-title')).textTransform;
    out.blips = document.querySelectorAll('circle.blip').length;
    const stats = document.querySelector('ul.stats');
    out.hero = { mainH: rect(heroMain).height, radarH: rect(radar).height, statsGap: rect(heroMain).bottom - rect(stats).bottom, statFont: px(getComputedStyle(document.querySelector('.stat-n')).fontSize), tileRows: new Set(tiles.map((t) => Math.round(rect(t).top))).size };
  }
  // AC 9 honesty
  const sort = document.getElementById('sort');
  out.sortOptions = sort ? Array.from(sort.options).map((o) => o.value) : null;
  const lm = document.getElementById('load-more');
  if (lm && !lm.hidden) { if (lm.disabled) problem('#load-more disabled'); if (!/^(Load more|Load older items)$/.test(lm.textContent.trim())) problem('#load-more reads ' + lm.textContent); }
  // C14 logo layering
  const mark = document.querySelector('.radar-mark');
  if (mark) {
    if (getComputedStyle(mark, '::before').zIndex !== '1') problem('.radar-mark::before z-index ' + getComputedStyle(mark, '::before').zIndex);
    const cross = mark.querySelector('.radar-cross');
    if (getComputedStyle(cross).zIndex !== '1') problem('.radar-cross z-index');
    if (getComputedStyle(cross).backgroundImage !== 'none') problem('.radar-cross has a background image');
  }
  // dialogs
  const detail = document.getElementById('detail');
  if (detail && detail.open) {
    const p = detail.querySelector('.detail-panel');
    const r = rect(p);
    out.drawer = { right: r.right, width: r.width, bottom: r.bottom, left: r.left, innerHeight, layoutRight: out.layoutRight, clientWidth: out.clientWidth };
    if (innerWidth >= 1024) { if (Math.abs(r.right - out.layoutRight) > 0.5 || r.width > 520.5) problem('drawer geometry ' + JSON.stringify(out.drawer)); }
    else if (Math.abs(r.bottom - innerHeight) > 0.5 || r.left !== 0 || Math.abs(r.width - out.layoutRight) > 0.5) problem('sheet geometry ' + JSON.stringify(out.drawer));
    if (getComputedStyle(detail).paddingTop !== '0px') problem('dialog padding ' + getComputedStyle(detail).paddingTop);
    if (getComputedStyle(document.documentElement).overflow !== 'hidden') problem('body scroll not locked behind the drawer');
  }
  if (document.querySelector('iframe, embed, object')) problem('iframe/embed/object present');
  return out;
}
"""


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

ABSENT = ""  # marker for "this query key must be absent" (None would be dropped by the Python binding)
WIDTHS = [320, 390, 768, 1024, 1280, 1920]


def wait_state(page, expected):
    """Block until the URL query equals `expected` and the result list finished loading."""
    if any(v is None for v in expected.values()):
        raise ValueError("use ABSENT, not None, in wait_state expectations")
    page.wait_for_function(WAIT_STATE_JS, arg=expected, timeout=WAIT_MS)


def wait_cards(page):
    page.wait_for_function("() => document.querySelector('#results') && document.querySelector('#results').getAttribute('aria-busy') === 'false' && document.querySelectorAll('#results article').length >= 1", timeout=WAIT_MS)


def settle(page):
    """Wait until nothing but the intentional loops is animating (called before every screenshot/audit)."""
    page.wait_for_function(SETTLED_JS, timeout=WAIT_MS)


def snapshot(page):
    return page.evaluate(SNAPSHOT_JS)


def parse_iso(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def to_iso(dt):
    """datetime -> the ISO form JavaScript's Date#toISOString() produces (ms precision, Z)."""
    dt = dt.astimezone(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (dt.microsecond // 1000)


def since_cutoff(value, now=None):
    """Same formula as public/filter.js sinceToIso: today = UTC midnight, 7d/30d = now - N days."""
    now = now or datetime.now(timezone.utc)
    if value == "today":
        return now.replace(hour=0, minute=0, second=0, microsecond=0)
    if value == "7d":
        return now - timedelta(days=7)
    if value == "30d":
        return now - timedelta(days=30)
    return None


def export_floor(now=None):
    """Lower bound of the static export window (EXPORT_LIMITS.maxDays)."""
    now = now or datetime.now(timezone.utc)
    return now - timedelta(days=EXPORT_MAX_DAYS)


class RequestLog:
    """Records which data / API URLs a page requested."""

    def __init__(self, page):
        self.data_items = []
        self.api_items = []
        self.all = []
        page.on("request", self._on_request)

    def _on_request(self, req):
        path = req.url.split("?", 1)[0]
        self.all.append(req.url)
        if path.endswith(ITEMS_PATH):
            self.data_items.append(req.url)
        if API_ITEMS_PATH in req.url:
            self.api_items.append(req.url)


class ErrorLog:
    """Collects console errors and page errors of a page."""

    def __init__(self, page, ignore_urls=()):
        self.errors = []
        page.on("pageerror", lambda err: self.errors.append("pageerror: " + str(err)))

        def on_console(msg):
            url = (msg.location or {}).get("url", "")
            if msg.type == "error" and not any(url.endswith(s) for s in ignore_urls):
                self.errors.append("console: %s (%s)" % (msg.text, url))

        page.on("console", on_console)

    def check(self, label):
        check("%s: no console errors or page errors" % label, len(self.errors) == 0, "; ".join(self.errors)[:300])


def new_ctx(browser, *, viewport=None, scheme="dark", mobile=False, sw=False, reduced_motion=None):
    """One browser context per scenario: explicit colour scheme, service workers blocked unless `sw`."""
    opts = {
        "viewport": viewport or DESKTOP,
        "color_scheme": scheme,
        "service_workers": "allow" if sw else "block",
    }
    if mobile:
        opts.update({"is_mobile": True, "has_touch": True, "device_scale_factor": MOBILE_SCALE})
    if reduced_motion:
        opts["reduced_motion"] = reduced_motion
    ctx = browser.new_context(**opts)
    ctx.set_default_timeout(WAIT_MS)
    ctx.set_default_navigation_timeout(WAIT_MS)
    return ctx


def goto_home(page, query=""):
    page.goto(BASE + "/" + query, wait_until="domcontentloaded")
    wait_cards(page)


def goto_sources(page):
    page.goto(BASE + "/sources.html", wait_until="domcontentloaded")
    page.wait_for_selector("#sources-table tbody tr:not(.skeleton)", timeout=WAIT_MS)
    page.wait_for_selector("#explore-list li", timeout=WAIT_MS)


def goto_lens(page, kind, query=""):
    """Open a lens page (trends/funding/yc) and wait until its data rendered."""
    path, ready = next((p, r) for k, p, r in LENS_PAGES if k == kind)
    page.goto(BASE + path + query, wait_until="domcontentloaded")
    page.wait_for_selector(ready, timeout=WAIT_MS)
    page.wait_for_function("() => /Last refreshed/.test(document.getElementById('last-refreshed').textContent) && !/loading/.test(document.getElementById('last-refreshed').textContent)", timeout=WAIT_MS)


def open_sheet(page):
    """Phone contexts: open the filter sheet (the sources disclosure lives inside it)."""
    page.click("#filters-open")
    page.wait_for_selector('#filter-panel[role="dialog"]', timeout=WAIT_MS)


def close_sheet(page):
    page.click("#filters-close")
    page.wait_for_function("() => document.getElementById('filter-panel').hidden === true", timeout=WAIT_MS)


def png_size(path):
    with open(path, "rb") as f:
        head = f.read(24)
    if len(head) < 24 or head[:8] != b"\x89PNG\r\n\x1a\n":
        return (0, 0)
    return struct.unpack(">II", head[16:24])


def shot(page, name):
    settle(page)
    # the 600 ms stat count-ups are requestAnimationFrame-driven (invisible to getAnimations): wait until the numbers stop changing
    stats_js = "[...document.querySelectorAll('.stat-n')].map((n) => n.textContent).join('|')"
    for _ in range(5):
        before = page.evaluate(stats_js)
        page.wait_for_timeout(700)
        if page.evaluate(stats_js) == before:
            break
    page.screenshot(path=str(OUT / name), full_page=False)
    vp = page.viewport_size
    print("wrote %s (viewport %dx%d)" % (name, vp["width"], vp["height"]))


def first_title(snap_or_api):
    if "cards" in snap_or_api:
        return snap_or_api["cards"][0]["title"] if snap_or_api["cards"] else None
    return snap_or_api["items"][0]["title"] if snap_or_api["items"] else None


def describe_change(snap, base, exp=None, api_base=None):
    """Did the rendered set change versus the unfiltered baseline?

    Returns (ok, changed, note). `ok` is False when the page did NOT change
    although the API answer for this filter differs from the API baseline,
    i.e. the control is wired up wrong. If the API says the filtered set is
    identical to the baseline, an unchanged page is correct.
    """
    changed = snap["total"] != base["total"] or first_title(snap) != first_title(base)
    if changed:
        return True, True, "changed vs baseline"
    api_same = exp is not None and api_base is not None and exp["total"] == api_base["total"] and first_title(exp) == first_title(api_base)
    if api_same:
        return True, False, "same as baseline (API confirms the set is identical)"
    return False, False, "UNCHANGED although the API result differs"


class Api:
    """Thin client for the Express JSON API (parity mode) and the static data files."""

    def __init__(self, request):
        self.request = request

    def items(self, params):
        """/api/items with the export window applied: `since` is never older than now - 90 days."""
        qs = dict(params)
        qs.setdefault("limit", PAGE_SIZE)
        floor = export_floor()
        since = qs.get("since")
        cutoff = max(parse_iso(since), floor) if since else floor
        qs["since"] = to_iso(cutoff)
        res = self.request.get(BASE + API_ITEMS_PATH + "?" + urlencode(qs))
        if not res.ok:
            raise RuntimeError("GET /api/items %s -> %d" % (qs, res.status))
        return res.json()

    def sources(self):
        return self.data("sources.json")

    def data(self, name):
        res = self.request.get(BASE + "/data/" + name)
        if not res.ok:
            raise RuntimeError("GET /data/%s -> %d" % (name, res.status))
        return res.json()


class Data:
    """The static data files as the page sees them (fetched once per scenario)."""

    def __init__(self, request):
        api = Api(request)
        self.api = api
        self.items = api.data("items.json")
        self.sources = api.data("sources.json")
        self.stats = api.data("stats.json")
        self.by_key = {item_key(it["url"]): it for it in self.items}
        self.allowed_badges = set(s["name"] for s in self.sources["sources"]) | set(l for _, l in KIND_LABELS)
        self.region_labels = set(l for _, l in REGION_LABELS)
        enabled = [s for s in self.sources["sources"] if s["enabled"]]
        self.sources_tile = "%d/%d" % (len([s for s in enabled if not s.get("lastError")]), len(enabled))
        self.feed_tile = str(len(self.items) + int(self.stats.get("archiveItems") or 0))
        self.sectors = self.stats.get("sectors") or []  # [{id, label, count}] (FEAT-001)
        self.sector_labels = set(s["label"] for s in self.sectors)

    def tiles(self):
        """The four home stat tiles as the page should print them (feed, last 24 h, last 7 d, sources OK/enabled)."""
        return [self.feed_tile, str(self.stats["last24h"]), str(self.stats["last7d"]), self.sources_tile]

    def refresh_stats(self):
        """Re-fetch stats.json: on Express the rolling 24 h / 7 d counts move while a long matrix run is in progress."""
        self.stats = self.api.data("stats.json")
        self.feed_tile = str(len(self.items) + int(self.stats.get("archiveItems") or 0))
        return self.tiles()

    def within_48h(self, now, slack_s=0):
        n = 0
        for it in self.items:
            try:
                age = (now - parse_iso(it["publishedAt"])).total_seconds()
            except (KeyError, ValueError, TypeError):
                continue
            if age <= 48 * 3600 + slack_s:
                n += 1
        return n


def ui_matches_api(snap, api_data):
    """Rendered total + first title match the API answer for the same query."""
    if snap["total"] != api_data["total"]:
        return False
    if snap["total"] == 0:
        return snap["shown"] == 0 and snap["emptyShown"]
    return first_title(snap) == first_title(api_data)


def audit_page(page, label, want_controls=True, open_details=False, sheet=False, want_links=True):
    """Font-size, control-height, link-rel and overflow audit for the current page (want_links=False: a page
    without outbound links by design, e.g. trends/funding - every target=_blank anchor present must still be safe)."""
    if sheet:
        open_sheet(page)
    if open_details and page.locator("#sources-filter").count():
        page.click("#sources-filter summary")
        page.wait_for_selector("#source-list input", state="visible", timeout=WAIT_MS)
    a = page.evaluate(UI_AUDIT_JS)
    if open_details and page.locator("#sources-filter").count():
        page.click("#sources-filter summary")
    if sheet:
        close_sheet(page)

    check("%s: body font-size >= %dpx" % (label, MIN_BODY_FONT_PX), a["bodyFontSize"] >= MIN_BODY_FONT_PX, "%.2fpx" % a["bodyFontSize"])
    check(
        "%s: no visible element below %dpx" % (label, MIN_FONT_PX),
        a["minFont"] is not None and a["minFont"] >= MIN_FONT_PX,
        "%d visible elements, min %.2fpx at %s" % (a["visibleEls"], a["minFont"] or 0, a["minFontDesc"]),
    )
    if want_controls:
        strict = [c for c in a["controls"] if not c["viaLabel"]]
        labels = [c for c in a["controls"] if c["viaLabel"]]
        heights = [c["height"] for c in strict]
        lo = min(heights) if heights else 0
        hi = max(heights) if heights else 0
        worst = min(strict, key=lambda c: c["height"])["desc"] if strict else "-"
        check(
            "%s: buttons/inputs/selects/summary are %d-%dpx tall" % (label, CONTROL_MIN_PX, CONTROL_MAX_PX),
            bool(strict) and lo >= CONTROL_MIN_PX and hi <= CONTROL_MAX_PX + 0.5,
            "%d controls, min %.1fpx (%s), max %.1fpx" % (len(strict), lo, worst, hi),
        )
        if labels:
            lh = [c["height"] for c in labels]
            check(
                "%s: checkbox click targets (labels) >= %dpx tall" % (label, CONTROL_MIN_PX),
                min(lh) >= CONTROL_MIN_PX,
                "%d checkboxes, min %.1fpx, max %.1fpx" % (len(labels), min(lh), max(lh)),
            )
    check(
        "%s: target=_blank links carry rel noopener noreferrer" % label,
        (a["blankLinks"] >= 1 or not want_links) and a["badLinks"] == 0,
        "%d links, %d bad" % (a["blankLinks"], a["badLinks"]),
    )
    check(
        "%s: no horizontal overflow" % label,
        a["scrollWidth"] <= a["innerWidth"],
        "scrollWidth %d <= viewport %d" % (a["scrollWidth"], a["innerWidth"]),
    )
    return a


def pick_search_term(api, base_titles, base_total):
    """A word from a rendered title that narrows the result set without emptying it."""
    for title in base_titles:
        for word in re.findall(WORD_RE, title):
            data = api.items({"q": word})
            if 1 <= data["total"] < base_total:
                return word, data
    return None, None


# ---------------------------------------------------------------------------
# Parity / smoke scenarios (the original harness, adapted to the redesign)
# ---------------------------------------------------------------------------

def run_home_desktop(browser):
    ctx = new_ctx(browser, viewport=DESKTOP)
    page = ctx.new_page()
    api = Api(ctx.request)
    errors = ErrorLog(page)
    reqs = RequestLog(page)

    goto_home(page)
    wait_state(page, {})
    base = snapshot(page)
    api_base = api.items({})
    base_titles = [c["title"] for c in base["cards"]]

    check("home: at least 1 article rendered", base["shown"] >= 1, "%d articles, total %s" % (base["shown"], base["total"]))
    check("home: requested ./data/items.json exactly once", len(reqs.data_items) == 1, "%d requests: %s" % (len(reqs.data_items), ", ".join(reqs.data_items)[:200]))
    check("home: never requested /api/items", len(reqs.api_items) == 0, "%d requests" % len(reqs.api_items))
    check("home: result list matches /api/items within the 90-day export window (total + first title)", ui_matches_api(base, api_base), "UI %s / API %s" % (base["total"], api_base["total"]))
    times = [parse_iso(c["time"]) for c in base["cards"] if c["time"]]
    check(
        "home: newest first",
        len(times) == base["shown"] and all(times[i] >= times[i + 1] for i in range(len(times) - 1)),
        "%d timestamps, first %s" % (len(times), times[0].isoformat() if times else "-"),
    )
    check("home: 'Last refreshed' text present", page.evaluate("/Last refreshed/.test(document.body.innerText)"))
    check("home: has source, kind and region badges on every card", all(c["source"] and c["kind"] and c["region"] for c in base["cards"]))

    shot(page, "home.png")
    audit_page(page, "home desktop", want_controls=True, open_details=True)

    changed_flags = []

    # --- kind <select> --------------------------------------------------
    for value, label in KIND_LABELS:
        page.select_option("#kind", value)
        wait_state(page, {"kind": value})
        snap = snapshot(page)
        exp = api.items({"kind": value})
        chg_ok, changed, note = describe_change(snap, base, exp, api_base)
        changed_flags.append(("kind=" + value, changed, chg_ok))
        ok = chg_ok and ui_matches_api(snap, exp) and all(c["kind"] == label for c in snap["cards"])
        check("filter kind=%s: UI matches API and every card is %s" % (value, label), ok, "UI %s / API %s, %s" % (snap["total"], exp["total"], note))
    page.select_option("#kind", "")
    wait_state(page, {"kind": ABSENT})

    # --- region <select> ------------------------------------------------
    for value, label in REGION_LABELS:
        page.select_option("#region", value)
        wait_state(page, {"region": value})
        snap = snapshot(page)
        exp = api.items({"region": value})
        chg_ok, changed, note = describe_change(snap, base, exp, api_base)
        changed_flags.append(("region=" + value, changed, chg_ok))
        ok = chg_ok and ui_matches_api(snap, exp) and all(c["region"] == label for c in snap["cards"])
        check("filter region=%s: UI matches API and every card is %s" % (value, label), ok, "UI %s / API %s, %s" % (snap["total"], exp["total"], note))
    page.select_option("#region", "")
    wait_state(page, {"region": ABSENT})

    # --- USA / World / All scope buttons -------------------------------
    page.click('button.scope[data-scope="usa"]')
    wait_state(page, {"region": "usa"})
    snap = snapshot(page)
    exp = api.items({"region": "usa"})
    chg_ok, changed, note = describe_change(snap, base, exp, api_base)
    changed_flags.append(("scope USA", changed, chg_ok))
    check("scope USA: UI matches API and every card is USA", chg_ok and ui_matches_api(snap, exp) and all(c["region"] == "USA" for c in snap["cards"]), "UI %s / API %s, %s" % (snap["total"], exp["total"], note))
    check("scope USA: button shows aria-pressed=true", page.get_attribute('button.scope[data-scope="usa"]', "aria-pressed") == "true")

    page.click('button.scope[data-scope="world"]')
    wait_state(page, {"region": "world"})
    snap = snapshot(page)
    exp = api.items({"region": "world"})
    chg_ok, changed, note = describe_change(snap, base, exp, api_base)
    changed_flags.append(("scope World", changed, chg_ok))
    check("scope World: UI matches API and no card is USA", chg_ok and ui_matches_api(snap, exp) and all(c["region"] != "USA" for c in snap["cards"]), "UI %s / API %s, %s" % (snap["total"], exp["total"], note))

    page.click('button.scope[data-scope=""]')
    wait_state(page, {"region": ABSENT})
    snap = snapshot(page)
    check("scope All: back to the unfiltered total", snap["total"] == base["total"], "UI %s / baseline %s" % (snap["total"], base["total"]))

    # --- time chips ------------------------------------------------------
    for value, label in (("today", "Today"), ("7d", "7 days"), ("30d", "30 days")):
        page.click('button.chip[data-since="%s"]' % value)
        wait_state(page, {"since": value})
        snap = snapshot(page)
        cutoff = since_cutoff(value)
        since_iso = to_iso(cutoff)
        exp = api.items({"since": since_iso})
        chg_ok, changed, note = describe_change(snap, base, exp, api_base)
        changed_flags.append(("since=" + value, changed, chg_ok))
        within = all(parse_iso(c["time"]) >= cutoff for c in snap["cards"] if c["time"])
        check(
            "chip %s: UI matches API for since=%s and every card is newer" % (label, since_iso),
            chg_ok and ui_matches_api(snap, exp) and within,
            "UI %s / API %s, %s" % (snap["total"], exp["total"], note),
        )
    page.click('button.chip[data-since=""]')
    wait_state(page, {"since": ABSENT})
    snap = snapshot(page)
    check("chip All time: back to the unfiltered total", snap["total"] == base["total"], "UI %s / baseline %s" % (snap["total"], base["total"]))

    # --- search (debounced) ---------------------------------------------
    term, exp = pick_search_term(api, base_titles, base["total"])
    if term is None:
        check("search: found a term that narrows the result set", False, "no candidate word in the first page of titles")
    else:
        page.fill("#q", term)
        wait_state(page, {"q": term})
        snap = snapshot(page)
        chg_ok, changed, note = describe_change(snap, base, exp, api_base)
        changed_flags.append(("q=" + term, changed, chg_ok))
        first_has_term = bool(snap["cards"]) and term.lower() in snap["cards"][0]["text"].lower()
        check(
            "search '%s': UI matches API, narrows the set, first card contains the term" % term,
            ui_matches_api(snap, exp) and 1 <= snap["total"] < base["total"] and first_has_term,
            "UI %s / API %s / baseline %s, %s" % (snap["total"], exp["total"], base["total"], note),
        )
        page.fill("#q", "")
        wait_state(page, {"q": ABSENT})

    # --- sources checklist ----------------------------------------------
    src = api.sources()["sources"]
    candidates = [
        s for s in src
        if s["enabled"] and s["itemCount"] > 0 and s["itemCount"] < base["total"] and api.items({"source": s["id"]})["total"] >= 1
    ]
    if not candidates:
        check("sources checklist: a source with items exists", False)
    else:
        s = candidates[0]
        page.click("#sources-filter summary")
        page.wait_for_selector("#src-" + s["id"], state="visible", timeout=WAIT_MS)
        page.check("#src-" + s["id"])
        wait_state(page, {"source": s["id"]})
        snap = snapshot(page)
        exp = api.items({"source": s["id"]})
        chg_ok, changed, note = describe_change(snap, base, exp, api_base)
        changed_flags.append(("source=" + s["id"], changed, chg_ok))
        check(
            "sources checklist source=%s: UI matches API and every card is from %s" % (s["id"], s["name"]),
            chg_ok and ui_matches_api(snap, exp) and all(c["source"] == s["name"] for c in snap["cards"]),
            "UI %s / API %s, %s" % (snap["total"], exp["total"], note),
        )
        page.uncheck("#src-" + s["id"])
        wait_state(page, {"source": ABSENT})
        page.click("#sources-filter summary")

    # --- load more --------------------------------------------------------
    snap = snapshot(page)
    if snap["total"] > PAGE_SIZE:
        check("load more: button visible when more pages exist", snap["loadMoreVisible"], "total %s" % snap["total"])
        page.click("#load-more")
        page.wait_for_function(WAIT_STATE_JS, arg={}, timeout=WAIT_MS)
        after = snapshot(page)
        expected_shown = min(2 * PAGE_SIZE, snap["total"])
        check("load more: appends the next page", after["shown"] == expected_shown and after["shown"] > snap["shown"], "%d -> %d cards" % (snap["shown"], after["shown"]))
    else:
        check("load more: hidden when everything fits on one page", not snap["loadMoreVisible"], "total %s" % snap["total"])

    # --- screenshot of the filtered state (kind=funding + USA) ------------
    page.select_option("#kind", "funding")
    wait_state(page, {"kind": "funding"})
    page.click('button.scope[data-scope="usa"]')
    wait_state(page, {"kind": "funding", "region": "usa", "q": ABSENT, "since": ABSENT, "source": ABSENT})
    snap = snapshot(page)
    exp = api.items({"kind": "funding", "region": "usa"})
    check(
        "filtered view kind=funding + USA: UI matches API",
        ui_matches_api(snap, exp) and all(c["kind"] == "Funding" and c["region"] == "USA" for c in snap["cards"]),
        "UI %s / API %s" % (snap["total"], exp["total"]),
    )
    check("filtered view: URL query reflects both filters", "kind=funding" in page.url and "region=usa" in page.url, page.url)
    page.evaluate("window.scrollTo(0, 0)")
    shot(page, "home-filtered.png")

    # --- reset -----------------------------------------------------------
    page.click("#reset")
    wait_state(page, {"kind": ABSENT, "region": ABSENT, "since": ABSENT, "q": ABSENT, "source": ABSENT})
    snap = snapshot(page)
    check("reset: clears the URL query and restores the unfiltered total", snap["search"] == "" and snap["total"] == base["total"], "UI %s / baseline %s" % (snap["total"], base["total"]))

    # --- empty state -------------------------------------------------------
    page.fill("#q", "zqxjkvwpyq")
    wait_state(page, {"q": "zqxjkvwpyq"})
    snap = snapshot(page)
    check("empty state: zero matches shows the empty message and no cards", snap["total"] == 0 and snap["shown"] == 0 and snap["emptyShown"], snap["countText"])
    page.fill("#q", "")
    wait_state(page, {"q": ABSENT})

    changed_count = sum(1 for _, c, _ok in changed_flags if c)
    unchanged = [n for n, c, _ok in changed_flags if not c]
    check(
        "filters change the rendered result set (total / first title differ from the unfiltered page)",
        changed_count >= 1 and all(ok for _, _c, ok in changed_flags),
        "%d of %d filters changed the set%s" % (changed_count, len(changed_flags), ("; unchanged: " + ", ".join(unchanged)) if unchanged else ""),
    )
    check("home: still exactly one ./data/items.json request after all filters, none to /api/items", len(reqs.data_items) == 1 and len(reqs.api_items) == 0, "%d data, %d api" % (len(reqs.data_items), len(reqs.api_items)))
    errors.check("home")

    ctx.close()
    return base


def run_sources_desktop(browser):
    ctx = new_ctx(browser, viewport=DESKTOP)
    page = ctx.new_page()
    api = Api(ctx.request)
    errors = ErrorLog(page)

    goto_sources(page)
    data = page.evaluate(SOURCES_PAGE_JS)
    api_data = api.sources()
    api_sources = api_data["sources"]
    by_name = {s["name"]: s for s in api_sources}

    check("sources: one table row per configured source", len(data["rows"]) == len(api_sources), "%d rows / %d sources" % (len(data["rows"]), len(api_sources)))
    check("sources: every row links out with target=_blank rel=noopener noreferrer", all(r["href"] and r["target"] == "_blank" and "noopener" in (r["rel"] or "") and "noreferrer" in (r["rel"] or "") for r in data["rows"]))

    enabled_ok = True
    counts_ok = True
    requires_ok = True
    for r in data["rows"]:
        s = by_name.get(r["cells"][0])
        if not s:
            enabled_ok = False
            continue
        if s["enabled"] and r["cells"][1] != "Yes":
            enabled_ok = False
        if not s["enabled"]:
            if not r["cells"][1].startswith(("No", "Not configured")):
                enabled_ok = False
            if s["requires"] and s["requires"] not in r["cells"][1]:
                requires_ok = False
        if r["cells"][6] != str(s["itemCount"]):
            counts_ok = False
    check("sources: Enabled column matches the API (Yes / No with the required setting)", enabled_ok and requires_ok)
    check("sources: Items column equals the API itemCount for every source", counts_ok)
    check("sources: 'Last refreshed' text present", data["lastRefreshed"])
    check("sources: explore list has every API link and is labelled links only", len(data["explore"]) == len(api_data["exploreMore"]) and "links only" in data["exploreHeading"].lower(), "%d links; heading '%s'" % (len(data["explore"]), data["exploreHeading"]))
    check("sources: explore links use target=_blank rel=noopener noreferrer", all(e["target"] == "_blank" and "noopener" in (e["rel"] or "") and "noreferrer" in (e["rel"] or "") for e in data["explore"]))

    audit_page(page, "sources desktop", want_controls=True)
    shot(page, "sources.png")
    errors.check("sources")

    per_source = ["%s=%d" % (s["id"], s["itemCount"]) for s in api_sources]
    print("per-source item counts: " + ", ".join(per_source))
    ctx.close()


def run_mobile(browser):
    ctx = new_ctx(browser, viewport=MOBILE, mobile=True)
    page = ctx.new_page()
    errors = ErrorLog(page)

    goto_home(page)
    wait_state(page, {})
    snap = snapshot(page)
    check("mobile home: at least 1 article rendered", snap["shown"] >= 1, "%d articles" % snap["shown"])
    shot(page, "home-mobile.png")
    a = audit_page(page, "home mobile 390px", want_controls=True, open_details=True, sheet=True)
    check("mobile home: document.documentElement.scrollWidth <= 390", a["scrollWidth"] <= MOBILE["width"], "scrollWidth %d" % a["scrollWidth"])
    open_sheet(page)
    shot(page, "home-mobile-sheet.png")
    close_sheet(page)

    goto_sources(page)
    b = audit_page(page, "sources mobile 390px", want_controls=True)
    check("mobile sources: document.documentElement.scrollWidth <= 390", b["scrollWidth"] <= MOBILE["width"], "scrollWidth %d" % b["scrollWidth"])
    errors.check("mobile")
    ctx.close()


def run_live_smoke(browser):
    """SMOKE_ONLY mode: browser checks that need only the static files, usable on GitHub Pages."""
    ctx = new_ctx(browser, viewport=DESKTOP)
    page = ctx.new_page()
    errors = ErrorLog(page)
    reqs = RequestLog(page)

    # --- home ------------------------------------------------------------
    goto_home(page)
    wait_state(page, {})
    base = snapshot(page)
    check("smoke home: at least 1 article rendered", base["shown"] >= 1, "%d articles, total %s" % (base["shown"], base["total"]))
    check("smoke home: loaded ./data/items.json once and never /api/items", len(reqs.data_items) == 1 and len(reqs.api_items) == 0, "%d data, %d api" % (len(reqs.data_items), len(reqs.api_items)))
    times = [parse_iso(c["time"]) for c in base["cards"] if c["time"]]
    check(
        "smoke home: newest first",
        len(times) == base["shown"] and all(times[i] >= times[i + 1] for i in range(len(times) - 1)),
        "%d timestamps, first %s" % (len(times), times[0].isoformat() if times else "-"),
    )
    refreshed = page.evaluate(LAST_REFRESHED_JS)
    check("smoke home: 'Last refreshed' shows a real time", refreshed.startswith("Last refreshed") and "unknown" not in refreshed and "never" not in refreshed and "loading" not in refreshed, refreshed)
    audit_page(page, "smoke home desktop", want_controls=True, open_details=True)

    page.select_option("#kind", "funding")
    wait_state(page, {"kind": "funding"})
    snap = snapshot(page)
    check("smoke kind=funding: every card is Funding and the URL carries kind=funding", all(c["kind"] == "Funding" for c in snap["cards"]) and "kind=funding" in page.url, "%d cards, url %s" % (snap["shown"], page.url))
    check("smoke: URL writes stay under the sub-path (pathname unchanged, no leading-slash rewrite)", page.url.startswith(BASE + "/?") and urlsplit(page.url).path == urlsplit(BASE + "/").path, page.url)
    page.select_option("#kind", "")
    wait_state(page, {"kind": ABSENT})

    page.click('button.scope[data-scope="usa"]')
    wait_state(page, {"region": "usa"})
    snap = snapshot(page)
    check("smoke scope USA: every card is USA", snap["shown"] >= 1 and all(c["region"] == "USA" for c in snap["cards"]), "%d cards" % snap["shown"])
    page.click('button.scope[data-scope="world"]')
    wait_state(page, {"region": "world"})
    snap = snapshot(page)
    check("smoke scope World: no card is USA", snap["shown"] >= 1 and all(c["region"] != "USA" for c in snap["cards"]), "%d cards" % snap["shown"])
    page.click('button.scope[data-scope=""]')
    wait_state(page, {"region": ABSENT})

    page.click('button.chip[data-since="7d"]')
    wait_state(page, {"since": "7d"})
    snap = snapshot(page)
    cutoff = since_cutoff("7d")
    check("smoke chip 7 days: every card is newer than the cutoff", all(parse_iso(c["time"]) >= cutoff for c in snap["cards"] if c["time"]), "%d cards, cutoff %s" % (snap["shown"], to_iso(cutoff)))
    page.click('button.chip[data-since=""]')
    wait_state(page, {"since": ABSENT})

    words = re.findall(WORD_RE, base["cards"][0]["title"]) if base["cards"] else []
    term = words[0] if words else None
    if term is None:
        check("smoke search: found a >= 4-letter word in the first title", False, base["cards"][0]["title"] if base["cards"] else "no cards")
    else:
        page.fill("#q", term)
        wait_state(page, {"q": term})
        snap = snapshot(page)
        check("smoke search '%s': first card contains the term and URL carries q" % term, bool(snap["cards"]) and term.lower() in snap["cards"][0]["text"].lower() and "q=" in page.url, "%d matches" % (snap["total"] if snap["total"] is not None else -1))

    page.select_option("#sort", "points")
    wait_state(page, {"sort": "points"})
    check("smoke sort=points: URL carries sort=points and the note is visible", "sort=points" in page.url and page.evaluate("!document.querySelector('.sort-note').hidden"))

    page.click("#reset")
    wait_state(page, {"kind": ABSENT, "region": ABSENT, "since": ABSENT, "q": ABSENT, "source": ABSENT, "sort": ABSENT})
    snap = snapshot(page)
    # typing a search loads ./data/archive.json on demand (by design), so after a reset the unfiltered total is
    # either the first-load total (no archive split) or first-load + archiveItems (the split stays merged).
    archive_items = int(Api(ctx.request).data("stats.json").get("archiveItems") or 0)
    with_archive = base["total"] + archive_items if archive_items else None
    check("smoke reset: empty query and unfiltered total (+ the merged archive when a split exists)", snap["search"] == "" and snap["total"] in (base["total"], with_archive), "UI %s / baseline %s / with archive %s" % (snap["total"], base["total"], with_archive))

    # --- deep link under the sub-path -----------------------------------------
    key = base["cards"][0]["key"]
    page.goto(BASE + "/?item=" + key, wait_until="domcontentloaded")
    page.wait_for_selector("dialog#detail[open]", timeout=WAIT_MS)
    title = page.evaluate("document.getElementById('detail-title').textContent")
    check("smoke deep link ?item=<key>: opens the drawer for the first card", title == base["cards"][0]["title"], title[:80])
    page.keyboard.press("Escape")
    page.wait_for_function("() => !document.querySelector('dialog#detail').open", timeout=WAIT_MS)
    page.wait_for_function("() => !location.search.includes('item=')", timeout=WAIT_MS)
    check("smoke deep link: Esc closes and removes the param under the sub-path", page.url == BASE + "/" or page.url == BASE + "/index.html", page.url)
    errors.check("smoke home")

    # --- sources.html ------------------------------------------------------
    goto_sources(page)
    data = page.evaluate(SOURCES_PAGE_JS)
    res = ctx.request.get(BASE + "/data/sources.json")
    n_sources = len(res.json()["sources"]) if res.ok else -1
    check("smoke sources: one table row per source in ./data/sources.json", n_sources >= 1 and len(data["rows"]) == n_sources, "%d rows / %d sources" % (len(data["rows"]), n_sources))
    check("smoke sources: at least 10 explore links", len(data["explore"]) >= 10, "%d links" % len(data["explore"]))
    refreshed = page.evaluate(LAST_REFRESHED_JS)
    check("smoke sources: 'Last refreshed' shows a real time", refreshed.startswith("Last refreshed") and "unknown" not in refreshed and "never" not in refreshed and "loading" not in refreshed, refreshed)
    audit_page(page, "smoke sources desktop", want_controls=True)
    errors.check("smoke sources")
    ctx.close()

    # --- lens pages (FEAT-003): numbers equal the JSON, drawer opens, no overflow at 1280 ---------------
    ctx = new_ctx(browser, viewport=DESKTOP)
    page = ctx.new_page()
    errors = ErrorLog(page)
    smoke_lens_pages(page, ctx, "smoke", audit=True)
    errors.check("smoke lens pages desktop")
    ctx.close()

    # --- notebook (FEAT-004): localStorage only, save on home -> listed, export/import, confirm deletes ---------------
    ctx = new_ctx(browser, viewport=DESKTOP)
    page = ctx.new_page()
    errors = ErrorLog(page)
    smoke_notebook(page, ctx, "smoke", audit=True)
    errors.check("smoke notebook desktop")
    ctx.close()

    # --- mobile ------------------------------------------------------------
    mctx = new_ctx(browser, viewport=MOBILE, mobile=True)
    mpage = mctx.new_page()
    merrors = ErrorLog(mpage)
    goto_home(mpage)
    wait_state(mpage, {})
    snap = snapshot(mpage)
    check("smoke mobile home: at least 1 article rendered", snap["shown"] >= 1, "%d articles" % snap["shown"])
    a = audit_page(mpage, "smoke home mobile 390px", want_controls=True, open_details=True, sheet=True)
    check("smoke mobile home: document.documentElement.scrollWidth <= 390", a["scrollWidth"] <= MOBILE["width"], "scrollWidth %d" % a["scrollWidth"])
    for kind, _, _ in LENS_PAGES:
        if kind == "notebook":
            seed_notebook(mpage, Api(mctx.request).data("items.json")[0])
            goto_lens(mpage, kind)
            mpage.click("#nb-canvas-list .nb-canvas-row")
            mpage.wait_for_selector("#nb-canvas-form:not([hidden])", timeout=WAIT_MS)
        else:
            goto_lens(mpage, kind)
        a = audit_page(mpage, "smoke %s mobile 390px" % kind, want_controls=True, want_links=(kind == "yc"))
        check("smoke mobile %s: scrollWidth <= 390" % kind, a["scrollWidth"] <= MOBILE["width"], "scrollWidth %d" % a["scrollWidth"])
    merrors.check("smoke mobile")
    mctx.close()


LENS_STATE_JS = r"""
() => {
  const text = (el) => (el ? el.textContent.trim() : '');
  const sparks = Array.from(document.querySelectorAll('#sector-grid .sparkline'));
  const groups = Array.from(document.querySelectorAll('#industry-groups details'));
  return {
    method: text(document.getElementById('method')),
    attribution: text(document.getElementById('attribution')),
    termRows: document.querySelectorAll('#terms-table tbody tr.term-row').length,
    sparklines: sparks.length,
    sparkPoints: sparks.map((s) => (s.querySelector('polyline').getAttribute('points') || '').split(' ').filter(Boolean).length),
    sparkLabels: sparks.map((s) => s.getAttribute('aria-label') || ''),
    sparkRole: sparks.every((s) => s.getAttribute('role') === 'img'),
    sparkAxes: Array.from(document.querySelectorAll('#sector-grid .spark')).map((f) => [Array.from(f.querySelectorAll('.spark-y span')).map(text).join(' '), Array.from(f.querySelectorAll('.spark-x span')).map(text).join(' ')]),
    weekHeaders: Array.from(document.querySelectorAll('#kind-table thead th')).map(text),
    kindRows: document.querySelectorAll('#kind-table tbody tr').length,
    regionRows: document.querySelectorAll('#region-table tbody tr').length,
    examples: document.querySelectorAll('#terms-table button.example').length,
    fundingRows: Array.from(document.querySelectorAll('#funding-table tbody tr[data-key]')).map((tr) => ({
      key: tr.dataset.key,
      title: text(tr.querySelector('th a')),
      amount: text(tr.querySelector('td[data-label="Amount"]')).replace(/\s*(parsed from (headline|summary))$/, ''),
      note: (tr.querySelector('td[data-label="Amount"] .cell-note') || {}).textContent || '',
      stage: text(tr.querySelector('td[data-label="Stage"]')).replace(/\s*(parsed from (headline|summary))$/, ''),
      stageNote: (tr.querySelector('td[data-label="Stage"] .cell-note') || {}).textContent || '',
      usd: text(tr.querySelector('td[data-label="approx. USD"]')),
    })),
    fundingCount: text(document.getElementById('count')),
    coverage: text(document.getElementById('coverage')),
    usdHeaderTitle: (document.querySelector('#funding-table thead th.num') || {}).title || '',
    fxNote: text(document.getElementById('fx-note')),
    fxRows: Array.from(document.querySelectorAll('#fx-table tbody tr')).map((tr) => [text(tr.querySelector('th')), text(tr.querySelector('td'))]),
    sectorTotalRows: document.querySelectorAll('#sector-totals tbody tr').length,
    stageTotalRows: document.querySelectorAll('#stage-totals tbody tr').length,
    stageOptions: Array.from(document.querySelectorAll('#stage option')).map((o) => o.value),
    industryGroups: groups.map((d) => ({ industry: text(d.querySelector('summary > span')), n: text(d.querySelector('summary .n')), open: d.open, rows: d.querySelectorAll('li.company-row').length })),
    companyLinks: Array.from(document.querySelectorAll('#industry-groups h3 a')).map((a) => ({ text: text(a), href: a.getAttribute('href'), target: a.getAttribute('target'), openKey: a.dataset.openKey || null })),
    tagRows: Array.from(document.querySelectorAll('#tag-list li')).map((li) => [text(li.querySelector('.tag')), text(li.querySelector('.n'))]),
    teamBars: Array.from(document.querySelectorAll('#team-bars .bar-row')).map((r) => [text(r.querySelector('.bar-label')), text(r.querySelector('.bar-n')), (r.querySelector('.bar') || {}).style ? r.querySelector('.bar').style.width : '']),
    batchChips: Array.from(document.querySelectorAll('#batch-chips button.chip')).map((b) => [b.dataset.batch, b.getAttribute('aria-pressed'), text(b)]),
    bodyText: document.body.innerText,
    search: location.search,
  };
}
"""


def smoke_lens_pages(page, ctx, prefix, audit=True):
    """Trends, funding and YC pages against their JSON files (smoke + parity)."""
    api = Api(ctx.request)
    trends = api.data("trends.json")
    funding = api.data("funding.json")
    yc = api.data("yc.json")
    items = api.data("items.json")
    feed_keys = set(item_key(it["url"]) for it in items)

    # --- trends ------------------------------------------------------------
    goto_lens(page, "trends")
    s = page.evaluate(LENS_STATE_JS)
    check("%s trends: one sparkline per sector (%d), role=img, 12 points each" % (prefix, len(trends["bySector"])), s["sparklines"] == len(trends["bySector"]) >= 1 and s["sparkRole"] and all(n == len(trends["weeks"]) for n in s["sparkPoints"]), "%d sparklines, points %s" % (s["sparklines"], sorted(set(s["sparkPoints"]))))
    expected_labels = ["%s: items per ISO week, %s to %s (partial): %s. Maximum %d." % (r["label"], trends["weeks"][0], trends["weeks"][-1], ", ".join(str(c) for c in r["counts"]), max([0] + r["counts"])) for r in trends["bySector"]]
    check("%s trends: sparkline aria-labels list the 12 real counts" % prefix, s["sparkLabels"] == expected_labels, (s["sparkLabels"][0] if s["sparkLabels"] else "-")[:120])
    check("%s trends: axes label 0/max and first/last week (last marked partial)" % prefix, len(s["sparkAxes"]) == len(trends["bySector"]) and all(y == "%d 0" % max([0] + r["counts"]) and x == "%s %s · partial" % (trends["weeks"][0], trends["weeks"][-1]) for (y, x), r in zip(s["sparkAxes"], trends["bySector"])), str(s["sparkAxes"][:2]))
    check("%s trends: rising-terms rows equal trends.json terms (%d) with <= 5 example buttons each" % (prefix, len(trends["terms"])), s["termRows"] == len(trends["terms"]) and s["examples"] == sum(min(5, len(t["examples"])) for t in trends["terms"]), "%d rows, %d example buttons" % (s["termRows"], s["examples"]))
    check("%s trends: method sentence equals trends.method" % prefix, s["method"] == trends["method"], s["method"][:100])
    check("%s trends: weekly tables show the 12 week ids and every kind/region row" % prefix, s["weekHeaders"][1:] == [w + (" (partial)" if w == trends["partialWeek"] else "") for w in trends["weeks"]] and s["kindRows"] == len(trends["byKind"]) and s["regionRows"] == len(trends["byRegion"]), "%d kinds, %d regions" % (s["kindRows"], s["regionRows"]))
    if trends["terms"]:
        first = page.evaluate("(() => { const tr = document.querySelector('#terms-table tbody tr.term-row'); return [tr.querySelector('th').textContent.trim(), ...Array.from(tr.querySelectorAll('td')).slice(0, 5).map((td) => td.textContent.trim())]; })()")
        t = trends["terms"][0]
        ratio = "new" if t["ratio"] is None else "%s×" % format(t["ratio"], ",")
        check("%s trends: first row shows this week, prior weekly average, rise and ratio of the JSON" % prefix, first[0] == t["term"] and first[2] == format(t["thisWeek"], ",") and first[3] == format(t["priorWeeklyAvg"], ",") and first[4] == format(t["rise"], ",") and first[5] == ratio, str(first))
        if s["examples"]:
            page.click("#terms-table button.example")
            page.wait_for_selector("dialog#detail[open]", timeout=WAIT_MS)
            key = page.evaluate("document.querySelector('#terms-table button.example').dataset.openKey")
            title = page.evaluate("document.getElementById('detail-title').textContent")
            check("%s trends: an example button opens the drawer for its item and the URL carries ?item=<key>" % prefix, bool(title) and ("item=" + key) in page.url and urlsplit(page.url).path == urlsplit(BASE + "/trends.html").path, "%s -> %s" % (key, title[:60]))
            page.keyboard.press("Escape")
            page.wait_for_function("() => !document.querySelector('dialog#detail').open", timeout=WAIT_MS)
            page.wait_for_function("() => !location.search.includes('item=')", timeout=WAIT_MS)
            check("%s trends: Esc closes the drawer and focus returns to the example button" % prefix, page.evaluate("document.activeElement && document.activeElement.classList.contains('example')"))
    if audit:
        audit_page(page, "%s trends desktop" % prefix, want_controls=True, want_links=False)

    # --- funding ------------------------------------------------------------
    goto_lens(page, "funding")
    s = page.evaluate(LENS_STATE_JS)
    f_items = funding["items"]
    check("%s funding: one row per funding.json item for the default filters (%d)" % (prefix, len(f_items)), len(s["fundingRows"]) == len(f_items) and set(r["key"] for r in s["fundingRows"]) == set(item_key(it["url"]) for it in f_items), "%d rows" % len(s["fundingRows"]))
    by_key = dict((item_key(it["url"]), it) for it in f_items)
    bad_amounts = [r for r in s["fundingRows"] if r["amount"] != ((by_key[r["key"]]["funding"].get("amountText") or "—"))]
    check("%s funding: every amount is the headline's original text (amountText) or an em dash" % prefix, not bad_amounts, ("bad %s" % json.dumps(bad_amounts[:2])) if bad_amounts else "%d rows" % len(s["fundingRows"]))
    FROM_LABEL = {"title": "parsed from headline", "summary": "parsed from summary", None: ""}
    bad_notes = [r for r in s["fundingRows"] if r["note"] != FROM_LABEL.get(by_key[r["key"]]["funding"].get("amountFrom") if by_key[r["key"]]["funding"].get("amountText") else None)]
    check("%s funding: every parsed amount is labelled with its own field (amountFrom -> parsed from headline / summary), none otherwise" % prefix, not bad_notes, ("bad %s" % json.dumps(bad_notes[:2])) if bad_notes else "%d labelled" % len([r for r in s["fundingRows"] if r["note"]]))
    # review-phase-1 iteration 2 #5: the stage carries its own field label (a title amount + summary stage differ)
    bad_stages = [r for r in s["fundingRows"] if r["stage"] != (by_key[r["key"]]["funding"].get("stage") or "—") or r["stageNote"] != FROM_LABEL.get(by_key[r["key"]]["funding"].get("stageFrom") if by_key[r["key"]]["funding"].get("stage") else None)]
    check("%s funding: every stage is the parsed stage (or an em dash) labelled with its own field (stageFrom)" % prefix, not bad_stages, ("bad %s" % json.dumps(bad_stages[:2])) if bad_stages else "%d labelled, %d differ from the amount's field" % (len([r for r in s["fundingRows"] if r["stageNote"]]), len([r for r in s["fundingRows"] if r["stageNote"] and r["note"] and r["stageNote"] != r["note"]])))
    cov = funding["coverage"]
    expected_cov = "sum of parsed amounts: %s of %s funding items had a parseable amount (%s had a stage)" % (format(cov["withAmount"], ","), format(cov["items"], ","), format(cov["withStage"], ","))
    check("%s funding: coverage sentence present" % prefix, s["coverage"].startswith(expected_cov), s["coverage"][:120])
    check("%s funding: approx. USD column titled with the static-rates wording and the FX table shows asOf %s" % (prefix, funding["fx"]["asOf"]), "approx. USD at static rates" in s["usdHeaderTitle"] and funding["fx"]["asOf"] in s["fxNote"] and s["fxRows"] == [[k, str(v)] for k, v in funding["fx"]["rates"].items()], "%s | %s" % (s["usdHeaderTitle"], s["fxNote"][:80]))
    check("%s funding: totals by sector (%d) and by stage (%d) rendered" % (prefix, len(funding["totals"]["bySector"]), len(funding["totals"]["byStage"])), s["sectorTotalRows"] == len(funding["totals"]["bySector"]) and s["stageTotalRows"] == len(funding["totals"]["byStage"]))
    check("%s funding: nothing on the page is called a score" % prefix, not re.search(r"\bscore\b", s["bodyText"], re.I))
    stages = [o for o in s["stageOptions"] if o]
    if stages:
        stage = stages[0]
        page.select_option("#stage", stage)
        page.wait_for_function("(st) => new URLSearchParams(location.search).get('stage') === st", arg=stage, timeout=WAIT_MS)
        s2 = page.evaluate(LENS_STATE_JS)
        expected = [it for it in f_items if (it["funding"].get("stage") or "unknown") == stage]
        check("%s funding: stage=%s filters the rows (%d) and the URL stays under the page path" % (prefix, stage, len(expected)), len(s2["fundingRows"]) == len(expected) and urlsplit(page.url).path == urlsplit(BASE + "/funding.html").path and s2["fundingCount"].startswith("%s of %s" % (format(len(expected), ","), format(len(f_items), ","))), "%d rows, %s" % (len(s2["fundingRows"]), s2["fundingCount"]))
        page.select_option("#stage", "")
        page.wait_for_function("() => !new URLSearchParams(location.search).has('stage')", timeout=WAIT_MS)
    page.select_option("#sort", "usd")
    page.wait_for_function("() => new URLSearchParams(location.search).get('sort') === 'usd'", timeout=WAIT_MS)
    s3 = page.evaluate(LENS_STATE_JS)
    usd_order = [by_key[r["key"]].get("usdApprox") for r in s3["fundingRows"]]
    numeric = [u for u in usd_order if u is not None]
    check("%s funding: sort=usd orders by approx. USD descending with unparsed amounts last" % prefix, numeric == sorted(numeric, reverse=True) and usd_order[len(numeric):].count(None) == len(usd_order) - len(numeric), "%d numeric of %d" % (len(numeric), len(usd_order)))
    page.select_option("#sort", "date")
    page.wait_for_function("() => !new URLSearchParams(location.search).has('sort')", timeout=WAIT_MS)
    if s["fundingRows"]:
        page.click("#funding-table tbody tr[data-key] th a")
        page.wait_for_selector("dialog#detail[open]", timeout=WAIT_MS)
        row = s["fundingRows"][0]
        title = page.evaluate("document.getElementById('detail-title').textContent")
        has_section = page.evaluate("!!document.querySelector('#detail .detail-funding')")
        check("%s funding: the title opens the drawer with the funding rows" % prefix, title == row["title"] and has_section and ("item=" + row["key"]) in page.url, title[:60])
        page.keyboard.press("Escape")
        page.wait_for_function("() => !document.querySelector('dialog#detail').open", timeout=WAIT_MS)
    if audit:
        audit_page(page, "%s funding desktop" % prefix, want_controls=True, want_links=False)

    # --- yc ------------------------------------------------------------
    goto_lens(page, "yc")
    s = page.evaluate(LENS_STATE_JS)
    check("%s yc: industry group count equals byIndustry.length (%d) with the largest open" % (prefix, len(yc["byIndustry"])), len(s["industryGroups"]) == len(yc["byIndustry"]) and s["industryGroups"][0]["open"] and all(not g["open"] for g in s["industryGroups"][1:]), "%d groups" % len(s["industryGroups"]))
    expected_groups = [(r["industry"], r["count"]) for r in yc["byIndustry"]]
    check("%s yc: group labels and counts equal byIndustry, rows per group equal the counts" % prefix, [(g["industry"], int(g["n"].split()[0].replace(",", ""))) for g in s["industryGroups"]] == expected_groups and all(g["rows"] == c for g, (_, c) in zip(s["industryGroups"], expected_groups)), str(s["industryGroups"][:2])[:160])
    check("%s yc: >= 400 companies rendered" % prefix, sum(g["rows"] for g in s["industryGroups"]) == len(yc["companies"]) >= 400, "%d companies" % sum(g["rows"] for g in s["industryGroups"]))
    check("%s yc: attribution line verbatim" % prefix, s["attribution"] == "Source: yc-oss open API mirror of ycombinator.com, refreshed hourly" == yc["attribution"], s["attribution"])
    expected_tags = [[r["tag"], format(r["count"], ",")] for r in yc["tagFrequency"]]
    check("%s yc: tag list equals tagFrequency (top %d)" % (prefix, len(expected_tags)), s["tagRows"] == expected_tags, str(s["tagRows"][:3]))
    expected_team = list(zip(yc["teamSize"]["buckets"], yc["teamSize"]["counts"]))
    check("%s yc: team-size bars equal teamSize buckets/counts incl. unknown, widths proportional" % prefix, [(b[0].replace(" people", ""), int(b[1].replace(",", ""))) for b in s["teamBars"]] == expected_team and all(b[2].endswith("%") for b in s["teamBars"]) and sum(c for _, c in expected_team) == len(yc["companies"]), str(s["teamBars"])[:160])
    in_feed = [l for l in s["companyLinks"] if l["openKey"]]
    external = [l for l in s["companyLinks"] if not l["openKey"]]
    check("%s yc: company names link in-app when the feed has the key, else to the YC page in a new tab" % prefix, all(l["openKey"] in feed_keys and l["href"] == "?item=" + l["openKey"] and l["target"] is None for l in in_feed) and all(l["target"] == "_blank" and l["href"].startswith("https://www.ycombinator.com/") for l in external) and len(in_feed) + len(external) == len(yc["companies"]), "%d in-app, %d external" % (len(in_feed), len(external)))
    check("%s yc: batch chips = All + %d batches with All pressed" % (prefix, len(yc["batches"])), [c[0] for c in s["batchChips"]] == [""] + [b["batch"] for b in yc["batches"]] and s["batchChips"][0][1] == "true", str(s["batchChips"]))
    batch = yc["batches"][0]["batch"]
    page.click('#batch-chips button.chip[data-batch="%s"]' % batch)
    page.wait_for_function("(b) => new URLSearchParams(location.search).get('batch') === b", arg=batch, timeout=WAIT_MS)
    s2 = page.evaluate(LENS_STATE_JS)
    subset = [c for c in yc["companies"] if c["batch"] == batch]
    industries = set((c["industry"] or "unknown") for c in subset)
    check("%s yc: ?batch=%s shows only that batch (%d companies in %d industries)" % (prefix, batch, len(subset), len(industries)), sum(g["rows"] for g in s2["industryGroups"]) == len(subset) and len(s2["industryGroups"]) == len(industries) and sum(int(b[1].replace(",", "")) for b in s2["teamBars"]) == len(subset), "%d rows, %d groups" % (sum(g["rows"] for g in s2["industryGroups"]), len(s2["industryGroups"])))
    page.click('#batch-chips button.chip[data-batch=""]')
    page.wait_for_function("() => !new URLSearchParams(location.search).has('batch')", timeout=WAIT_MS)
    if in_feed:
        page.click('#industry-groups h3 a[data-open-key]')
        page.wait_for_selector("dialog#detail[open]", timeout=WAIT_MS)
        title = page.evaluate("document.getElementById('detail-title').textContent")
        check("%s yc: an in-feed company opens the drawer for its feed item" % prefix, title == in_feed[0]["text"] and ("item=" + in_feed[0]["openKey"]) in page.url, title[:60])
        page.keyboard.press("Escape")
        page.wait_for_function("() => !document.querySelector('dialog#detail').open", timeout=WAIT_MS)
    if audit:
        audit_page(page, "%s yc desktop" % prefix, want_controls=True)


NOTEBOOK_STATE_JS = r"""
() => {
  const text = (el) => (el ? el.textContent.trim() : '');
  const stored = JSON.parse(localStorage.getItem('sr:notebook:v1') || 'null');
  return {
    banner: text(document.getElementById('notice')),
    status: text(document.getElementById('status')),
    count: text(document.getElementById('nb-items-count')),
    items: Array.from(document.querySelectorAll('#nb-items article.nb-item')).map((a) => ({
      key: a.dataset.key, title: text(a.querySelector('h3 a')), href: a.querySelector('h3 a').getAttribute('href'), openKey: a.querySelector('h3 a').dataset.openKey,
      note: a.querySelector('textarea.nb-note').value, tags: a.querySelector('input.nb-tags').value, chips: Array.from(a.querySelectorAll('.badge-tag')).map(text),
    })),
    emptyNote: document.getElementById('nb-items-empty').hidden ? null : text(document.getElementById('nb-items-empty')),
    canvasRows: Array.from(document.querySelectorAll('#nb-canvas-list .nb-canvas-row')).map((b) => ({ id: b.dataset.canvasId, title: text(b.querySelector('.nb-canvas-title')), pressed: b.getAttribute('aria-pressed'), meta: text(b.querySelector('.meta')) })),
    formHidden: document.getElementById('nb-canvas-form').hidden,
    formTitle: text(document.getElementById('nb-canvas-form-title')),
    linked: Array.from(document.querySelectorAll('#nb-linked-grid input')).map((i) => [i.dataset.linkKey, i.checked]),
    stored,
    storedItems: stored ? Object.keys(stored.items) : [],
    storedCanvases: stored ? Object.values(stored.canvases) : [],
    bodyText: document.body.innerText,
  };
}
"""


def goto_notebook(page, query=""):
    page.goto(BASE + "/notebook.html" + query, wait_until="domcontentloaded")
    page.wait_for_selector("#main[data-ready]", timeout=WAIT_MS)


def seed_notebook(page, item, with_canvas=True):
    """Write a one-item (+ one canvas) notebook into localStorage from a feed item (the documented saved shape)."""
    key = item_key(item["url"])
    saved = {
        "key": key, "title": item["title"], "url": item["url"], "source": {"id": item["source"]["id"], "name": item["source"].get("name", "")},
        "kind": item["kind"], "region": item["region"], "publishedAt": item["publishedAt"], "summary": item.get("summary") or "",
        "sectors": item.get("sectors") or [], "savedAt": "2026-01-01T00:00:00.000Z", "note": "Seeded by the harness", "tags": ["harness", "seed"],
    }
    canvases = {}
    if with_canvas:
        canvases["c-seed-1"] = {"id": "c-seed-1", "title": "Seed canvas", "problem": "p", "who": "w", "whyNow": "n", "existing": "e", "distribution": "d", "moat": "m", "firstTen": "f",
                                "linkedKeys": [key], "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z"}
    page.evaluate("(nb) => localStorage.setItem('sr:notebook:v1', JSON.stringify(nb))", {"version": 1, "items": {key: saved}, "canvases": canvases})
    return key


def smoke_notebook(page, ctx, prefix, audit=True):
    """Notebook page (FEAT-004): save on home -> listed, notes/tags persist, canvases, export/import, delete with confirm."""
    api = Api(ctx.request)
    items = api.data("items.json")
    by_key = dict((item_key(it["url"]), it) for it in items)
    accepted = []

    def on_dialog(d):
        accepted.append(d.message)
        d.accept()
    page.on("dialog", on_dialog)
    # empty state (navigate first: about:blank has no localStorage)
    goto_notebook(page)
    page.evaluate("localStorage.removeItem('sr:notebook:v1')")
    page.reload(wait_until="domcontentloaded")
    page.wait_for_selector("#main[data-ready]", timeout=WAIT_MS)
    s = page.evaluate(NOTEBOOK_STATE_JS)
    check("%s notebook: banner reads '%s'" % (prefix, NOTEBOOK_BANNER), s["banner"] == NOTEBOOK_BANNER, s["banner"])
    check("%s notebook empty: status '0 saved items · 0 canvases · stored in this browser only', no cards, empty note" % prefix, s["status"] == "0 saved items \u00b7 0 canvases \u00b7 stored in this browser only" and not s["items"] and s["emptyNote"] is not None and "bookmark" in s["emptyNote"], "%s | %s" % (s["status"], s["emptyNote"]))
    check("%s notebook: nothing on the page is called a score" % prefix, not re.search(r"\bscore\b", s["bodyText"], re.I))
    # save on the home page, then the notebook lists it
    goto_home(page)
    first = snapshot(page)["cards"][0]
    page.click('#results article.card[data-key="%s"] button.card-save' % first["key"])
    page.wait_for_function("() => { const n = JSON.parse(localStorage.getItem('sr:notebook:v1') || 'null'); return n && Object.keys(n.items).length === 1; }", timeout=WAIT_MS)
    # a second feed tab, booted before the note below is written (review-phase-1 iteration 2 #2: its later save must not erase it)
    feed = ctx.new_page()
    goto_home(feed)
    goto_notebook(page)
    s = page.evaluate(NOTEBOOK_STATE_JS)
    check("%s notebook: the item saved on the home page is listed with its title, opens in-app (?item=<key>), status says 1 saved item" % prefix,
          len(s["items"]) == 1 and s["items"][0]["key"] == first["key"] and s["items"][0]["title"] == first["title"] and s["items"][0]["href"] == "?item=" + first["key"] and s["items"][0]["openKey"] == first["key"] and s["status"].startswith("1 saved item \u00b7 0 canvases") and s["count"] == "1 saved item",
          json.dumps(s["items"])[:160])
    # note + tags persist (debounced 300 ms)
    page.fill("#nb-items article.nb-item textarea.nb-note", "Follow up next week")
    page.fill("#nb-items article.nb-item input.nb-tags", "idea, fintech , idea")
    page.wait_for_function("() => { const n = JSON.parse(localStorage.getItem('sr:notebook:v1')); const it = Object.values(n.items)[0]; return it.note === 'Follow up next week' && it.tags.length === 2; }", timeout=WAIT_MS)
    s = page.evaluate(NOTEBOOK_STATE_JS)
    saved = s["stored"]["items"][first["key"]]
    check("%s notebook: note and comma-separated tags are stored (trimmed, de-duplicated) and shown as chips" % prefix, saved["note"] == "Follow up next week" and saved["tags"] == ["idea", "fintech"] and s["items"][0]["chips"] == ["idea", "fintech"], json.dumps(saved)[:160])
    # the feed tab (boot-time copy without the note) saves a second item, then removes it again: the note and tags survive both writes
    second = snapshot(feed)["cards"][1]
    feed.click('#results article.card[data-key="%s"] button.card-save' % second["key"])
    feed.wait_for_function("() => Object.keys(JSON.parse(localStorage.getItem('sr:notebook:v1')).items).length === 2", timeout=WAIT_MS)
    stored = feed.evaluate("JSON.parse(localStorage.getItem('sr:notebook:v1'))")
    check("%s notebook: a save on a feed tab loaded before the note was written keeps the note and tags (re-reads storage first)" % prefix,
          sorted(stored["items"].keys()) == sorted([first["key"], second["key"]]) and stored["items"][first["key"]]["note"] == "Follow up next week" and stored["items"][first["key"]]["tags"] == ["idea", "fintech"],
          json.dumps(stored["items"].get(first["key"], {}))[:160])
    feed.click('#results article.card[data-key="%s"] button.card-save' % second["key"])
    feed.wait_for_function("() => Object.keys(JSON.parse(localStorage.getItem('sr:notebook:v1')).items).length === 1", timeout=WAIT_MS)
    stored = feed.evaluate("JSON.parse(localStorage.getItem('sr:notebook:v1'))")
    check("%s notebook: removing it again on the feed tab leaves the first item with its note" % prefix, list(stored["items"].keys()) == [first["key"]] and stored["items"][first["key"]]["note"] == "Follow up next week", json.dumps(stored["items"])[:160])
    feed.close()
    page.wait_for_function("() => document.querySelectorAll('#nb-items article.nb-item').length === 1", timeout=WAIT_MS)
    page.reload(wait_until="domcontentloaded")
    page.wait_for_selector("#main[data-ready]", timeout=WAIT_MS)
    s = page.evaluate(NOTEBOOK_STATE_JS)
    check("%s notebook: reload keeps the note and tags in the fields" % prefix, len(s["items"]) == 1 and s["items"][0]["note"] == "Follow up next week" and s["items"][0]["tags"] == "idea, fintech", json.dumps(s["items"])[:160])
    # search filters title/summary/note/tags
    page.fill("#nb-search", "fintech")
    page.wait_for_function("() => document.getElementById('nb-items-count').textContent.startsWith('1 of 1')", timeout=WAIT_MS)
    page.fill("#nb-search", "zqxjkvwpyq")
    page.wait_for_function("() => document.querySelectorAll('#nb-items article.nb-item').length === 0", timeout=WAIT_MS)
    s = page.evaluate(NOTEBOOK_STATE_JS)
    check("%s notebook: search matches a tag, a miss shows the 'no saved item matches' note and '0 of 1 saved item match'" % prefix, s["emptyNote"] is not None and s["emptyNote"].startswith("No saved item matches") and s["count"] == "0 of 1 saved item match", "%s | %s" % (s["count"], s["emptyNote"]))
    page.fill("#nb-search", "")
    page.wait_for_function("() => document.querySelectorAll('#nb-items article.nb-item').length === 1", timeout=WAIT_MS)
    # drawer from a saved item (the saved shape carries everything the drawer needs)
    page.click("#nb-items article.nb-item h3 a")
    page.wait_for_selector("dialog#detail[open]", timeout=WAIT_MS)
    title = page.evaluate("document.getElementById('detail-title').textContent")
    check("%s notebook: the title opens the drawer for the saved item under the page path with ?item=<key>, with a Saved row" % prefix, title == first["title"] and ("item=" + first["key"]) in page.url and urlsplit(page.url).path == urlsplit(BASE + "/notebook.html").path and page.evaluate("Array.from(document.querySelectorAll('#detail .detail-sectors dt')).some((d) => d.textContent === 'Saved')"), title[:60])
    page.keyboard.press("Escape")
    page.wait_for_function("() => !document.querySelector('dialog#detail').open", timeout=WAIT_MS)
    # canvases: new, fields saved as typed, link the saved item, duplicate, delete with confirm
    page.click("#nb-canvas-new")
    page.wait_for_selector("#nb-canvas-form:not([hidden])", timeout=WAIT_MS)
    page.fill("#cv-title", "Payroll for gig workers")
    page.fill("#cv-problem", "Weekly pay is late")
    page.wait_for_function("() => { const n = JSON.parse(localStorage.getItem('sr:notebook:v1')); const c = Object.values(n.canvases)[0]; return c && c.title === 'Payroll for gig workers' && c.problem === 'Weekly pay is late'; }", timeout=WAIT_MS)
    page.check("#nb-linked-grid input")
    page.wait_for_function("() => Object.values(JSON.parse(localStorage.getItem('sr:notebook:v1')).canvases)[0].linkedKeys.length === 1", timeout=WAIT_MS)
    s = page.evaluate(NOTEBOOK_STATE_JS)
    c = s["storedCanvases"][0]
    check("%s notebook: a new canvas stores the typed fields, links the saved item and shows up in the list as pressed" % prefix,
          len(s["canvasRows"]) == 1 and s["canvasRows"][0]["title"] == "Payroll for gig workers" and s["canvasRows"][0]["pressed"] == "true" and s["canvasRows"][0]["meta"] == "1 linked item" and c["linkedKeys"] == [first["key"]] and all(k in c for k in ("problem", "who", "whyNow", "existing", "distribution", "moat", "firstTen")) and s["status"].startswith("1 saved item \u00b7 1 canvas"),
          json.dumps(s["canvasRows"])[:160])
    page.click("#nb-canvas-duplicate")
    page.wait_for_function("() => document.querySelectorAll('#nb-canvas-list .nb-canvas-row').length === 2", timeout=WAIT_MS)
    s = page.evaluate(NOTEBOOK_STATE_JS)
    check("%s notebook: Duplicate adds '(copy)' with the same fields and links" % prefix, len(s["storedCanvases"]) == 2 and sorted(x["title"] for x in s["storedCanvases"]) == ["Payroll for gig workers", "Payroll for gig workers (copy)"] and all(x["linkedKeys"] == [first["key"]] and x["problem"] == "Weekly pay is late" for x in s["storedCanvases"]), json.dumps([x["title"] for x in s["storedCanvases"]]))
    # export JSON and Markdown really download, and the JSON round-trips through import (merge)
    with page.expect_download(timeout=WAIT_MS) as dl:
        page.click("#nb-export-json")
    d = dl.value
    exported = Path(d.path()).read_text(encoding="utf-8")
    parsed = json.loads(exported)
    check("%s notebook: Export JSON downloads startup-radar-notebook-<date>.json holding the saved item and both canvases" % prefix, re.match(r"^startup-radar-notebook-\d{4}-\d{2}-\d{2}\.json$", d.suggested_filename) is not None and parsed["version"] == 1 and list(parsed["items"].keys()) == [first["key"]] and len(parsed["canvases"]) == 2, d.suggested_filename)
    with page.expect_download(timeout=WAIT_MS) as dl:
        page.click("#nb-export-md")
    d = dl.value
    md = Path(d.path()).read_text(encoding="utf-8")
    check("%s notebook: Export Markdown downloads .md with the item link, note, tags, canvases and the browser-only line" % prefix, d.suggested_filename.endswith(".md") and md.startswith("# Startup Radar notebook") and ("](%s)" % by_key[first["key"]]["url"]) in md and "note: Follow up next week" in md and "tags: idea, fintech" in md and "### Payroll for gig workers" in md and "Saved in the browser only" in md, d.suggested_filename)
    # delete the item with confirm, then import the export to get it back (merge reports counts)
    page.click("#nb-items article.nb-item .nb-danger")
    page.wait_for_function("() => document.querySelectorAll('#nb-items article.nb-item').length === 0", timeout=WAIT_MS)
    s = page.evaluate(NOTEBOOK_STATE_JS)
    check("%s notebook: Remove asks for confirmation and removes the item from the page and from localStorage" % prefix, len(accepted) == 1 and accepted[0].startswith('Remove "') and s["storedItems"] == [] and s["status"].startswith("0 saved items \u00b7 2 canvases"), accepted[-1][:80] if accepted else "no confirm dialog")
    page.set_input_files("#nb-import-file", {"name": "notebook.json", "mimeType": "application/json", "buffer": exported.encode("utf-8")})
    page.wait_for_function("() => document.querySelectorAll('#nb-items article.nb-item').length === 1", timeout=WAIT_MS)
    page.wait_for_function("() => Array.from(document.querySelectorAll('#toasts .toast p')).some((p) => p.textContent.startsWith('Imported'))", timeout=WAIT_MS)
    toast_text = page.evaluate("Array.from(document.querySelectorAll('#toasts .toast p')).map((p) => p.textContent).find((t) => t.startsWith('Imported'))")
    s = page.evaluate(NOTEBOOK_STATE_JS)
    check("%s notebook: Import JSON merges the export back (item with note and tags restored, canvases unchanged) and toasts the counts" % prefix, s["storedItems"] == [first["key"]] and s["stored"]["items"][first["key"]]["note"] == "Follow up next week" and len(s["storedCanvases"]) == 2 and toast_text.startswith("Imported 1 saved item and 2 canvases (1 new items, 0 new canvases"), toast_text[:120])
    page.set_input_files("#nb-import-file", {"name": "bad.json", "mimeType": "application/json", "buffer": b"[1,2]"})
    page.wait_for_function("() => Array.from(document.querySelectorAll('#toasts .toast.error p')).some((p) => p.textContent.startsWith('Import failed:'))", timeout=WAIT_MS)
    check("%s notebook: a non-notebook file is rejected with an error toast and changes nothing" % prefix, page.evaluate("Object.keys(JSON.parse(localStorage.getItem('sr:notebook:v1')).items).length") == 1)
    if audit:
        # toasts animate in (transform); dismiss them so the control audit measures settled boxes
        page.evaluate("() => document.querySelectorAll('#toasts .toast-close').forEach((b) => b.click())")
        page.wait_for_function("() => document.querySelectorAll('#toasts .toast').length === 0", timeout=WAIT_MS)
        audit_page(page, "%s notebook desktop" % prefix, want_controls=True, want_links=False)
    # delete a canvas and everything, each behind confirm
    page.click("#nb-canvas-list .nb-canvas-row")
    page.wait_for_selector("#nb-canvas-form:not([hidden])", timeout=WAIT_MS)
    n_before = len(accepted)
    page.click("#nb-canvas-delete")
    page.wait_for_function("() => document.querySelectorAll('#nb-canvas-list .nb-canvas-row').length === 1", timeout=WAIT_MS)
    check("%s notebook: Delete canvas asks for confirmation and removes one canvas; the editor closes" % prefix, len(accepted) == n_before + 1 and page.evaluate("document.getElementById('nb-canvas-form').hidden") is True)
    page.click("#nb-delete-all")
    page.wait_for_function("() => document.getElementById('status').textContent.startsWith('0 saved items \u00b7 0 canvases')", timeout=WAIT_MS)
    check("%s notebook: Delete everything asks for confirmation and empties items and canvases" % prefix, len(accepted) == n_before + 2 and "Export first" in accepted[-1] and page.evaluate("JSON.parse(localStorage.getItem('sr:notebook:v1')).items") == {} and page.evaluate("JSON.parse(localStorage.getItem('sr:notebook:v1')).canvases") == {}, accepted[-1][:80])
    page.remove_listener("dialog", on_dialog)


# ---------------------------------------------------------------------------
# Audit matrix (design.md section 20; plan 3.5): page x width x theme x state
# ---------------------------------------------------------------------------

def audit_state(page, label, theme, width, data, expect_columns=None, sheet_open=False, kind="home"):
    """Run LAYOUT_JS + CONTRAST_AUDIT_JS + PREMISE_JS on the current state and assert the ACs."""
    settle(page)
    if kind == "home":
        # the 600 ms count-up is requestAnimationFrame-driven (not a WAAPI animation): wait for the final numbers
        try:
            page.wait_for_function("(exp) => [...document.querySelectorAll('.stat-n')].map((n) => n.textContent.trim()).join('|') === exp", arg="|".join(data.tiles()), timeout=5000)
        except Exception:  # noqa: BLE001 - the counts may have moved since Data was fetched (rolling windows); compare with fresh stats
            data.refresh_stats()
    lay = page.evaluate(LAYOUT_JS, {"width": width})
    con = page.evaluate(CONTRAST_AUDIT_JS, theme)
    pre = page.evaluate(PREMISE_JS, theme)
    mobile = width < 640 and page.viewport_size["width"] < 640
    check("%s: body 16px, no text < 12px" % label, lay["bodyFont"] >= MIN_BODY_FONT_PX and lay["minFont"] >= MIN_FONT_PX,
          "%d visible, body %.1fpx, min %.2fpx at %s" % (lay["visibleEls"], lay["bodyFont"], lay["minFont"], lay["minFontDesc"]))
    expect_h = 40 if (width >= 1024 and not mobile) else 44
    check("%s: controls = --control-h (%dpx)" % (label, expect_h), lay["controls"] >= 1 and lay["controlH"] == expect_h and abs(lay["controlMin"] - expect_h) <= 0.5 and abs(lay["controlMax"] - expect_h) <= 0.5,
          "%d controls, min %.1f max %.1f, --control-h %s" % (lay["controls"], lay["controlMin"], lay["controlMax"], lay["controlH"]))
    check("%s: scrollWidth <= innerWidth" % label, lay["scrollWidth"] <= lay["innerWidth"], "%d <= %d" % (lay["scrollWidth"], lay["innerWidth"]))
    worst_t = con["worstText"] or {}
    worst_n = con["worstNonText"] or {}
    check("%s: composited contrast (text >= 4.5, non-text >= 3.0, glass text only fg-0/fg-1)" % label, len(con["failures"]) == 0 and con["textCount"] > 0,
          "%d text pairs, worst %s %s->%s %.2f; %d non-text, worst %s %s->%s %.2f; %d glass texts%s" % (
              con["textCount"], worst_t.get("sel"), worst_t.get("fg"), worst_t.get("bg"), worst_t.get("ratio") or 0,
              con["nonTextCount"], worst_n.get("sel"), worst_n.get("fg"), worst_n.get("bg"), worst_n.get("ratio") or 0,
              con["glassTextCount"], ("; " + "; ".join(con["failures"][:4])) if con["failures"] else ""))
    check("%s: glass extreme %s and dot composite %s match the live tokens" % (label, con["glassExpected"], con["dotExpected"]), con["glassOk"] and con["dotOk"],
          "glass %s, dot %s" % (con["glassExtreme"], con["dotComposite"]))
    check("%s: premise (no paint more extreme than --fg-0)" % label, len(pre["offenders"]) == 0, "%d paints checked, L(fg-0)=%s%s" % (pre["checked"], pre["limit"], ("; " + "; ".join(pre["offenders"][:3])) if pre["offenders"] else ""))
    check("%s: layout/structure rules (AC 3, 10, 16, 17, 19; C8, C14)" % label, len(lay["problems"]) == 0 and len(lay["cardIssues"]) == 0,
          ("; ".join(lay["problems"][:5] + lay["cardIssues"][:3]) or "ok") + "; --topbar-h %s vs header %s" % (lay["topbarH"], lay["headerOffsetHeight"]))
    if expect_columns is not None and lay["cardCount"] >= expect_columns * 2:
        check("%s: %d card column(s)" % (label, expect_columns), lay["columns"] == expect_columns, "%d columns from %d cards" % (lay["columns"], lay["cardCount"]))
    if lay["cardCount"]:
        bad_badges = [b for b in lay["badges"] if b not in data.allowed_badges]
        bad_regions = [r for r in lay["regionBadges"] if r not in data.region_labels]
        check("%s: honest badges (sources, kinds, regions only) and sort options ['', 'points']" % label, not bad_badges and not bad_regions and lay["sortOptions"] == ["", "points"],
              "%d badges%s" % (len(lay["badges"]), ("; bad " + ", ".join((bad_badges + bad_regions)[:3])) if (bad_badges or bad_regions) else ""))
        # a label badge is titled "keyword-tagged (title + summary)"; a "+N" overflow badge is titled with the N hidden labels (app.js sectorBadges)
        def sector_badge_ok(b):
            m = re.match(r"^\+(\d+)$", b["text"])
            if m:
                hidden = b["title"].split(", ")
                return len(hidden) == int(m.group(1)) and all(h in data.sector_labels for h in hidden)
            return b["text"] in data.sector_labels and "keyword-tagged" in b["title"]
        bad_sectors = [b for b in lay["sectorBadges"] if not sector_badge_ok(b)]
        check("%s: sector badges use stats.json labels titled keyword-tagged, or +N titled with the N hidden labels" % label, not bad_sectors, "%d sector badges%s" % (len(lay["sectorBadges"]), ("; bad " + json.dumps(bad_sectors[:2])) if bad_sectors else ""))
        pairs = [[e["href"], data.by_key[e["key"]]["url"]] for e in lay["cardExt"] if e["key"] in data.by_key and e["href"]]
        # a.href is the parsed URL (e.g. a bare origin gains its trailing slash): compare after the same WHATWG normalisation
        ext_ok = len(pairs) == len(lay["cardExt"]) and page.evaluate("(pairs) => pairs.every(([href, url]) => href === new URL(url).href)", pairs)
        check("%s: every a.card-ext points at item.url" % label, ext_ok, "%d cards" % len(lay["cardExt"]))
    check("%s: static nav list equals NAV with aria-current on this page" % label, lay["navLinks"] is not None and [(l[0], l[1]) for l in lay["navLinks"]] == NAV and [l[2] for l in lay["navLinks"]].count("page") == 1 and lay["navLinks"][NAV_INDEX[kind]][2] == "page", str(lay["navLinks"])[:160])
    if kind == "sources" and lay["statN"]:
        texts = [s["text"] for s in lay["statN"]]
        src = data.sources["sources"]
        enabled = [s for s in src if s["enabled"]]
        expected = [str(len(src)), str(len(enabled)), str(len([s for s in enabled if s.get("lastError")]))]
        check("%s: status strip honest (%s) and single-line" % (label, " / ".join(texts)), texts == expected and all(s["lines"] == 1 and not s["overflow"] for s in lay["statN"]), "expected %s" % " / ".join(expected))
    elif lay["statN"] and not sheet_open:
        texts = [s["text"] for s in lay["statN"]]
        single = all(s["lines"] == 1 and s["ws"] == "nowrap" and not s["overflow"] for s in lay["statN"])
        honest = texts == data.tiles()
        check("%s: stat tiles honest (%s) and single-line" % (label, " / ".join(texts)), single and honest, "expected %s" % " / ".join(data.tiles()))
        if width >= 1024 and not mobile:
            # 268 px tiles at a 976 px content width; headless reserves a 15 px scrollbar gutter at 1024, so the content is 961 px and the tiles 259.5 px
            check("%s: stats 2x2 beside the radar (tiles >= 259px)" % label, lay["tileColumns"] == 2 and lay["tileMinWidth"] >= 259 and lay["radarDisplay"] != "none" and lay.get("radarInSecondColumn"), "%d columns, min %.1fpx, radar %s, layout viewport %s" % (lay["tileColumns"], lay["tileMinWidth"], lay["radarDisplay"], lay["layoutRight"]))
            hero = lay.get("hero") or {}
            check("%s: hero column fills the radar panel height (within 10%%, tiles end at the column bottom, 40 px numerals)" % label,
                  hero and abs(hero["mainH"] - hero["radarH"]) <= 0.1 * hero["radarH"] and hero["statsGap"] <= 1 and hero["statFont"] == 40 and hero["tileRows"] == 2,
                  "column %.0f vs radar %.0f px, gap below tiles %.1f, numeral %spx, %s rows" % (hero.get("mainH", 0), hero.get("radarH", 0), hero.get("statsGap", 0), hero.get("statFont"), hero.get("tileRows")))
            if lay.get("radarTitle") is not None:
                m = re.search(r"(\d+) items?", lay["radarTitle"], re.I)
                now = datetime.now(timezone.utc)
                n48 = data.within_48h(now)
                check("%s: radar title honest 48h count (%s)" % (label, lay["radarTitle"]), m is not None and abs(int(m.group(1)) - n48) <= 2 and lay["radarTitleTransform"] == "uppercase" and lay["blips"] == min(int(m.group(1)), 400), "expected ~%d, %d blips" % (n48, lay["blips"]))
        else:
            check("%s: radar panel hidden" % label, lay["radarDisplay"] in (None, "none"), str(lay["radarDisplay"]))
    return lay


def worker_offline(ctx, on):
    """Playwright's set_offline() does not reach service-worker fetches: make the worker's global fetch fail instead."""
    for w in ctx.service_workers:
        try:
            if on:
                w.evaluate("() => { if (!self.__realFetch) { self.__realFetch = self.fetch; self.fetch = () => Promise.reject(new TypeError('Failed to fetch')); } }")
            else:
                w.evaluate("() => { if (self.__realFetch) { self.fetch = self.__realFetch; delete self.__realFetch; } }")
        except Exception:  # noqa: BLE001 - a redundant/stopped worker
            pass


def run_matrix(browser, scheme):
    """Every page x width x state for one colour scheme (parity mode)."""
    data = Data(browser.new_context().request)
    for width in WIDTHS:
        mobile = width < 640
        vp = {"width": width, "height": 844 if mobile else 900}
        ctx = new_ctx(browser, viewport=vp, scheme=scheme, mobile=mobile)
        page = ctx.new_page()
        errors = ErrorLog(page)
        tag = "%s %dpx" % (scheme, width)
        goto_home(page)
        cols = 1 if width < 640 else (2 if width < 1280 else 3)
        audit_state(page, "home %s default" % tag, scheme, width, data, expect_columns=cols)
        goto_home(page, "?kind=funding&region=usa")
        wait_state(page, {"kind": "funding", "region": "usa"})
        audit_state(page, "home %s filtered" % tag, scheme, width, data, expect_columns=cols)
        goto_home(page)
        if mobile:
            open_sheet(page)
            page.click("#sources-filter summary")
            page.wait_for_selector("#source-list input", state="visible", timeout=WAIT_MS)
            audit_state(page, "home %s sheet+sources open" % tag, scheme, width, data, sheet_open=True)
            close_sheet(page)
        else:
            page.click("#sources-filter summary")
            page.wait_for_selector("#source-list input", state="visible", timeout=WAIT_MS)
            lay = audit_state(page, "home %s sources popover open" % tag, scheme, width, data, expect_columns=cols)
            if width >= 1024:
                check("home %s: popover inside the viewport with >= 2 grid tracks (C15)" % tag, lay.get("popoverRight", 1e9) <= width and lay.get("gridTracks", 0) >= 2, "right %s, tracks %s" % (lay.get("popoverRight"), lay.get("gridTracks")))
            page.click("#sources-filter summary")
        if width in (768, 1280):
            page.click("#view-list")
            page.wait_for_function("() => document.getElementById('results').classList.contains('view-list')", timeout=WAIT_MS)
            audit_state(page, "home %s list view" % tag, scheme, width, data, expect_columns=1)
            page.click("#view-grid")
            page.wait_for_function("() => !document.getElementById('results').classList.contains('view-list')", timeout=WAIT_MS)
        key = page.evaluate("document.querySelector('#results article').dataset.key")
        goto_home(page, "?item=" + key)
        page.wait_for_selector("dialog#detail[open]", timeout=WAIT_MS)
        audit_state(page, "home %s drawer open" % tag, scheme, width, data)
        page.keyboard.press("Escape")
        page.wait_for_function("() => !document.querySelector('dialog#detail').open", timeout=WAIT_MS)
        page.keyboard.press("Escape")
        page.keyboard.press("?")
        page.wait_for_selector("dialog#help[open]", timeout=WAIT_MS)
        audit_state(page, "home %s help open" % tag, scheme, width, data)
        page.keyboard.press("Escape")
        page.wait_for_function("() => !document.querySelector('dialog#help').open", timeout=WAIT_MS)
        goto_sources(page)
        audit_state(page, "sources %s" % tag, scheme, width, data, kind="sources")
        # FEAT-003 lens pages: the same computed-style audit (font floor, controls, contrast, overflow, shell)
        for kind, _, _ in LENS_PAGES:
            if kind == "notebook":
                # a seeded saved item + canvas so the cards, chips, textareas and the open editor are audited too
                seed_notebook(page, data.items[0])
                goto_lens(page, kind)
                page.click("#nb-canvas-list .nb-canvas-row")
                page.wait_for_selector("#nb-canvas-form:not([hidden])", timeout=WAIT_MS)
            else:
                goto_lens(page, kind)
            audit_state(page, "%s %s" % (kind, tag), scheme, width, data, kind=kind)
            if kind == "trends":
                check("%s %s: sparklines present with HTML axis labels (no scaled SVG text)" % (kind, tag), page.evaluate("document.querySelectorAll('#sector-grid .sparkline').length >= 1 && document.querySelectorAll('#sector-grid svg text').length === 0"))
            if kind == "yc" and width >= 1024:
                page.click("#industry-groups details:nth-of-type(2) summary")
                page.wait_for_function("() => document.querySelectorAll('#industry-groups details[open]').length >= 2", timeout=WAIT_MS)
                audit_state(page, "%s %s second group open" % (kind, tag), scheme, width, data, kind=kind)
            if kind == "funding" and width in (390, 1280):
                key = page.evaluate("document.querySelector('#funding-table tbody tr[data-key]') && document.querySelector('#funding-table tbody tr[data-key]').dataset.key")
                if key:
                    goto_lens(page, kind, "?item=" + key)
                    page.wait_for_selector("dialog#detail[open]", timeout=WAIT_MS)
                    audit_state(page, "%s %s drawer open" % (kind, tag), scheme, width, data, kind=kind)
                    page.keyboard.press("Escape")
                    page.wait_for_function("() => !document.querySelector('dialog#detail').open", timeout=WAIT_MS)
        errors.check("matrix %s" % tag)
        ctx.close()


# ---------------------------------------------------------------------------
# Finding-specific checks (plan 3.6) and scenario checks (plan 3.7)
# ---------------------------------------------------------------------------

STICKY_JS = r"""
(dy) => {
  window.scrollBy(0, dy);
  const h = document.querySelector('header.site-header');
  const tb = document.querySelector('.topbar');
  const fp = document.getElementById('filter-panel');
  const th = document.querySelector('#sources-table thead');
  const tw = document.getElementById('table-wrap');
  const cs = (el, p) => (el ? getComputedStyle(el)[p] : null);
  return {
    scrollY: window.scrollY,
    headerTop: h.getBoundingClientRect().top,
    topbarTop: tb.getBoundingClientRect().top,
    headerH: h.offsetHeight,
    topbarVar: getComputedStyle(document.documentElement).getPropertyValue('--topbar-h').trim(),
    panelTop: fp && getComputedStyle(fp).position === 'sticky' ? fp.getBoundingClientRect().top : null,
    theadTop: th && getComputedStyle(th).position === 'sticky' ? th.getBoundingClientRect().top : null,
    theadBackdrop: th ? (cs(th, 'backdropFilter') || cs(th, 'webkitBackdropFilter')) : null,
    wrapOverflow: tw ? [cs(tw, 'overflowX'), cs(tw, 'overflowY')] : null,
  };
}
"""


def run_sticky(browser):
    """S1 (HIGH): the top bar really sticks; the desktop filter bar and the sources thead sit under it."""
    for width in (1280, 390):
        mobile = width < 640
        ctx = new_ctx(browser, viewport={"width": width, "height": 844 if mobile else 900}, mobile=mobile)
        page = ctx.new_page()
        goto_home(page)
        s = page.evaluate(STICKY_JS, 1200)
        check("S1 home %dpx: header.site-header and .topbar stay at top 0 after scrollBy(0, 1200)" % width, s["scrollY"] > 0 and s["headerTop"] == 0 and s["topbarTop"] == 0, "scrollY %d, header top %s, topbar top %s" % (s["scrollY"], s["headerTop"], s["topbarTop"]))
        check("S1 home %dpx: --topbar-h equals header.offsetHeight" % width, s["topbarVar"] == "%dpx" % s["headerH"], "%s vs %dpx" % (s["topbarVar"], s["headerH"]))
        if width >= 1024:
            check("S1 home %dpx: #filter-panel top == header.offsetHeight while scrolled" % width, s["panelTop"] is not None and abs(s["panelTop"] - s["headerH"]) <= 0.5, "panel top %s, header %s" % (s["panelTop"], s["headerH"]))
        goto_sources(page)
        s = page.evaluate(STICKY_JS, 600 if width >= 1024 else 1200)
        check("S1 sources %dpx: header stays at top 0 after scrolling" % width, s["scrollY"] > 0 and s["headerTop"] == 0 and s["topbarTop"] == 0, "scrollY %d, header top %s" % (s["scrollY"], s["headerTop"]))
        check("S1 sources %dpx: #table-wrap overflow visible on both axes" % width, s["wrapOverflow"] == ["visible", "visible"], str(s["wrapOverflow"]))
        if width >= 1024:
            check("S1 sources %dpx: solid sticky thead top == header.offsetHeight after scrollBy(0, 600)" % width, s["theadTop"] is not None and abs(s["theadTop"] - s["headerH"]) <= 0.5 and s["theadBackdrop"] == "none", "thead top %s, header %s, backdrop %s" % (s["theadTop"], s["headerH"], s["theadBackdrop"]))
        ctx.close()


BUDGET_JS = r"""
() => {
  const w = document.querySelector('.topbar .wrap');
  const lr = document.getElementById('last-refreshed');
  const q = document.getElementById('q');
  const h = document.querySelector('header.site-header');
  const text = lr.querySelector('.status-text');
  const before = text.textContent;
  text.textContent = 'Last refreshed 12 min ago \u00b7 update check failed';
  const r = {
    scroll: w.scrollWidth, client: w.clientWidth, docScroll: document.documentElement.scrollWidth, inner: innerWidth,
    statusH: lr.getBoundingClientRect().height, qW: q ? q.getBoundingClientRect().width : null,
    headerH: h.offsetHeight, topbarVar: getComputedStyle(document.documentElement).getPropertyValue('--topbar-h').trim(),
  };
  text.textContent = before;
  return r;
}
"""


def run_topbar_budget(browser):
    """S4 (MEDIUM): the top bar never overflows with the longest status text at every width."""
    for width in (320, 640, 768, 1024, 1280, 1920):
        mobile = width < 640
        ctx = new_ctx(browser, viewport={"width": width, "height": 844 if mobile else 900}, mobile=mobile)
        page = ctx.new_page()
        for path, label in (("home", "home"), ("sources", "sources")):
            if path == "home":
                goto_home(page)
            else:
                goto_sources(page)
            r = page.evaluate(BUDGET_JS)
            # 13 px mono (7.8 px/char) wraps by words. At 320 the status gets 288 - 28 (mark) - 44 (toggle) - 65 (nav link)
            # - 24 (gaps) = 127 px, i.e. 14 characters: "Last refreshed" / "12 min ago" (2 lines) and the failure suffix in
            # 4 lines (72.8 px). The bar grows (rows use min-height, --topbar-h is measured) and never overflows.
            max_status = 73 if width < 640 else 37
            q_ok = r["qW"] is None or width < 640 or r["qW"] >= 160
            check("S4 %s %dpx: top bar fits the longest status (wrap scroll <= client, doc scroll <= inner, status <= %dpx, #q >= 160px)" % (label, width, max_status),
                  r["scroll"] <= r["client"] and r["docScroll"] <= r["inner"] and r["statusH"] <= max_status and q_ok,
                  "wrap %d/%d, doc %d/%d, status %.1fpx, q %s, header %dpx" % (r["scroll"], r["client"], r["docScroll"], r["inner"], r["statusH"], r["qW"], r["headerH"]))
        ctx.close()


def active(page):
    return page.evaluate("(() => { const a = document.activeElement; return a ? (a.id || (a.tagName.toLowerCase() + '.' + a.className)) : null; })()")


def run_keyboard(browser):
    """K3 (MEDIUM, the Esc rule), C9 (focus targets) and AC 28 (the key map never hijacks typing)."""
    ctx = new_ctx(browser, viewport=DESKTOP)
    page = ctx.new_page()
    errors = ErrorLog(page)
    goto_home(page)
    # popover + Esc on a checked checkbox
    page.click("#sources-filter summary")
    page.wait_for_selector("#source-list input", state="visible", timeout=WAIT_MS)
    box = page.evaluate("document.querySelector('#source-list input').id")
    page.check("#" + box)
    wait_state(page, {"source": box[4:]})
    page.keyboard.press("Escape")
    check("K3: Esc on a checked source checkbox closes the popover, focuses summary, keeps the filter", page.evaluate("!document.getElementById('sources-filter').open") and page.evaluate("document.activeElement === document.querySelector('#sources-filter summary')") and "source=" in page.evaluate("location.search"), "active %s, search %s" % (active(page), page.evaluate("location.search")))
    # popover open + #q focused + Esc
    page.click("#sources-filter summary")
    page.wait_for_selector("#source-list input", state="visible", timeout=WAIT_MS)
    page.fill("#q", "abc")
    wait_state(page, {"q": "abc"})
    page.focus("#q")
    page.keyboard.press("Escape")
    check("K3: Esc in #q while the popover is open closes the popover (focus -> summary) and leaves #q.value alone", page.evaluate("!document.getElementById('sources-filter').open") and page.evaluate("document.getElementById('q').value") == "abc" and active(page) == "summary.", "value %r, active %s" % (page.evaluate("document.getElementById('q').value"), active(page)))
    page.focus("#q")
    page.keyboard.press("Escape")
    check("K3: Esc in #q with nothing open is left to the browser (native clears the search field)", page.evaluate("document.getElementById('q').value") == "" and "source=" in page.evaluate("location.search"), "value %r" % page.evaluate("document.getElementById('q').value"))
    page.click("#reset")
    wait_state(page, {"source": ABSENT, "q": ABSENT})
    # typing never triggers shortcuts
    page.focus("#q")
    page.keyboard.type("jkto/?")
    check("AC 28: typing j k t o / ? into #q only inserts characters", page.evaluate("document.getElementById('q').value") == "jkto/?" and page.evaluate("document.documentElement.dataset.theme") == "dark" and not page.evaluate("document.querySelector('dialog#help').open"), page.evaluate("document.getElementById('q').value"))
    page.fill("#q", "")
    wait_state(page, {"q": ABSENT})
    page.evaluate("document.activeElement.blur()")
    # / and Shift+/ focus #q without a slash; Enter applies without navigation
    page.keyboard.press("/")
    check("AC 28: / focuses #q and inserts nothing", active(page) == "q" and page.evaluate("document.getElementById('q').value") == "")
    page.evaluate("document.activeElement.blur()")
    page.keyboard.press("Shift+/")  # key '/' with shiftKey (a de-DE Shift+7 style layout): shift is ignored for / and ?
    check("AC 28: Shift+/ (key '/' with Shift held) still focuses #q without inserting a slash", active(page) == "q" and page.evaluate("document.getElementById('q').value") == "", active(page))
    page.evaluate("document.activeElement.blur()")
    base = snapshot(page)
    words = re.findall(WORD_RE, base["cards"][0]["title"])
    term = words[0]
    page.focus("#q")
    page.keyboard.type(term)
    page.keyboard.press("Enter")
    wait_state(page, {"q": term})
    check("AC 28: Enter in #q applies the query without a navigation", page.evaluate("performance.getEntriesByType('navigation').length") == 1 and "q=" in page.evaluate("location.search"), page.evaluate("location.search"))
    page.fill("#q", "")
    wait_state(page, {"q": ABSENT})
    page.evaluate("document.activeElement.blur()")
    # j/k/arrows/Home/End move focus between card links and keep the card below the sticky bars
    page.keyboard.press("j")
    idx = lambda: page.evaluate("[...document.querySelectorAll('#results article')].indexOf(document.activeElement.closest('article'))")
    check("AC 28: j focuses the first card link with .is-active", active(page) == "a.card-link" and idx() == 0 and page.evaluate("document.activeElement.closest('article').classList.contains('is-active')"))
    page.keyboard.press("ArrowDown")
    check("AC 28: ArrowDown moves to the second card", idx() == 1)
    page.keyboard.press("k")
    check("AC 28: k moves back to the first card", idx() == 0)
    page.keyboard.press("End")
    last = page.evaluate("document.querySelectorAll('#results article').length - 1")
    top_ok = page.evaluate("document.activeElement.closest('article').getBoundingClientRect().top >= parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sticky-h')) - 0.5")
    check("AC 28: End jumps to the last rendered card, kept below the sticky bars", idx() == last and top_ok, "index %d of %d" % (idx(), last))
    page.keyboard.press("Home")
    check("AC 28: Home jumps to the first card", idx() == 0)
    page.keyboard.press("ArrowUp")
    check("AC 28: ArrowUp at the first card is a no-op", idx() == 0)
    scroll_before = page.evaluate("window.scrollY")
    page.keyboard.press("Escape")
    check("K3: Esc with only a highlight clears it and blurs", page.evaluate("document.querySelectorAll('#results .is-active').length") == 0 and page.evaluate("document.activeElement === document.body") and page.evaluate("window.scrollY") == scroll_before)
    # Enter opens; Esc twice closes once; drawer keys
    page.keyboard.press("j")
    page.keyboard.press("Enter")
    page.wait_for_selector("dialog#detail[open]", timeout=WAIT_MS)
    check("AC 28: Enter on a focused card link opens the drawer (delegated click, no navigation)", page.evaluate("performance.getEntriesByType('navigation').length") == 1 and active(page) == "detail-title")
    page.keyboard.press("Escape")
    page.wait_for_function("() => !document.querySelector('dialog#detail').open", timeout=WAIT_MS)
    page.wait_for_timeout(200)
    url_after = page.evaluate("location.search")
    page.keyboard.press("Escape")
    check("K3: Esc closes the drawer; a second Esc only clears the highlight", url_after == "" and not page.evaluate("document.querySelector('dialog#detail').open") and page.evaluate("document.querySelectorAll('#results .is-active').length") == 0)
    # t and ?
    page.keyboard.press("t")
    check("AC 28: t toggles the theme", page.evaluate("document.documentElement.dataset.theme") == "light")
    page.keyboard.press("t")
    page.keyboard.press("?")
    page.wait_for_selector("dialog#help[open]", timeout=WAIT_MS)
    keys = page.evaluate("[...document.querySelectorAll('#help dl.help-list kbd')].map((k) => k.textContent)")
    check("C9/AC 28: ? opens dialog#help labelled by #help-title with focus on it, listing every shortcut", page.evaluate("document.querySelector('dialog#help').getAttribute('aria-labelledby') === 'help-title'") and active(page) == "help-title" and all(k in keys for k in SHORTCUT_KEYS), "missing %s" % [k for k in SHORTCUT_KEYS if k not in keys])
    page.keyboard.press("t")
    check("AC 28: t works inside the help dialog", page.evaluate("document.documentElement.dataset.theme") == "light")
    page.keyboard.press("t")
    page.keyboard.press("Escape")
    page.wait_for_function("() => !document.querySelector('dialog#help').open", timeout=WAIT_MS)
    check("K3: Esc closes help and returns focus to the opener", not page.evaluate("document.querySelector('dialog#help').open"))
    # select keeps native keys
    page.focus("#kind")
    page.keyboard.press("ArrowDown")
    page.wait_for_timeout(400)
    check("AC 28: ArrowDown on #kind keeps native select behaviour (value changes, no card focus)", page.evaluate("document.getElementById('kind').value") != "" and active(page) == "kind", page.evaluate("document.getElementById('kind').value"))
    errors.check("keyboard")
    ctx.close()
    # phone sheet: Esc from a select inside the sheet
    mctx = new_ctx(browser, viewport=MOBILE, mobile=True)
    mpage = mctx.new_page()
    goto_home(mpage)
    open_sheet(mpage)
    check("C9: opening the sheet focuses #filter-panel-title", active(mpage) == "filter-panel-title", active(mpage))
    mpage.focus("#kind")
    mpage.keyboard.press("Escape")
    check("K3 390px: Esc on #kind inside the sheet closes it (hidden, no role), focuses #filters-open, restores overflow", mpage.evaluate("document.getElementById('filter-panel').hidden") and mpage.evaluate("document.getElementById('filter-panel').getAttribute('role')") is None and active(mpage) == "filters-open" and mpage.evaluate("getComputedStyle(document.documentElement).overflow") == "visible", active(mpage))
    mctx.close()


DRAWER_JS = r"""
() => {
  const d = document.getElementById('detail');
  const p = d.querySelector('.detail-panel');
  const r = p.getBoundingClientRect();
  const primary = d.querySelector('a.btn-primary');
  const hrefs = [...d.querySelectorAll('a[href]')].map((a) => a.href);
  const rows = [...d.querySelectorAll('dl.detail-meta dt')].map((t) => t.textContent);
  return {
    open: d.open, modal: d.getAttribute('aria-modal'), labelledby: d.getAttribute('aria-labelledby'), describedby: d.getAttribute('aria-describedby'),
    summaryExists: !!document.getElementById('detail-summary'), title: document.getElementById('detail-title').textContent,
    badges: [...d.querySelectorAll('.detail-badges .badge')].length, time: !!d.querySelector('p.detail-time'), rows,
    primary: primary ? { href: primary.href, target: primary.target, rel: primary.rel, text: primary.textContent.trim() } : null,
    dupHref: hrefs.length !== new Set(hrefs).size, copy: !!document.getElementById('detail-copy'),
    prev: document.getElementById('detail-prev').disabled, next: document.getElementById('detail-next').disabled, pos: d.querySelector('.detail-pos').textContent,
    right: r.right, width: r.width, bottom: r.bottom, left: r.left, clientWidth: document.documentElement.clientWidth, layoutRight: document.documentElement.getBoundingClientRect().right, innerHeight,
    toastsInDialog: document.getElementById('toasts').parentElement === d, activeId: document.activeElement.id, title2: document.title,
    hostnameRow: rows.includes('Destination'), scrollTop: p.scrollTop, iframes: document.querySelectorAll('iframe, embed, object').length,
  };
}
"""


def run_drawer(browser):
    """AC 22-27 + D6 (clientWidth geometry) + T7 (toast placement) + C10 (Enter with a stale selection) + C11 + C20 (`o`)."""
    for width in (1280, 390, 768):
        mobile = width < 640
        ctx = new_ctx(browser, viewport={"width": width, "height": 844 if mobile else (1024 if width == 768 else 900)}, mobile=mobile)
        page = ctx.new_page()
        errors = ErrorLog(page)
        data = Data(ctx.request)
        goto_home(page)
        base = snapshot(page)
        item = data.by_key[base["cards"][0]["key"]]
        hist = page.evaluate("history.length")
        page.click("#results article h2 a")
        page.wait_for_selector("dialog#detail[open]", timeout=WAIT_MS)
        settle(page)
        d = page.evaluate(DRAWER_JS)
        check("AC 22 %dpx: dialog semantics (aria-modal, labelledby=detail-title, describedby=detail-summary present), badges, time, copy, prev/next" % width,
              d["modal"] == "true" and d["labelledby"] == "detail-title" and d["describedby"] == "detail-summary" and d["summaryExists"] and d["badges"] == 3 and d["time"] == bool(item.get("publishedAt")) and d["copy"] and d["prev"] and not d["next"],
              "pos %s, rows %s" % (d["pos"], d["rows"]))
        # a.href is the parsed URL (a bare origin gains its trailing slash): compare after the same WHATWG normalisation
        item_href = page.evaluate("(u) => new URL(u).href", item["url"])
        check("AC 22 %dpx: primary action is item.url in a new tab, no duplicate hrefs, hostname row" % width, d["primary"] and d["primary"]["href"] == item_href and d["primary"]["target"] == "_blank" and d["primary"]["rel"] == "noopener noreferrer" and not d["dupHref"] and d["hostnameRow"], str(d["primary"]))
        check("AC 22 %dpx: 'n of N' equals the filtered total" % width, d["pos"] == "1 of %d" % base["total"], d["pos"])
        check("AC 23 %dpx: open pushed one history entry with item=<key>, title swapped, focus on the title" % width, page.evaluate("history.length") == hist + 1 and "item=" + base["cards"][0]["key"] in page.evaluate("location.search") and d["activeId"] == "detail-title" and d["title2"].startswith(item["title"][:20]), "%s -> %s" % (hist, page.evaluate("history.length")))
        # D6: measured against the layout viewport's right edge (documentElement.getBoundingClientRect().right), never
        # innerWidth. It equals documentElement.clientWidth in a real browser; headless Chromium hides scrollbars yet
        # `scrollbar-gutter: stable` still reserves 15 px, so clientWidth is reported alongside.
        if width >= 1024:
            check("D6/AC 27 %dpx: right drawer flush with the layout viewport (documentElement right edge), width <= 520" % width, abs(d["right"] - d["layoutRight"]) <= 0.5 and d["width"] <= 520.5, "right %s, layout viewport %s, clientWidth %s, width %s" % (d["right"], d["layoutRight"], d["clientWidth"], d["width"]))
        else:
            check("D6/AC 27 %dpx: bottom sheet (bottom == innerHeight, left 0, width == layout viewport)" % width, abs(d["bottom"] - d["innerHeight"]) <= 0.5 and d["left"] == 0 and abs(d["width"] - d["layoutRight"]) <= 0.5, "bottom %s/%s, left %s, width %s, layout viewport %s, clientWidth %s" % (d["bottom"], d["innerHeight"], d["left"], d["width"], d["layoutRight"], d["clientWidth"]))
        check("AC 22 %dpx: #toasts is a child of the open dialog" % width, d["toastsInDialog"])
        # toast placement (T7)
        page.evaluate("navigator.clipboard.writeText = () => Promise.resolve()")
        page.click("#detail-copy")
        page.wait_for_selector("#toasts .toast", timeout=WAIT_MS)
        t = page.evaluate("(() => { const t = document.querySelector('#toasts .toast').getBoundingClientRect(); const f = document.querySelector('footer.detail-nav').getBoundingClientRect(); const hit = !(t.right <= f.left || t.left >= f.right || t.bottom <= f.top || t.top >= f.bottom); return { top: t.top, bottom: t.bottom, left: t.left, right: t.right, text: document.querySelector('#toasts .toast p').textContent, hit, visible: t.width > 0 && t.bottom <= innerHeight && t.top >= 0 }; })()")
        if width >= 1024:
            check("T7/AC 22 %dpx: 'Link copied' toast bottom-left, visible, not over footer.detail-nav" % width, t["text"] == "Link copied" and t["visible"] and not t["hit"] and t["left"] < 100, "top %.0f left %.0f hit %s" % (t["top"], t["left"], t["hit"]))
        else:
            check("T7 %dpx: toast top-centre above the sheet (top < innerHeight/2), not over footer.detail-nav" % width, t["text"] == "Link copied" and t["visible"] and not t["hit"] and t["top"] < page.viewport_size["height"] / 2, "top %.0f hit %s" % (t["top"], t["hit"]))
        # prev/next + keys use replaceState
        page.click("#detail-next")
        page.wait_for_function("() => document.querySelector('.detail-pos').textContent.startsWith('2 of')", timeout=WAIT_MS)
        key2 = page.evaluate("new URLSearchParams(location.search).get('item')")
        check("AC 25 %dpx: Next shows item 2 via replaceState (history unchanged), .is-open moved" % width, key2 == base["cards"][1]["key"] and page.evaluate("history.length") == hist + 1 and page.evaluate("document.querySelector('.card.is-open').dataset.key") == key2, key2)
        page.keyboard.press("ArrowLeft")
        page.wait_for_function("() => document.querySelector('.detail-pos').textContent.startsWith('1 of')", timeout=WAIT_MS)
        check("AC 25 %dpx: ArrowLeft goes back to item 1 and Previous is disabled there" % width, page.evaluate("document.getElementById('detail-prev').disabled") is True)
        page.keyboard.press("j")
        page.wait_for_function("() => document.querySelector('.detail-pos').textContent.startsWith('2 of')", timeout=WAIT_MS)
        page.keyboard.press("k")
        page.wait_for_function("() => document.querySelector('.detail-pos').textContent.startsWith('1 of')", timeout=WAIT_MS)
        check("AC 25 %dpx: j / k step inside the drawer" % width, True)
        page.focus("#detail-title")
        scrolled = page.evaluate("(() => { const p = document.querySelector('.detail-panel'); p.scrollTop = 0; return { canScroll: p.scrollHeight > p.clientHeight, before: p.scrollTop }; })()")
        if scrolled["canScroll"]:
            page.keyboard.press("ArrowDown")
            page.wait_for_timeout(300)
            check("AC 25 %dpx: ArrowDown scrolls .detail-panel without changing the item" % width, page.evaluate("document.querySelector('.detail-panel').scrollTop") > scrolled["before"] and page.evaluate("document.querySelector('.detail-pos').textContent").startswith("1 of"), "scrollTop %s" % page.evaluate("document.querySelector('.detail-panel').scrollTop"))
        # C11: a debounced search behind the modal keeps item=
        page.evaluate("(() => { const q = document.getElementById('q'); q.value = 'a'; q.dispatchEvent(new Event('input', { bubbles: true })); })()")
        page.wait_for_timeout(450)
        check("C11 %dpx: a re-render behind the modal keeps ?item= and .is-open" % width, "item=" in page.evaluate("location.search") and page.evaluate("document.querySelector('dialog#detail').open"), page.evaluate("location.search"))
        page.evaluate("(() => { const q = document.getElementById('q'); q.value = ''; q.dispatchEvent(new Event('input', { bubbles: true })); })()")
        page.wait_for_timeout(450)
        # C20: `o` opens a new page, no toast, no leftover anchor
        page.evaluate("document.querySelectorAll('#toasts .toast').forEach((t) => t.remove())")
        current_item = data.by_key[page.evaluate("new URLSearchParams(location.search).get('item')")]
        with ctx.expect_page() as popup_info:
            page.keyboard.press("o")
        popup = popup_info.value
        popup_url = popup.url
        if popup_url in ("", "about:blank"):
            try:
                popup.wait_for_url(lambda u: u not in ("", "about:blank"), timeout=5000)
            except Exception:
                pass
            popup_url = popup.url
        popup.close()
        check("C20/AC 25 %dpx: `o` opens item.url in a new tab, current URL unchanged" % width, popup_url.split("#")[0].rstrip("/") == current_item["url"].split("#")[0].rstrip("/") and "item=" in page.evaluate("location.search"), "popup %s" % popup_url[:80])
        check("C20 %dpx: no hidden anchor left behind and no toast" % width, page.evaluate("document.querySelectorAll('dialog#detail a[hidden], body > a[hidden]').length") == 0 and page.evaluate("document.querySelectorAll('#toasts .toast').length") == 0 and "item=" in page.evaluate("location.search"))
        # close routes: Esc -> focus return; Back / Forward
        page.keyboard.press("Escape")
        page.wait_for_function("() => !document.querySelector('dialog#detail').open", timeout=WAIT_MS)
        page.wait_for_function("() => !location.search.includes('item=')", timeout=WAIT_MS)
        check("AC 23 %dpx: Esc closes, URL restored, title restored, focus on the originating card link, toasts back in body" % width,
              page.evaluate("location.search") == "" and page.evaluate("document.title").startswith("Startup Radar") and page.evaluate("document.activeElement.classList.contains('card-link')") and page.evaluate("document.getElementById('toasts').parentElement.tagName") == "BODY" and page.evaluate("history.length") == hist + 1,
              "active %s, history %s" % (active(page), page.evaluate("history.length")))
        page.go_forward()
        page.wait_for_selector("dialog#detail[open]", timeout=WAIT_MS)
        check("AC 23 %dpx: Forward re-opens the drawer" % width, "item=" in page.evaluate("location.search"))
        page.go_back()
        page.wait_for_function("() => !document.querySelector('dialog#detail').open", timeout=WAIT_MS)
        page.wait_for_timeout(300)
        check("AC 23 %dpx: Back closes the drawer and restores the URL" % width, page.evaluate("location.search") == "" and page.evaluate("document.activeElement.classList.contains('card-link')"), active(page))
        # close button and backdrop click
        page.click("#results article h2 a")
        page.wait_for_selector("dialog#detail[open]", timeout=WAIT_MS)
        page.click("#detail-close")
        page.wait_for_function("() => !document.querySelector('dialog#detail').open", timeout=WAIT_MS)
        page.wait_for_timeout(300)
        page.click("#results article h2 a")
        page.wait_for_selector("dialog#detail[open]", timeout=WAIT_MS)
        settle(page)
        page.mouse.click(10, 10 if width >= 1024 else 60)
        page.wait_for_function("() => !document.querySelector('dialog#detail').open", timeout=WAIT_MS)
        page.wait_for_timeout(300)
        check("AC 23 %dpx: close button and backdrop click both close with the URL restored" % width, page.evaluate("location.search") == "" and page.evaluate("history.length") == hist + 1, "history %s" % page.evaluate("history.length"))
        # C10: Enter with a stale text selection
        page.evaluate("getSelection().selectAllChildren(document.querySelector('p.lede'))")
        page.focus("#results article h2 a")
        page.keyboard.press("Enter")
        page.wait_for_selector("dialog#detail[open]", timeout=WAIT_MS)
        check("C10 %dpx: Enter with a stale selection opens the drawer without navigating" % width, page.evaluate("performance.getEntriesByType('navigation').length") == 1 and page.evaluate("document.querySelector('dialog#detail').open"))
        page.keyboard.press("Escape")
        page.wait_for_function("() => !document.querySelector('dialog#detail').open", timeout=WAIT_MS)
        page.wait_for_timeout(300)
        # deep link (no push) and unknown key
        hl = page.evaluate("history.length")
        goto_home(page, "?item=" + base["cards"][2]["key"])
        page.wait_for_selector("dialog#detail[open]", timeout=WAIT_MS)
        check("AC 24 %dpx: ./?item=<key> opens the drawer on load without pushState state" % width, page.evaluate("history.state") is None and page.evaluate("document.getElementById('detail-title').textContent") == base["cards"][2]["title"])
        page.keyboard.press("Escape")
        page.wait_for_function("() => !document.querySelector('dialog#detail').open", timeout=WAIT_MS)
        page.wait_for_function("() => !location.search.includes('item=')", timeout=WAIT_MS)
        goto_home(page, "?item=zzzzzzzz")
        page.wait_for_selector("#toasts .toast", timeout=WAIT_MS)
        check("AC 24 %dpx: unknown key -> toast and the param is removed, no drawer" % width, page.evaluate("document.querySelector('#toasts .toast p').textContent") == "That item is no longer in the feed" and page.evaluate("location.search") == "" and not page.evaluate("document.querySelector('dialog#detail').open"))
        check("AC 26 %dpx: no iframe/embed/object" % width, page.evaluate("document.querySelectorAll('iframe, embed, object').length") == 0)
        if width == 1280:
            # polish pass: honest labels (no "HN author" on a non-HN item), one Published value, relative header time, plurals on cards
            non_hn = next((it for it in data.items if not str(it["source"]["id"]).startswith("hn_") and isinstance((it.get("extra") or {}).get("author"), str)), None)
            hn = next((it for it in data.items if str(it["source"]["id"]).startswith("hn_") and isinstance((it.get("extra") or {}).get("author"), str)), None)
            for label, it, want in (("non-HN", non_hn, "Author"), ("HN", hn, "HN author")):
                if it is None:
                    check("P3 %dpx: a %s item with an author exists in the data" % (width, label), False, "none found")
                    continue
                goto_home(page, "?item=" + item_key(it["url"]))
                page.wait_for_selector("dialog#detail[open]", timeout=WAIT_MS)
                d3 = page.evaluate("(() => { const p = document.querySelector('#detail .detail-panel'); const t = p.querySelector('p.detail-time'); const tm = t && t.querySelector('time'); return { dts: [...p.querySelectorAll('dl.detail-meta dt')].map((x) => x.textContent), published: (p.textContent.match(/Published/g) || []).length, head: t ? t.textContent.trim() : null, title: tm ? tm.title : null, datetime: tm ? tm.getAttribute('datetime') : null, rel: tm ? tm.hasAttribute('data-rel') : false }; })()")
                rel_ok = d3["head"] is not None and (re.match(r"^(just now|\d+ (min|h|d) ago)$", d3["head"]) or re.search(r"\d{4}", d3["head"])) and d3["title"] and d3["datetime"] == it["publishedAt"] and d3["rel"]
                branded = [x for x in d3["dts"] if x.startswith("HN ") or x.startswith("PH ")]
                generic = [x for x in d3["dts"] if x in ("Author", "Points", "Comments", "Votes")]
                src = str(it["source"]["id"])
                labels_ok = want in d3["dts"] and (all(x.startswith("HN ") for x in branded) and not generic if src.startswith("hn_") else all(x == "PH votes" and src == "producthunt" for x in branded))
                check("P3/P4 %dpx: %s item (%s) -> author row '%s', no brand leak, exactly one 'Published', header line = relative time with the absolute in title" % (width, label, src, want),
                      labels_ok and d3["published"] == 1 and rel_ok,
                      "rows %s; Published x%d; head '%s' title '%s'" % (d3["dts"], d3["published"], d3["head"], d3["title"]))
                page.keyboard.press("Escape")
                page.wait_for_function("() => !document.querySelector('dialog#detail').open", timeout=WAIT_MS)
            metas = page.evaluate("[...document.querySelectorAll('#results .meta')].map((m) => m.textContent)")
            bad_plural = [m for m in metas if re.search(r"\b1 (points|comments|votes)\b", m) or re.search(r"\b(0|[2-9]|\d{2,}) (point|comment|vote)\b", m)]
            check("P3 %dpx: card meta lines use correct singular/plural (point/points, comment/comments, vote/votes)" % width, len(metas) > 0 and not bad_plural, "%d meta lines, bad %s" % (len(metas), bad_plural[:3]))
            # the documented screenshot: the first card opened with the mouse (a pointer interaction, so the programmatic
            # focus on the title does not draw the keyboard focus ring that the Escape presses above would otherwise trigger)
            goto_home(page)
            page.click("#results article h2 a")
            page.wait_for_selector("dialog#detail[open]", timeout=WAIT_MS)
            shot(page, "detail.png")
        errors.check("drawer %dpx" % width)
        ctx.close()


NAV_STATE_JS = r"""
() => {
  const nav = document.querySelector('nav.site-nav');
  const ul = document.getElementById('site-nav-list');
  const btn = document.getElementById('nav-toggle');
  const r = (el) => el.getBoundingClientRect();
  const vis = (el) => { const b = r(el); return b.width > 0 && b.height > 0; };
  const links = Array.from(ul.querySelectorAll('a'));
  return {
    open: nav.classList.contains('is-open'), expanded: btn.getAttribute('aria-expanded'), controls: btn.getAttribute('aria-controls'), label: btn.getAttribute('aria-label'),
    btnH: r(btn).height, btnVisible: vis(btn), listVisible: vis(ul), linkHeights: links.map((a) => r(a).height), linksVisible: links.filter(vis).length,
    listLeft: r(ul).left, listRight: r(ul).right, listTop: r(ul).top, headerBottom: document.querySelector('header.site-header').getBoundingClientRect().bottom,
    scrollWidth: document.documentElement.scrollWidth, innerWidth, active: document.activeElement ? document.activeElement.id : null,
    labels: links.map((a) => [a.textContent.trim(), a.getAttribute('href'), a.getAttribute('aria-current')]),
  };
}
"""


def run_shell(browser):
    """FEAT-002: shared shell (phone nav dropdown, nav row, `g` chords), sector chips + badges, bookmarks, drawer sections."""
    for width in (320, 390):
        ctx = new_ctx(browser, viewport={"width": width, "height": 844}, mobile=True)
        page = ctx.new_page()
        errors = ErrorLog(page)
        goto_home(page)
        s = page.evaluate(NAV_STATE_JS)
        check("shell %dpx: #nav-toggle visible (44px, aria-controls=site-nav-list), list hidden" % width, s["btnVisible"] and abs(s["btnH"] - 44) <= 0.5 and s["controls"] == "site-nav-list" and s["label"] == "Menu" and s["expanded"] == "false" and not s["listVisible"], str({k: s[k] for k in ("btnH", "expanded", "listVisible")}))
        page.click("#nav-toggle")
        page.wait_for_function("() => document.querySelector('nav.site-nav').classList.contains('is-open')", timeout=WAIT_MS)
        s = page.evaluate(NAV_STATE_JS)
        check("shell %dpx: toggle opens the dropdown (aria-expanded=true, six 44px rows, full width under the header, no overflow)" % width,
              s["open"] and s["expanded"] == "true" and s["linksVisible"] == 6 and all(abs(h - 44) <= 0.5 for h in s["linkHeights"]) and s["listLeft"] == 0 and abs(s["listRight"] - s["innerWidth"]) <= 16 and abs(s["listTop"] - s["headerBottom"]) <= 1 and s["scrollWidth"] <= s["innerWidth"],
              "rows %s, list %s-%s top %s header %s, scroll %s/%s" % (s["linkHeights"], s["listLeft"], s["listRight"], s["listTop"], s["headerBottom"], s["scrollWidth"], s["innerWidth"]))
        check("shell %dpx: dropdown lists NAV in order with aria-current on Feed" % width, [(l[0], l[1]) for l in s["labels"]] == NAV and s["labels"][0][2] == "page", str(s["labels"])[:120])
        page.keyboard.press("Escape")
        page.wait_for_function("() => !document.querySelector('nav.site-nav').classList.contains('is-open')", timeout=WAIT_MS)
        s = page.evaluate(NAV_STATE_JS)
        check("shell %dpx: Esc closes the dropdown, aria-expanded=false, focus on the toggle, highlight untouched" % width, not s["open"] and s["expanded"] == "false" and not s["listVisible"] and s["active"] == "nav-toggle" and page.evaluate("document.querySelectorAll('#results .is-active').length") == 0)
        page.click("#nav-toggle")
        page.wait_for_function("() => document.querySelector('nav.site-nav').classList.contains('is-open')", timeout=WAIT_MS)
        # the open panel covers the hero, so a real tap there would hit the panel: dispatch the pointerdown on an outside element
        page.dispatch_event("footer.site-footer p", "pointerdown")
        page.wait_for_function("() => !document.querySelector('nav.site-nav').classList.contains('is-open')", timeout=WAIT_MS)
        check("shell %dpx: an outside pointerdown closes the dropdown (no drawer opened)" % width, not page.evaluate("document.querySelector('dialog#detail').open"))
        page.click("#nav-toggle")
        page.wait_for_function("() => document.querySelector('nav.site-nav').classList.contains('is-open')", timeout=WAIT_MS)
        # the shell's Esc only runs while the menu is open: with it closed, Esc on the page stays the page's (one-Esc rule)
        page.keyboard.press("Escape")
        page.wait_for_function("() => !document.querySelector('nav.site-nav').classList.contains('is-open')", timeout=WAIT_MS)
        goto_sources(page)
        s = page.evaluate(NAV_STATE_JS)
        check("shell %dpx sources: toggle present, list hidden, aria-current on Sources" % width, s["btnVisible"] and not s["listVisible"] and s["labels"][5][2] == "page" and [(l[0], l[1]) for l in s["labels"]] == NAV)
        errors.check("shell %dpx" % width)
        ctx.close()

    ctx = new_ctx(browser, viewport=DESKTOP)
    page = ctx.new_page()
    errors = ErrorLog(page)
    data = Data(ctx.request)
    goto_home(page)
    s = page.evaluate(NAV_STATE_JS)
    check("shell 1280px: nav is a row of six visible links under the brand row, toggle hidden, --topbar-h == header height", s["linksVisible"] == 6 and not s["btnVisible"] and page.evaluate("Math.abs(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--topbar-h')) - document.querySelector('header.site-header').offsetHeight) <= 0.5"), "%d visible, header %s" % (s["linksVisible"], page.evaluate("document.querySelector('header.site-header').offsetHeight")))
    keys = page.evaluate("(() => { document.getElementById('help-open').click(); return [...document.querySelectorAll('#help dl.help-list dt')].map((d) => d.textContent.trim()); })()")
    page.keyboard.press("Escape")
    page.wait_for_function("() => !document.querySelector('dialog#help').open", timeout=WAIT_MS)
    check("shell 1280px: help lists the g-chords (g h, g t, g f, g y, g n)", all(k in keys for k in ("g h", "g t", "g f", "g y", "g n")), str(keys)[:200])
    # g + t navigates (routed: trends.html does not exist until FEAT-003; the stub declares an icon so no /favicon.ico probe fires)
    page.route("**/trends.html", lambda route: route.fulfill(status=200, content_type="text/html", body='<!DOCTYPE html><title>routed</title><link rel="icon" href="./icons/favicon.svg"><h1>routed</h1>'))
    page.focus("#q")
    page.keyboard.type("gt")
    page.wait_for_timeout(300)
    check("shell 1280px: `g` `t` typed into #q only inserts characters", page.evaluate("document.getElementById('q').value") == "gt" and "trends" not in page.url, page.url)
    page.fill("#q", "")
    wait_state(page, {"q": ABSENT})
    page.evaluate("document.activeElement.blur()")
    with page.expect_navigation(wait_until="domcontentloaded", timeout=WAIT_MS):
        page.keyboard.press("g")
        page.keyboard.press("t")
    check("shell 1280px: `g` then `t` navigates to ./trends.html (routed)", page.url == BASE + "/trends.html", page.url)
    page.unroute("**/trends.html")
    goto_home(page)
    page.keyboard.press("g")
    page.wait_for_timeout(900)
    page.keyboard.press("t")
    page.wait_for_timeout(200)
    check("shell 1280px: `g` expires after 800 ms (`t` then toggles the theme, no navigation)", page.url.startswith(BASE + "/") and "trends" not in page.url and page.evaluate("document.documentElement.dataset.theme") == "light")
    page.keyboard.press("t")
    # sector chips
    chips = page.evaluate("[...document.querySelectorAll('#sector-chips button.chip-sector')].map((b) => ({ id: b.dataset.sector, text: b.textContent, pressed: b.getAttribute('aria-pressed') }))")
    expected_chips = ["%s \u00b7 %d" % (s["label"], s["count"]) for s in data.sectors]
    check("sectors: one chip per stats.sectors entry labelled '<label> · <count>' under 'Sectors · keyword-tagged'", [c["text"] for c in chips] == expected_chips and all(c["pressed"] == "false" for c in chips) and page.evaluate("document.getElementById('sector-label').textContent") == "Sectors \u00b7 keyword-tagged", "%d chips" % len(chips))
    base = snapshot(page)
    pick = next((s for s in data.sectors if 0 < s["count"] < len(data.items)), None)
    if pick is None:
        check("sectors: a sector with items exists", False)
    else:
        sid = pick["id"]
        expected_total = len([it for it in data.items if sid in (it.get("sectors") or [])])
        page.click('#sector-chips button[data-sector="%s"]' % sid)
        wait_state(page, {"sector": sid})
        snap = snapshot(page)
        cards_ok = all(sid in (data.by_key[c["key"]].get("sectors") or []) for c in snap["cards"] if c["key"] in data.by_key)
        badge_ok = page.evaluate("(label) => [...document.querySelectorAll('#results article.card')].every((c) => [...c.querySelectorAll('.badge-sector')].some((b) => b.textContent.trim() === label || /^\\+\\d+$/.test(b.textContent.trim())))", pick["label"])
        check("sectors: chip %s -> URL sector=%s, total %d = items carrying it, every card carries it (badge or +N), chip pressed, filter count 1" % (sid, sid, expected_total),
              snap["total"] == expected_total and snap["total"] < base["total"] and cards_ok and badge_ok and page.get_attribute('#sector-chips button[data-sector="%s"]' % sid, "aria-pressed") == "true" and page.evaluate("document.querySelector('#filters-open .count-badge').textContent") == "1",
              "UI %s, expected %s, baseline %s" % (snap["total"], expected_total, base["total"]))
        second = next((s for s in data.sectors if s["id"] != sid and s["count"] > 0), None)
        if second:
            page.click('#sector-chips button[data-sector="%s"]' % second["id"])
            wait_state(page, {"sector": "%s,%s" % (sid, second["id"])})
            snap2 = snapshot(page)
            exp2 = len([it for it in data.items if sid in (it.get("sectors") or []) or second["id"] in (it.get("sectors") or [])])
            check("sectors: two chips = OR within the facet (sector=a,b, total %d)" % exp2, snap2["total"] == exp2, "UI %s" % snap2["total"])
        page.click("#reset")
        wait_state(page, {"sector": ABSENT})
        snap = snapshot(page)
        check("sectors: Reset clears sector= and restores the baseline", snap["total"] == base["total"] and page.evaluate("document.querySelectorAll('#sector-chips [aria-pressed=\"true\"]').length") == 0)
        goto_home(page, "?sector=%s,bogus" % sid)
        wait_state(page, {"sector": sid})
        check("sectors: ?sector= round trip drops unknown ids and keeps %s pressed" % sid, page.get_attribute('#sector-chips button[data-sector="%s"]' % sid, "aria-pressed") == "true" and snapshot(page)["total"] == expected_total)
        goto_home(page)
    # bookmarks
    page.evaluate("localStorage.removeItem('sr:notebook:v1')")
    page.reload(wait_until="domcontentloaded")
    wait_cards(page)
    first = snapshot(page)["cards"][0]
    btn = '#results article.card[data-key="%s"] button.card-save' % first["key"]
    check("bookmark: every card has button.card-save (aria-pressed=false, label 'Save to notebook')", page.evaluate("[...document.querySelectorAll('#results article.card')].every((c) => { const b = c.querySelector('button.card-save'); return b && b.getAttribute('aria-pressed') === 'false' && b.getAttribute('aria-label') === 'Save to notebook'; })"))
    page.click(btn)
    page.wait_for_selector("#toasts .toast", timeout=WAIT_MS)
    stored = page.evaluate("JSON.parse(localStorage.getItem('sr:notebook:v1') || 'null')")
    saved = (stored or {}).get("items", {}).get(first["key"])
    check("bookmark: click stores the item in localStorage['sr:notebook:v1'] with the documented fields, toasts 'stored in this browser only', no drawer",
          stored and stored.get("version") == 1 and saved and saved["url"] == data.by_key[first["key"]]["url"] and all(k in saved for k in ("key", "title", "url", "source", "kind", "region", "publishedAt", "summary", "sectors", "savedAt")) and page.evaluate("document.querySelector('#toasts .toast p').textContent") == "Saved to notebook \u00b7 stored in this browser only" and not page.evaluate("document.querySelector('dialog#detail').open") and page.get_attribute(btn, "aria-pressed") == "true",
          json.dumps(saved)[:160] if saved else str(stored)[:160])
    page.reload(wait_until="domcontentloaded")
    wait_cards(page)
    check("bookmark: reload keeps the pressed state", page.get_attribute(btn, "aria-pressed") == "true" and page.get_attribute(btn, "aria-label") == "Saved \u2014 remove from notebook")
    # drawer: sectors row, save action, related section
    page.click('#results article.card[data-key="%s"] h2 a' % first["key"])
    page.wait_for_selector("dialog#detail[open]", timeout=WAIT_MS)
    page.wait_for_function("() => /related items? in 90 days$/.test(document.querySelector('#detail .related h3').textContent)", timeout=WAIT_MS)
    d = page.evaluate("(() => { const p = document.querySelector('#detail .detail-panel'); const rel = p.querySelector('.related'); const save = p.querySelector('.detail-actions [data-save-key]'); const sec = p.querySelector('.detail-sectors'); return { h3: rel.querySelector('h3').textContent, n: rel.querySelectorAll('button.related-item').length, method: (rel.querySelector('p.method') || {}).textContent, afterMeta: !!sec ? sec.compareDocumentPosition(p.querySelector('.detail-actions')) & Node.DOCUMENT_POSITION_FOLLOWING : true, relBeforeActions: !!(rel.compareDocumentPosition(p.querySelector('.detail-actions')) & Node.DOCUMENT_POSITION_FOLLOWING), save: save ? { pressed: save.getAttribute('aria-pressed'), text: save.textContent.trim(), h: save.getBoundingClientRect().height } : null, sectors: sec ? { title: sec.querySelector('dd').title, badges: [...sec.querySelectorAll('.badge-sector')].map((b) => b.textContent.trim()) } : null, itemHeights: [...rel.querySelectorAll('button.related-item')].map((b) => b.getBoundingClientRect().height) }; })()")
    item = data.by_key[first["key"]]
    want_sectors = [next(s["label"] for s in data.sectors if s["id"] == sid) for sid in (item.get("sectors") or [])]
    m = re.match(r"^Related \u00b7 (\d+) related items? in 90 days$", d["h3"])
    check("drawer: sections render between the metadata and the actions: Sectors row (keyword-tagged, %s), 'Related · N related items in 90 days' with <= 5 40px items and the method sentence" % want_sectors,
          m is not None and d["n"] <= 5 and d["n"] <= int(m.group(1)) and d["method"].startswith("method: token overlap") and d["relBeforeActions"] and d["afterMeta"] and (d["sectors"] == {"title": "keyword-tagged (title + summary)", "badges": want_sectors} if want_sectors else d["sectors"] is None) and all(abs(h - 40) <= 0.5 for h in d["itemHeights"]),
          "h3 '%s', %d items, sectors %s" % (d["h3"], d["n"], d["sectors"]))
    check("drawer: 'Saved' secondary action is pressed for the bookmarked item (40px control)", d["save"] and d["save"]["pressed"] == "true" and d["save"]["text"] == "Saved" and abs(d["save"]["h"] - 40) <= 0.5, str(d["save"]))
    page.click("#detail .detail-actions [data-save-key]")
    page.wait_for_function("() => document.querySelector('#toasts .toast p') && document.querySelector('#toasts .toast p').textContent === 'Removed from notebook'", timeout=WAIT_MS)
    check("drawer: toggling in the drawer removes the item, repaints the card button and toasts 'Removed from notebook'", page.evaluate("JSON.parse(localStorage.getItem('sr:notebook:v1')).items") == {} and page.get_attribute(btn, "aria-pressed") == "false" and page.get_attribute("#detail .detail-actions [data-save-key]", "aria-pressed") == "false")
    page.keyboard.press("Escape")
    page.wait_for_function("() => !document.querySelector('dialog#detail').open", timeout=WAIT_MS)
    page.wait_for_timeout(300)
    # related items + history: the first loaded card that has at least one related item (the first card may have none)
    related_key = None
    for card in snapshot(page)["cards"]:
        page.click('#results article.card[data-key="%s"] h2 a' % card["key"])
        page.wait_for_selector("dialog#detail[open]", timeout=WAIT_MS)
        page.wait_for_function("() => /related items? in 90 days$/.test(document.querySelector('#detail .related h3').textContent)", timeout=WAIT_MS)
        if page.evaluate("document.querySelectorAll('#detail .related-list button.related-item').length") >= 1:
            related_key = card["key"]
            break
        page.keyboard.press("Escape")
        page.wait_for_function("() => !document.querySelector('dialog#detail').open", timeout=WAIT_MS)
        page.wait_for_timeout(300)
    if related_key is None:
        check("drawer: related-item history steps", True, "no loaded card has a related item on this data; Back step not exercised")
    else:
        rel_item = data.by_key[related_key]
        hist = page.evaluate("history.length")
        page.click("#detail .related-list button.related-item")
        page.wait_for_function("(t) => document.getElementById('detail-title').textContent !== t", arg=rel_item["title"], timeout=WAIT_MS)
        check("drawer: a related item opens in the same drawer with a pushed history entry (?item=<key>)", page.evaluate("history.length") == hist + 1 and "item=" in page.evaluate("location.search") and page.evaluate("new URLSearchParams(location.search).get('item')") != related_key)
        # Back from the related entry must re-open the previous item in the still-open drawer (review-phase-1 #1)
        page.go_back()
        page.wait_for_function("(t) => document.getElementById('detail-title').textContent === t", arg=rel_item["title"], timeout=WAIT_MS)
        check("drawer: Back after a related item shows the previous item again with its key in the URL",
              page.evaluate("document.querySelector('dialog#detail').open") and page.evaluate("new URLSearchParams(location.search).get('item')") == related_key)
        page.keyboard.press("Escape")
        page.wait_for_function("() => !document.querySelector('dialog#detail').open", timeout=WAIT_MS)
        page.wait_for_timeout(300)
        check("drawer: Esc after Back leaves no ?item in the URL", page.evaluate("new URLSearchParams(location.search).get('item')") is None)
        # review-phase-1 iteration 2 #1: arriving on a deep link (an entry the drawer never pushed), opening a related
        # item and going Back re-opens the deep-linked item; Esc must then stay on the page (no history.back() out of it)
        goto_home(page, "?item=%s" % related_key)
        page.wait_for_selector("dialog#detail[open]", timeout=WAIT_MS)
        page.wait_for_function("(t) => document.getElementById('detail-title').textContent === t", arg=rel_item["title"], timeout=WAIT_MS)
        page.wait_for_selector("#detail .related-list button.related-item", timeout=WAIT_MS)
        hist = page.evaluate("history.length")
        page.click("#detail .related-list button.related-item")
        page.wait_for_function("(t) => document.getElementById('detail-title').textContent !== t", arg=rel_item["title"], timeout=WAIT_MS)
        page.go_back()
        page.wait_for_function("(t) => document.getElementById('detail-title').textContent === t", arg=rel_item["title"], timeout=WAIT_MS)
        check("drawer: deep link -> related item -> Back shows the deep-linked item again (history.state is not the drawer's)",
              page.evaluate("document.querySelector('dialog#detail').open") and page.evaluate("new URLSearchParams(location.search).get('item')") == related_key and page.evaluate("history.state === null || history.state.sr !== 'item'"), str(page.evaluate("history.state")))
        # a history.back() out of the page would load the previous document: the marker proves this document survived Esc
        page.evaluate("window.__srDeepLinkDoc = true")
        page.keyboard.press("Escape")
        page.wait_for_function("() => !document.querySelector('dialog#detail').open", timeout=WAIT_MS)
        page.wait_for_timeout(500)
        check("drawer: Esc after that Back stays in this document (same path, ?item dropped by replaceState, the related entry kept as Forward)",
              page.evaluate("window.__srDeepLinkDoc === true") and urlsplit(page.url).path == urlsplit(BASE + "/").path and page.evaluate("new URLSearchParams(location.search).get('item')") is None and page.evaluate("history.length") == hist + 1,
              "%s, history %s -> %s" % (page.url, hist, page.evaluate("history.length")))
    errors.check("shell desktop")
    ctx.close()


class Served:
    """Mutable JSON bodies for routed data files (page.route reads the current value per request)."""

    def __init__(self, ctx, data):
        self.items = list(data.items)
        self.stats = dict(data.stats)
        self.archive = None  # None -> 404
        self.counts = {"stats": 0, "items": 0, "archive": 0}
        self.delay_ms = {"archive": 0, "items": 0}
        self.hold = set()  # names whose responses are parked until release()
        self.held = []
        ctx.route("**/data/stats.json", lambda route: self._fulfil(route, "stats", self.stats))
        ctx.route("**/data/items.json", lambda route: self._fulfil(route, "items", self.items))
        ctx.route("**/data/archive.json", lambda route: self._fulfil(route, "archive", self.archive))

    def release(self):
        held, self.held = self.held, []
        for route, name, body in held:
            self._send(route, body)

    def _fulfil(self, route, name, body):
        self.counts[name] += 1
        if name in self.hold:
            self.held.append((route, name, body))
            return
        if self.delay_ms.get(name):
            time.sleep(self.delay_ms[name] / 1000)
        self._send(route, body)

    def _send(self, route, body):
        if body is None:
            route.fulfill(status=404, content_type="application/json", body=json.dumps({"error": "not found"}))
        else:
            route.fulfill(status=200, content_type="application/json", headers={"Cache-Control": "no-store"}, body=json.dumps(body))


def fake_item(data, n, hours_ago):
    base = dict(data.items[0])
    when = datetime.now(timezone.utc) - timedelta(hours=hours_ago)
    if hours_ago < 1:
        # feeds sometimes publish future-dated entries: a "just now" harness item must still sort first
        newest = max((parse_iso(i["publishedAt"]) for i in data.items if i.get("publishedAt")), default=when)
        when = max(when, newest + timedelta(seconds=n))
    base.update({
        "id": 900000 + n, "title": "Harness item %d" % n, "url": "https://harness.test/item-%d" % n,
        "publishedAt": to_iso(when), "summary": "Injected by scripts/screenshots.py.", "extra": {},
    })
    return base


def run_live_data(browser):
    """AC 29-31 + C17 + C18: 5-minute polling, the real new-items diff, the archive merge, the ticker, honest sort."""
    data = Data(browser.new_context().request)
    ctx = new_ctx(browser, viewport=DESKTOP)
    page = ctx.new_page()
    errors = ErrorLog(page)
    served = Served(ctx, data)
    page.clock.install()
    goto_home(page)
    base = snapshot(page)
    check("AC 29: stats.json requested once at load", served.counts["stats"] == 1, "%d" % served.counts["stats"])
    page.clock.fast_forward(60_000)
    page.wait_for_timeout(200)
    check("AC 29: no stats poll after 60 s", served.counts["stats"] == 1, "%d" % served.counts["stats"])
    # ticker + no live-region churn
    # every card time, not just the first: a future-dated feed entry renders as a fixed date and never ticks
    times_js = "[...document.querySelectorAll('#results time[data-rel]')].map((t) => t.textContent).join('|')"
    first_time = page.evaluate(times_js)
    announce_before = page.evaluate("document.getElementById('refresh-announce').textContent")
    served.items = [fake_item(data, 1, 0.02)] + served.items  # one unknown key, published 'just now'
    served.stats = dict(served.stats, lastRefresh=to_iso(datetime.now(timezone.utc)), generatedAt=to_iso(datetime.now(timezone.utc)), archiveItems=0)
    page.clock.fast_forward(240_000)
    page.wait_for_function("() => !document.getElementById('new-items').hidden", timeout=WAIT_MS)
    check("AC 29: exactly one more stats.json request after fast_forward(300000) and a re-fetch of items.json", served.counts["stats"] == 2 and served.counts["items"] == 2, "stats %d, items %d" % (served.counts["stats"], served.counts["items"]))
    pill = page.evaluate("document.querySelector('#new-items .pill-text').textContent")
    check("AC 29: pill reads '1 new item - Refresh' and the list is unchanged until pressed", pill == "1 new item \u00b7 Refresh" and snapshot(page)["cards"][0]["title"] == base["cards"][0]["title"], pill)
    check("AC 30: after 5 minutes relative times ticked and #last-refreshed changed, #refresh-announce changed only because lastRefresh changed, #last-refreshed has no aria-live",
          page.evaluate(times_js) != first_time and page.evaluate("document.getElementById('last-refreshed').getAttribute('aria-live')") is None and page.evaluate("document.getElementById('refresh-announce').textContent") != announce_before,
          "%s -> %s" % (first_time[:40], page.evaluate(times_js)[:40]))
    page.click("#new-items-btn")
    wait_state(page, {})
    snap = snapshot(page)
    check("AC 29: pressing the pill merges: first card is the new item, count +1, pill hidden", snap["cards"][0]["title"] == "Harness item 1" and snap["total"] == base["total"] + 1 and page.evaluate("document.getElementById('new-items').hidden"), "%s / %s" % (snap["total"], base["total"]))
    check("AC 19: Feed tile follows the merged count", page.evaluate("document.querySelector('#stat-feed .stat-n').textContent") == str(len(served.items)), page.evaluate("document.querySelector('#stat-feed .stat-n').textContent"))
    # archive split appears in a later build: served archive + archiveItems: 1
    served.archive = [fake_item(data, 2, 30 * 24)]
    served.stats = dict(served.stats, lastRefresh=to_iso(datetime.now(timezone.utc) + timedelta(seconds=1)), archiveItems=1)
    served.items = [fake_item(data, 3, 0.01)] + served.items
    page.clock.fast_forward(300_000)
    page.wait_for_function("() => !document.getElementById('new-items').hidden", timeout=WAIT_MS)
    page.click("#new-items-btn")
    wait_state(page, {})
    page.click('button.chip[data-since=""]')
    page.wait_for_function("() => document.querySelector('#results').getAttribute('aria-busy') === 'false' && document.getElementById('result-count').textContent.indexOf('recent') < 0", timeout=WAIT_MS)
    snap = snapshot(page)
    check("AC 29: archive.json served with archiveItems: 1 -> the archived item is reachable after the merge (All time)", served.counts["archive"] >= 1 and snap["total"] == base["total"] + 3, "archive requests %d, total %s" % (served.counts["archive"], snap["total"]))
    # shrink without new keys -> tile updates, no pill
    served.items = served.items[:-5]
    served.stats = dict(served.stats, lastRefresh=to_iso(datetime.now(timezone.utc) + timedelta(seconds=2)))
    page.clock.fast_forward(300_000)
    page.wait_for_function("(n) => document.querySelector('#stat-feed .stat-n').textContent === String(n)", arg=len(served.items) + 1, timeout=WAIT_MS)
    check("AC 19: a shrunken items.json with no new keys updates the Feed tile silently (length + archiveItems) and the pill stays hidden", page.evaluate("document.getElementById('new-items').hidden") is True)
    # honest sort
    page.select_option("#sort", "points")
    wait_state(page, {"sort": "points"})
    pts = page.evaluate("[...document.querySelectorAll('#results article p.meta')].map((m) => { const x = /(\\d+) (points|votes)/.exec(m.textContent); return x ? +x[1] : null; })")
    valued = [p for p in pts if p is not None]
    tail_ok = all(p is None for p in pts[len(valued):]) if valued else True
    check("AC 31: sort=points orders valued items descending first, URL + note + count suffix", valued == sorted(valued, reverse=True) and tail_ok and len(valued) >= 1 and page.evaluate("!document.querySelector('.sort-note').hidden") and page.evaluate("document.getElementById('result-count').textContent").endswith("sorted by points/votes"), "first values %s" % pts[:6])
    page.select_option("#sort", "")
    wait_state(page, {"sort": ABSENT})
    check("AC 31: Newest restores newest-first and removes the param", page.evaluate("location.search") == "" and snapshot(page)["cards"][0]["title"] == "Harness item 3")
    page.select_option("#sort", "points")
    wait_state(page, {"sort": "points"})
    page.click("#reset")
    wait_state(page, {"sort": ABSENT})
    check("AC 31: #reset clears sort too", page.evaluate("location.search") == "")
    # C17: #load-more disabled only while the archive loads
    goto_home(page)
    served.archive = [fake_item(data, 4, 20 * 24)]
    served.stats = dict(served.stats, archiveItems=1)
    served.delay_ms["archive"] = 300
    page.reload(wait_until="domcontentloaded")
    wait_cards(page)
    labels = set()
    while page.evaluate("document.getElementById('load-more').textContent.trim()") == "Load more" and not page.evaluate("document.getElementById('load-more').hidden"):
        labels.add("Load more")
        page.click("#load-more")
        page.wait_for_function(WAIT_STATE_JS, arg={}, timeout=WAIT_MS)
    lm = page.evaluate("(() => { const b = document.getElementById('load-more'); return { hidden: b.hidden, text: b.textContent.trim(), disabled: b.disabled }; })()")
    check("C17: #load-more reads 'Load older items' when the recent items are exhausted and an archive exists, never disabled at rest", lm["text"] == "Load older items" and not lm["hidden"] and not lm["disabled"], str(lm))
    page.evaluate("document.getElementById('load-more').click()")
    disabled_sync = page.evaluate("document.getElementById('load-more').disabled")
    page.wait_for_function("() => document.getElementById('load-more').disabled === false && document.querySelector('#results').getAttribute('aria-busy') === 'false'", timeout=WAIT_MS)
    check("C17: clicking 'Load older items' disables the button synchronously and re-enables it after archive.json", disabled_sync is True and page.evaluate("document.getElementById('load-more').disabled") is False)
    errors.check("live data")
    ctx.close()
    # C18: the sources page polls the same way and renders rows only after stats settled
    sctx = new_ctx(browser, viewport=DESKTOP)
    spage = sctx.new_page()
    sserved = Served(sctx, data)
    spage.add_init_script("""
      new MutationObserver(() => {
        if (document.querySelector('#sources-table tbody tr:not(.skeleton)') && !window.__rowsAt) { window.__rowsAt = document.getElementById('last-refreshed').textContent; }
      }).observe(document, { childList: true, subtree: true });
    """)
    spage.clock.install()
    goto_sources(spage)
    check("C18: sources.html requests stats.json once at load", sserved.counts["stats"] == 1, "%d" % sserved.counts["stats"])
    spage.clock.fast_forward(300_000)
    spage.wait_for_timeout(300)
    check("C18: exactly one more stats.json request after 300 s", sserved.counts["stats"] == 2, "%d" % sserved.counts["stats"])
    spage.clock.fast_forward(60_000)
    spage.wait_for_timeout(300)
    check("C18: none after a further 60 s", sserved.counts["stats"] == 2, "%d" % sserved.counts["stats"])
    rows_at = spage.evaluate("window.__rowsAt")
    check("C18: #last-refreshed was final when the first table row appeared", rows_at is not None and rows_at.startswith("Last refreshed") and "loading" not in rows_at, repr(rows_at))
    sctx.close()


def run_sort_view(browser):
    """AC 15 (list/grid persisted, hidden on phones) + C5 (#sort wrapper + chevron)."""
    for width in (768, 1280):
        ctx = new_ctx(browser, viewport={"width": width, "height": 1024 if width == 768 else 900})
        page = ctx.new_page()
        goto_home(page)
        c5 = page.evaluate("(() => { const s = document.getElementById('sort'); const w = s.closest('.select'); const use = w ? w.querySelector('svg use') : null; return { wrap: !!w, appearance: getComputedStyle(s).appearance, chevron: use ? use.getAttribute('href') : null }; })()")
        check("C5 %dpx: #sort sits in a div.select wrapper with appearance:none and the chevron-down icon" % width, c5["wrap"] and c5["appearance"] == "none" and (c5["chevron"] or "").endswith("#chevron-down"), str(c5))
        page.click("#view-list")
        page.wait_for_function("() => document.getElementById('results').classList.contains('view-list')", timeout=WAIT_MS)
        rows = page.evaluate("(() => { const cards = [...document.querySelectorAll('#results article.card')]; return { n: cards.length, rows: cards.filter((c) => c.classList.contains('card-row')).length, cols: new Set(cards.map((c) => Math.round(c.offsetLeft))).size, ellipsis: [...document.querySelectorAll('.meta-line')].every((m) => { const cs = getComputedStyle(m); return cs.textOverflow === 'ellipsis' && cs.overflowX === 'hidden' && cs.whiteSpace === 'nowrap' && m.clientWidth <= m.parentElement.clientWidth && m.title === m.textContent; }), selectors: cards.every((a) => a.querySelector('h2 a') && a.querySelector('.badge-source') && a.querySelector('.badge:not(.badge-source):not(.badge-region):not(.badge-sector)') && a.querySelector('.badge-region') && a.querySelector('time[datetime]')), stored: localStorage.getItem('sr:view') }; })()")
        # the meta line now ends with the sector badges (FEAT-002), so it may legitimately be longer than its box: the contract is the
        # CSS ellipsis (nowrap + hidden + ellipsis), no layout overflow, and the full line in `title`
        check("AC 15 %dpx: list view = single column of article.card.card-row, ellipsised meta line (full text in title), snapshot selectors intact, sr:view=list" % width, rows["n"] >= 1 and rows["rows"] == rows["n"] and rows["cols"] == 1 and rows["ellipsis"] and rows["selectors"] and rows["stored"] == "list", str(rows))
        page.reload(wait_until="domcontentloaded")
        wait_cards(page)
        check("AC 15 %dpx: the list choice survives a reload" % width, page.evaluate("document.getElementById('results').classList.contains('view-list')") and page.evaluate("document.getElementById('view-list').getAttribute('aria-pressed')") == "true")
        page.click("#view-grid")
        page.wait_for_function("() => !document.getElementById('results').classList.contains('view-list')", timeout=WAIT_MS)
        ctx.close()
    mctx = new_ctx(browser, viewport=MOBILE, mobile=True)
    mpage = mctx.new_page()
    mpage.add_init_script("try { localStorage.setItem('sr:view', 'list'); } catch (e) {}")
    goto_home(mpage)
    m = mpage.evaluate("(() => ({ toggleVisible: document.getElementById('view-list').getBoundingClientRect().width > 0, listClass: document.getElementById('results').classList.contains('view-list'), rows: document.querySelectorAll('#results .card-row').length, stored: localStorage.getItem('sr:view') }))()")
    check("AC 15 390px: the toggle is hidden and the grid card renders although sr:view=list is stored (never rewritten)", not m["toggleVisible"] and not m["listClass"] and m["rows"] == 0 and m["stored"] == "list", str(m))
    mctx.close()


def run_states(browser):
    """AC 18-19: skeletons while loading, empty state, load error + Retry, stats failure tiles, sheet apply label (C17)."""
    data = Data(browser.new_context().request)
    ctx = new_ctx(browser, viewport=DESKTOP)
    page = ctx.new_page()
    errors = ErrorLog(page)
    served = Served(ctx, data)
    served.hold.add("items")  # park items.json so the loading state is observable
    page.goto(BASE + "/", wait_until="domcontentloaded")
    page.wait_for_function("() => document.fonts.status === 'loaded'", timeout=WAIT_MS)
    sk = page.evaluate("(() => ({ busy: document.getElementById('results').getAttribute('aria-busy'), skeletons: [...document.querySelectorAll('#results .card.skeleton')].filter((s) => s.getBoundingClientRect().height > 0).length, count: document.getElementById('result-count').textContent, pulsing: document.getAnimations().some((a) => a.effect.target.closest && a.effect.target.closest('.skeleton')) }))()")
    check("AC 18: six skeleton cards visible while #results[aria-busy=true] and the count reads Loading", sk["busy"] == "true" and sk["skeletons"] == 6 and sk["count"].startswith("Loading") and sk["pulsing"], str(sk))
    served.hold.discard("items")
    served.release()
    wait_cards(page)
    check("AC 18: skeletons replaced by the first render", page.evaluate("document.querySelectorAll('#results .skeleton').length") == 0)
    page.fill("#q", "zqxjkvwpyq")
    wait_state(page, {"q": "zqxjkvwpyq"})
    check("AC 18: empty state with #empty-reset", page.evaluate("!!document.querySelector('#results div.empty') && !!document.getElementById('empty-reset')") and page.evaluate("document.getElementById('result-count').textContent") == "No items match these filters.")
    page.click("#empty-reset")
    wait_state(page, {"q": ABSENT})
    # items.json -> 500
    ctx.unroute("**/data/items.json")
    ctx.route("**/data/items.json", lambda route: route.fulfill(status=500, content_type="application/json", body=json.dumps({"error": "boom"})))
    ctx.unroute("**/data/stats.json")
    ctx.route("**/data/stats.json", lambda route: route.fulfill(status=500, content_type="application/json", body=json.dumps({"error": "boom"})))
    page.reload(wait_until="domcontentloaded")
    page.wait_for_selector("#results div.alert[role=alert]", timeout=WAIT_MS)
    al = page.evaluate("(() => { const a = document.querySelector('#results .alert'); const b = document.getElementById('retry-items'); const bg = getComputedStyle(b).backgroundColor; const fill = getComputedStyle(document.documentElement).getPropertyValue('--accent-fill').trim(); const n = (h) => { const x = parseInt(h.slice(1), 16); return 'rgb(' + (x >> 16) + ', ' + ((x >> 8) & 255) + ', ' + (x & 255) + ')'; }; return { text: a.textContent, retry: !!b, bg, fill: n(fill), tiles: [...document.querySelectorAll('.stat-n')].map((t) => t.textContent), labels: [...document.querySelectorAll('.stat-l')].map((t) => t.textContent), status: document.getElementById('last-refreshed').textContent }; })()")
    check("AC 18: items.json 500 -> div.alert 'Could not load items:' with a btn-primary #retry-items (--accent-fill)", al["text"].startswith("Could not load items:") and al["retry"] and al["bg"] == al["fill"], "%s | %s vs %s" % (al["text"][:60], al["bg"], al["fill"]))
    check("AC 19: stats.json 500 -> the three stats tiles read an em dash with ' - unavailable', status 'Last refreshed: unknown'", al["tiles"][:3] == ["\u2014"] * 3 and all(l.endswith("\u00b7 unavailable") for l in al["labels"][:3]) and al["status"] == "Last refreshed: unknown", "%s %s %s" % (al["tiles"], al["labels"], al["status"]))
    ctx.unroute("**/data/items.json")
    ctx.route("**/data/items.json", lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(data.items)))
    page.click("#retry-items")
    wait_cards(page)
    check("AC 18: Retry recovers once items.json answers again", snapshot(page)["shown"] >= 1 and page.evaluate("document.querySelectorAll('#results .alert').length") == 0)
    # The browser itself logs "Failed to load resource ... 500" for the routed failures; the app must not add console.error.
    app_errors = [e for e in errors.errors if "Failed to load resource" not in e]
    check("states: no page errors and no app console.error (browser resource-failure lines for the routed 500s excluded)", len(app_errors) == 0, "; ".join(app_errors)[:300] or "%d browser resource-failure lines ignored" % len(errors.errors))
    ctx.close()
    # C17 on the phone sheet: apply label
    mctx = new_ctx(browser, viewport=MOBILE, mobile=True)
    mpage = mctx.new_page()
    goto_home(mpage)
    open_sheet(mpage)
    label = mpage.evaluate("document.getElementById('filters-apply').textContent")
    check("C17 390px: #filters-apply reads 'Show N items'", re.match(r"^Show \d+ items$", label) is not None, label)
    mpage.evaluate("(() => { const q = document.getElementById('q'); q.value = 'zqxjkvwpyq'; q.dispatchEvent(new Event('input', { bubbles: true })); })()")
    mpage.wait_for_function("() => document.getElementById('filters-apply').textContent === 'No items match'", timeout=WAIT_MS)
    check("C17 390px: #filters-apply reads 'No items match' when N = 0", True)
    mpage.click("#filters-apply")
    check("C17 390px: pressing Apply closes the sheet and returns focus to #filters-open", mpage.evaluate("document.getElementById('filter-panel').hidden") and active(mpage) == "filters-open", active(mpage))
    mctx.close()


def run_theme(browser):
    """AC 11: dark default, light from the OS, toggle persisted, applied before the stylesheet on reload."""
    for scheme, expect in (("dark", "dark"), ("light", "light"), ("no-preference", "dark")):
        ctx = new_ctx(browser, viewport=DESKTOP, scheme=scheme)
        page = ctx.new_page()
        goto_home(page)
        check("AC 11: color_scheme=%s with no stored preference -> html[data-theme=%s], theme-color meta matches" % (scheme, expect), page.evaluate("document.documentElement.dataset.theme") == expect and page.evaluate("document.querySelector('meta[name=theme-color]').content") == ("#F4F6FA" if expect == "light" else "#0B0F17"))
        ctx.close()
    ctx = new_ctx(browser, viewport=DESKTOP, scheme="dark")
    page = ctx.new_page()
    page.add_init_script("""
      window.__themeAtFirstStyle = null;
      new MutationObserver(() => {
        if (window.__themeAtFirstStyle === null && document.querySelector('link[rel=stylesheet]')) window.__themeAtFirstStyle = document.documentElement.dataset.theme || 'unset';
      }).observe(document, { childList: true, subtree: true, attributes: true });
    """)
    goto_home(page)
    label_before = page.evaluate("document.getElementById('theme-toggle').getAttribute('aria-label')")
    page.click("#theme-toggle")
    t = page.evaluate("(() => ({ theme: document.documentElement.dataset.theme, stored: localStorage.getItem('sr:theme'), label: document.getElementById('theme-toggle').getAttribute('aria-label'), icon: document.querySelector('#theme-toggle use').getAttribute('href'), meta: document.querySelector('meta[name=theme-color]').content }))()")
    check("AC 11: #theme-toggle flips to light, persists sr:theme, swaps icon + aria-label", t["theme"] == "light" and t["stored"] == "light" and t["label"] != label_before and t["icon"].endswith("#moon") and t["meta"] == "#F4F6FA", str(t))
    page.reload(wait_until="domcontentloaded")
    wait_cards(page)
    check("AC 11: the stored theme is applied before the stylesheet on reload (no flash) and survives", page.evaluate("document.documentElement.dataset.theme") == "light" and page.evaluate("window.__themeAtFirstStyle") == "light", "theme at first stylesheet: %s" % page.evaluate("window.__themeAtFirstStyle"))
    page.click("#theme-toggle")
    check("AC 11: toggling back stores dark", page.evaluate("localStorage.getItem('sr:theme')") == "dark")
    ctx.close()


def run_fonts(browser):
    """AC 12: both Geist families load from ./fonts/, nothing from a third-party origin."""
    ctx = new_ctx(browser, viewport=DESKTOP)
    page = ctx.new_page()
    reqs = RequestLog(page)
    for path, label in (("/", "home"), ("/sources.html", "sources")):
        if path == "/":
            goto_home(page)
        else:
            goto_sources(page)
        f = page.evaluate("""async () => {
          await document.fonts.load('16px "Geist Variable"'); await document.fonts.load('13px "Geist Mono Variable"'); await document.fonts.ready;
          const faces = [...document.fonts].filter((f) => f.family.replace(/"/g, '').startsWith('Geist')).map((f) => f.family.replace(/"/g, '') + ':' + f.status);
          return { status: document.fonts.status, faces };
        }""")
        fonts_req = [u for u in reqs.all if "/fonts/" in u and u.endswith(".woff2")]
        third = [u for u in reqs.all if not u.startswith(ORIGIN)]
        check("AC 12 %s: document.fonts loaded, a loaded FontFace per Geist family, both woff2 requested, no third-party request" % label,
              f["status"] == "loaded" and "Geist Variable:loaded" in f["faces"] and "Geist Mono Variable:loaded" in f["faces"] and any("geist-latin" in u for u in fonts_req) and any("geist-mono-latin" in u for u in fonts_req) and not third,
              "%s; %d font requests; third-party %s" % (f["faces"], len(fonts_req), third[:2]))
    ctx.close()


def run_reduced_motion(browser):
    """AC 8 + 13: with prefers-reduced-motion no animation runs; sweeps are paused, not removed; count-ups are instant."""
    ctx = new_ctx(browser, viewport=DESKTOP, reduced_motion="reduce")
    page = ctx.new_page()
    running = lambda: page.evaluate("document.getAnimations().filter((a) => a.playState === 'running').length")
    goto_home(page)
    settle(page)
    data = Data(ctx.request)
    check("AC 8: no running animation after load under reduced motion; count-ups show the final values at once", running() == 0 and page.evaluate("document.querySelector('#stat-feed .stat-n').textContent") == data.feed_tile, "%d running" % running())
    sweep = page.evaluate("(() => { const s = getComputedStyle(document.querySelector('.radar-mark .radar-sweep')); const p = getComputedStyle(document.querySelector('.radar-stage .radar-sweep')); return [s.animationName, s.animationPlayState, p.animationName, p.animationPlayState]; })()")
    check("AC 13: the sweeps keep their keyframes but are paused", sweep[0] == "sweep" and sweep[1] == "paused" and sweep[2] == "sweep" and sweep[3] == "paused", str(sweep))
    page.select_option("#kind", "funding")
    wait_state(page, {"kind": "funding"})
    check("AC 8: no running animation after a filter change", running() == 0, "%d" % running())
    page.click("#results article h2 a")
    page.wait_for_selector("dialog#detail[open]", timeout=WAIT_MS)
    check("AC 8: no running animation with the drawer open", running() == 0, "%d" % running())
    page.keyboard.press("Escape")
    page.wait_for_function("() => !document.querySelector('dialog#detail').open", timeout=WAIT_MS)
    check("AC 8: no running animation after closing the drawer", running() == 0, "%d" % running())
    page.evaluate("document.getElementById('new-items').hidden = false")
    check("AC 8: no running animation when the pill appears", running() == 0, "%d" % running())
    ctx.close()
    ctx2 = new_ctx(browser, viewport=DESKTOP)
    page2 = ctx2.new_page()
    goto_home(page2)
    sweep = page2.evaluate("(() => [getComputedStyle(document.querySelector('.radar-mark .radar-sweep')).animationPlayState, getComputedStyle(document.querySelector('.radar-stage .radar-sweep')).animationPlayState])()")
    check("AC 13: without reduced motion both sweeps run", sweep == ["running", "running"], str(sweep))
    cross = page2.evaluate("(() => { const c = document.querySelector('.radar-cross'); return [getComputedStyle(c).backgroundImage, getComputedStyle(c, '::before').borderTopWidth, getComputedStyle(c, '::after').borderLeftWidth]; })()")
    check("AC 13: crosshairs are pseudo-element borders, no background image", cross[0] == "none" and cross[1] == "1px" and cross[2] == "1px", str(cross))
    ctx2.close()


RADAR_JS = r"""
() => {
  const px = (v) => parseFloat(v) || 0;
  const svg = document.querySelector('svg.radar');
  const plates = [];
  for (const t of svg.querySelectorAll('text')) {
    const p = t.previousElementSibling;
    const bb = t.getBBox();
    const ok = !!p && p.matches('rect.radar-plate');
    const x = ok ? +p.getAttribute('x') : NaN, y = ok ? +p.getAttribute('y') : NaN, w = ok ? +p.getAttribute('width') : NaN, h = ok ? +p.getAttribute('height') : NaN;
    plates.push({ text: t.textContent, ok, caption: t.classList.contains('radar-caption'), x, y, w, h, contains: ok && x <= bb.x + 0.5 && y <= bb.y + 0.5 && x + w >= bb.x + bb.width - 0.5 && y + h >= bb.y + bb.height - 0.5, inside: ok && x >= 0 && y >= 0 && x + w <= 360 && y + h <= 360, fill: ok ? getComputedStyle(p).fill : null });
  }
  const bg1 = getComputedStyle(document.documentElement).getPropertyValue('--bg-1').trim();
  const outside = [...svg.querySelectorAll('*')].filter((el) => el.getBBox && (() => { const b = el.getBBox(); return b.width > 0 && (b.x < -0.01 || b.y < -0.01 || b.x + b.width > 360.01 || b.y + b.height > 360.01); })()).map((el) => el.tagName + ':' + (el.textContent || el.getAttribute('class')));
  const blips = [...svg.querySelectorAll('circle.blip')].map((c) => ({ key: c.dataset.key, cx: +c.getAttribute('cx'), cy: +c.getAttribute('cy'), r: +c.getAttribute('r'), fresh: c.classList.contains('is-fresh'), open: c.classList.contains('is-open'), fill: c.getAttribute('fill'), fillOpacity: +c.getAttribute('fill-opacity'), computedOpacity: +getComputedStyle(c).fillOpacity, strokeWidth: +c.getAttribute('stroke-width') }));
  let trough = null;
  for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { if (rule.type === CSSRule.KEYFRAMES_RULE && rule.name === 'pulse') { for (const k of rule.cssRules) { const o = parseFloat(k.style.opacity); if (!Number.isNaN(o)) trough = trough === null ? o : Math.min(trough, o); } } } } catch (e) {} }
  const textLayer = svg.querySelector('g.radar-text');
  const textAboveBlips = !!textLayer && textLayer.compareDocumentPosition(svg.querySelector('g.blips')) === Node.DOCUMENT_POSITION_PRECEDING && getComputedStyle(textLayer).pointerEvents === 'none';
  return { display: getComputedStyle(document.getElementById('radar-panel')).display, plates, bg1, outside, blips, trough, textAboveBlips, title: document.getElementById('radar-title').textContent, transform: getComputedStyle(document.getElementById('radar-title')).textTransform };
}
"""


def blip_caption_hits(r, pad=0.0):
    """Blips whose visible disc (cx, cy, r) intersects a ring-caption plate; `pad` widens the disc."""
    hits = []
    for b in r["blips"]:
        for p in r["plates"]:
            if not p["caption"]:
                continue
            nx = max(p["x"], min(b["cx"], p["x"] + p["w"]))
            ny = max(p["y"], min(b["cy"], p["y"] + p["h"]))
            if ((b["cx"] - nx) ** 2 + (b["cy"] - ny) ** 2) ** 0.5 < b["r"] + pad:
                hits.append("%s over '%s'" % (b["key"], p["text"]))
    return hits


def blip_angle(b):
    ang = (180 / 3.141592653589793) * __import__("math").atan2(b["cx"] - 180, -(b["cy"] - 180))
    return ang + 360 if ang < 0 else ang


def largest_group_angles(r, by_key):
    """(group, distinct angles rounded to 0.01 deg) for the most populated (kind, region) pair among the drawn blips."""
    groups = {}
    for b in r["blips"]:
        it = by_key.get(b["key"])
        if it:
            groups.setdefault((it["kind"], it["region"]), set()).add(round(blip_angle(b), 2))
    if not groups:
        return None, set()
    group = max(groups, key=lambda g: len(groups[g]))
    return group, groups[group]


def mocked_radar_items(data, spec):
    """Synthetic items.json: for each (kind, region, n) in `spec`, n items evenly spread over the last 48 h."""
    items = []
    now = datetime.now(timezone.utc)
    for kind, region, n in spec:
        for i in range(n):
            base = dict(data.items[0])
            base.update({
                "id": 800000 + len(items), "title": "Mock %s %s %d" % (kind, region, i), "url": "https://mock.test/%s/%s/%d" % (kind, region, i),
                "kind": kind, "region": region, "source": {"id": "hn_show" if kind == "launch" else "mock", "name": "Mock source"},
                "publishedAt": to_iso(now - timedelta(hours=47.5 * i / max(1, n - 1))), "summary": "", "extra": {},
            })
            items.append(base)
    return items


def quadrant_of(kind):
    return KIND_ORDER.index(kind) if kind in KIND_ORDER else 2


# --- radar fan fix: the allocation model of public/radar.js, ported so the drawn blips can be checked against it ----
RADAR_R = 150.0
MIN_SLOT_DEG = 6.0
MAJORITY_DEG = 45.0
SLOT_PAD_DEG = 1.5
LINE_CLEAR = 4.5
CAPTION_CLEAR = 17.0
MIN_SECTOR_DEG = 14.0
RADIAL_JITTER = 2.0
MIN_GAP = 0.5
DENSITY_TIERS = [(20, 3.0, 0.9), (60, 2.5, 0.75), (10 ** 9, 2.0, 0.6)]  # (max bucket size, blip r, fill-opacity)


def sector_span(kind, r=RADAR_R):
    """Same as sectorSpan() in public/radar.js: the quadrant minus the line clearance (caption clearance at 270)."""
    q0 = quadrant_of(kind) * 90
    line = math.degrees(math.asin(min(1.0, LINE_CLEAR / max(r, 1e-9))))
    channel = min(math.degrees(math.asin(min(1.0, CAPTION_CLEAR / max(r, 1e-9)))), 90 - line - MIN_SECTOR_DEG)
    return (q0 + (channel if q0 == 270 else line), q0 + 90 - (channel if q0 + 90 == 270 else line))


def allocate_slots(counts, width, min_deg=MIN_SLOT_DEG):
    """Same as allocateSlots() in public/radar.js: sqrt(count) shares of width, >= min_deg when non-empty, 0 when empty,
    >= MAJORITY_DEG for a bucket holding at least half of the items (as far as the other floors allow), summing to width."""
    out = [0.0] * len(counts)
    free = [i for i, c in enumerate(counts) if c > 0]
    if not free:
        return out
    equal = len(free) * min_deg >= width
    weight = (lambda i: 1.0) if equal else (lambda i: math.sqrt(counts[i]))
    items = sum(counts[i] for i in free)
    top = max(free, key=lambda i: counts[i])
    majority = max(min_deg, min(MAJORITY_DEG, width - (len(free) - 1) * min_deg))
    floor = lambda i: majority if i == top and counts[i] * 2 >= items else min_deg  # noqa: E731
    rest = width
    while not equal:
        total = sum(weight(i) for i in free)
        starved = [i for i in free if weight(i) / total * rest < floor(i)]
        if not starved or len(starved) == len(free):
            break
        for i in starved:
            out[i] = floor(i)
            rest -= floor(i)
        free = [i for i in free if i not in starved]
    total = sum(weight(i) for i in free)
    for i in free:
        out[i] = weight(i) / total * rest
    return out


def slot_spans(kind, counts, r):
    a, z = sector_span(kind, r)
    spans = []
    for w in allocate_slots(counts, z - a):
        spans.append((a, a + w))
        a += w
    return spans


def density_tier(n):
    for max_n, br, op in DENSITY_TIERS:
        if n <= max_n:
            return br, op
    return DENSITY_TIERS[-1][1:]


def bbox_hits(r, blip_r=None):
    """Blips whose bounding box (cx +/- r, cy +/- r; `blip_r` overrides the drawn radius) intersects a ring-caption plate's box."""
    hits = []
    for b in r["blips"]:
        rr = blip_r if blip_r is not None else b["r"]
        for p in r["plates"]:
            if not p["caption"]:
                continue
            if not (b["cx"] + rr <= p["x"] or b["cx"] - rr >= p["x"] + p["w"] or b["cy"] + rr <= p["y"] or b["cy"] - rr >= p["y"] + p["h"]):
                hits.append("%s over '%s'" % (b["key"], p["text"]))
    return hits


def close_pairs(blips, gap=MIN_GAP):
    out = []
    for i in range(len(blips)):
        for j in range(i + 1, len(blips)):
            if math.hypot(blips[i]["cx"] - blips[j]["cx"], blips[i]["cy"] - blips[j]["cy"]) < gap:
                out.append((blips[i]["key"], blips[j]["key"]))
    return out


def fan_checks(label, r, by_key):
    """Radar fan fix (F1-F5) for the drawn blips: sub-wedge allocation, de-stacking, caption boxes, density tiers, pointer target."""
    groups = {}
    for b in r["blips"]:
        it = by_key.get(b["key"])
        if it:
            groups.setdefault((it["kind"] if it["kind"] in KIND_ORDER else "news", it["region"] if it["region"] in REGION_ORDER else "global"), []).append(b)
    widest = None
    outside = []
    tier_bad = []
    target_bad = []
    for kind in KIND_ORDER:
        counts = [len(groups.get((kind, reg), [])) for reg in REGION_ORDER]
        n = sum(counts)
        if not n:
            continue
        a, z = sector_span(kind)
        widths = allocate_slots(counts, z - a)
        i = max(range(len(counts)), key=lambda k: counts[k])
        angles = [blip_angle(b) for b in groups[(kind, REGION_ORDER[i])]]
        row = (kind, REGION_ORDER[i], counts[i], n, widths[i], max(angles) - min(angles))
        if widest is None or row[2] > widest[2]:
            widest = row
        if counts[i] * 2 >= n:
            check("F1 %s: the largest bucket %s/%s holds %d of %d items -> its allocated sub-wedge is >= 45 deg" % (label, kind, REGION_ORDER[i], counts[i], n), widths[i] >= 45, "%.1f deg allocated (sector %.1f deg), blips span %.1f deg" % (widths[i], z - a, row[5]))
        for ri, reg in enumerate(REGION_ORDER):
            exp_r, exp_op = density_tier(counts[ri])
            for b in groups.get((kind, reg), []):
                dist = math.hypot(b["cx"] - 180, b["cy"] - 180)
                s0, s1 = slot_spans(kind, counts, dist)[ri]
                pad = min(SLOT_PAD_DEG, (s1 - s0) / 4)
                ang = blip_angle(b)
                if not (s0 + pad - 0.02 <= ang <= s1 - pad + 0.02):
                    outside.append("%s %s/%s %.2f not in [%.2f, %.2f] at r=%.1f" % (b["key"], kind, reg, ang, s0 + pad, s1 - pad, dist))
                if b["open"]:
                    continue
                if b["r"] != exp_r or abs(b["fillOpacity"] - exp_op) > 1e-9:
                    tier_bad.append("%s %s/%s (%d items) r=%s opacity=%s expected %s/%s" % (b["key"], kind, reg, counts[ri], b["r"], b["fillOpacity"], exp_r, exp_op))
                if abs(b["r"] + b["strokeWidth"] / 2 - 8) > 1e-9:
                    target_bad.append("%s r=%s stroke=%s" % (b["key"], b["r"], b["strokeWidth"]))
    check("F1 %s: every blip sits inside its region's padded sub-wedge as allocated from the drawn bucket sizes (sqrt weights, 6 deg floor, 45 deg majority floor, 1.5 deg padding) at its own radius" % label, not outside, "%d blips, %d groups, widest bucket (kind, region, items, sector items, allocated deg, blip span deg) %s; outside %s" % (len(r["blips"]), len(groups), widest and (widest[0], widest[1], widest[2], widest[3], round(widest[4], 2), round(widest[5], 2)), outside[:3]))
    pairs = close_pairs(r["blips"])
    check("F2 %s: no two blips share a centre to within 0.5 px" % label, not pairs, "%d blips, %d close pairs %s" % (len(r["blips"]), len(pairs), pairs[:3]))
    hits = bbox_hits(r) + bbox_hits(r, 5.5)
    check("F3 %s: no blip bounding box (drawn r, and the open-blip r = 5.5) intersects a ring-caption bounding box" % label, not hits, "%d blips, %d caption plates, hits %s" % (len(r["blips"]), sum(1 for p in r["plates"] if p["caption"]), hits[:3]))
    check("F4 %s: blip radius / fill-opacity follow the bucket size (<= 20: 3 px 0.9; <= 60: 2.5 px 0.75; > 60: 2 px 0.6)" % label, not tier_bad, "%s; bad %s" % (sorted(set((g, len(bs), density_tier(len(bs))) for g, bs in groups.items()), key=lambda t: -t[1])[:4], tier_bad[:3]))
    check("F5 %s: the transparent stroke keeps a 16 px pointer target (r + stroke / 2 = 8)" % label, not target_bad, "bad %s" % target_bad[:3])
    return widest


def run_radar(browser):
    """AC 20 + R2 (plates survive a hidden-panel load) + C19 (plates inside the viewBox)."""
    data = Data(browser.new_context().request)
    ctx = new_ctx(browser, viewport=MOBILE)  # desktop context (fine pointer) at a phone width: the panel is hidden
    page = ctx.new_page()
    errors = ErrorLog(page)
    goto_home(page)
    r0 = page.evaluate("getComputedStyle(document.getElementById('radar-panel')).display")
    check("R2: #radar-panel is display:none at 390px", r0 == "none", r0)
    page.set_viewport_size(DESKTOP)
    page.wait_for_function("() => getComputedStyle(document.getElementById('radar-panel')).display !== 'none' && document.querySelectorAll('circle.blip').length > 0", timeout=WAIT_MS)
    page.wait_for_timeout(300)
    r = page.evaluate(RADAR_JS)
    plate_ok = all(p["ok"] and p["contains"] and p["inside"] for p in r["plates"]) and len(r["plates"]) == 7
    check("R2: after growing 390 -> 1280 every svg.radar text sits on a plate that contains its bbox, inside 0-360", plate_ok and not r["outside"], "%d plates; outside %s; %s" % (len(r["plates"]), r["outside"][:3], [(p["text"], p["contains"], p["inside"]) for p in r["plates"] if not (p["contains"] and p["inside"])]))
    ctx.close()
    ctx = new_ctx(browser, viewport=DESKTOP)
    page = ctx.new_page()
    errors = ErrorLog(page)
    goto_home(page)
    page.wait_for_function("() => document.querySelectorAll('circle.blip').length > 0", timeout=WAIT_MS)
    r = page.evaluate(RADAR_JS)
    now = datetime.now(timezone.utc)
    n48 = data.within_48h(now)
    bad_geo = []
    ages = []
    for b in r["blips"]:
        it = data.by_key.get(b["key"])
        if not it:
            bad_geo.append("unknown key " + b["key"])
            continue
        dx, dy = b["cx"] - 180, b["cy"] - 180
        dist = (dx * dx + dy * dy) ** 0.5
        ang = (180 / 3.141592653589793) * __import__("math").atan2(dx, -dy)
        if ang < 0:
            ang += 360
        q = int(ang // 90)
        if not (14.9 <= dist <= 150.1):
            bad_geo.append("%s dist %.1f" % (b["key"], dist))
        if q != quadrant_of(it["kind"]) and abs(ang - (quadrant_of(it["kind"]) * 90 + 45)) > 48:
            bad_geo.append("%s quadrant %d for %s" % (b["key"], q, it["kind"]))
        try:
            ages.append(((now - parse_iso(it["publishedAt"])).total_seconds() / 3600, dist))
        except Exception:
            pass
    ages.sort()
    # radius = age radius +/- RADIAL_JITTER (hash), so neighbours in age may swap by up to 2 x 2 px
    monotonic = all(ages[i][1] <= ages[i + 1][1] + 0.6 + 2 * RADIAL_JITTER for i in range(len(ages) - 1))
    m = re.search(r"(\d+) items?", r["title"], re.I)
    check("AC 20 1280px: one blip per item within 48 h (<= 400), radii 15-150, quadrant by kind, radius monotonic with age (within the 2 px jitter)", len(r["blips"]) == min(n48, 400) and not bad_geo and monotonic, "%d blips vs %d within 48 h; %s" % (len(r["blips"]), n48, bad_geo[:3]))
    check("AC 20: #radar-title counts the 48 h items (text-transform uppercase, DOM text sentence case)", m is not None and abs(int(m.group(1)) - n48) <= 2 and r["transform"] == "uppercase" and r["title"].startswith("Last 48 h"), r["title"])
    plates_contain = all(p["ok"] and p["contains"] and p["inside"] and p["fill"] for p in r["plates"])
    fill_ok = all(p["fill"].replace(" ", "") == page.evaluate("(() => { const c = document.createElement('div'); c.style.color = getComputedStyle(document.documentElement).getPropertyValue('--bg-1').trim(); document.body.append(c); const v = getComputedStyle(c).color; c.remove(); return v; })()").replace(" ", "") for p in r["plates"])
    check("AC 20/C19: every svg.radar text is preceded by rect.radar-plate (fill --bg-1) containing its bbox; nothing outside the viewBox", plates_contain and fill_ok and not r["outside"], "%d plates, fill %s, outside %s" % (len(r["plates"]), r["plates"][0]["fill"] if r["plates"] else None, r["outside"][:3]))
    check("AC 20: fresh-blip pulse trough is 0.75", r["trough"] == 0.75, str(r["trough"]))
    # polish pass: blips of one (kind, region) fan out inside their sub-wedge; the ring captions sit on a reserved ray
    group, angles = largest_group_angles(r, data.by_key)
    check("P1: the largest (kind, region) group spreads over >= 5 distinct angles", group is not None and len(angles) >= 5, "%s: %d blips, %d distinct angles (%.1f-%.1f deg)" % (group, sum(1 for b in r["blips"] if (data.by_key.get(b["key"], {}).get("kind"), data.by_key.get(b["key"], {}).get("region")) == group), len(angles), min(angles) if angles else 0, max(angles) if angles else 0))
    hits = blip_caption_hits(r)
    check("P2: real data - no blip disc intersects a ring-caption plate; text layer above the blips with pointer-events none", not hits and r["textAboveBlips"], "%d blips, %d caption plates, hits %s" % (len(r["blips"]), sum(1 for p in r["plates"] if p["caption"]), hits[:3]))
    fan_checks("real data", r, data.by_key)
    for name, spec in (("150 global launches", [("launch", "global", 150)]), ("200 news/global + 200 accelerator/usa next to the caption ray", [("news", "global", 200), ("accelerator", "usa", 200)])):
        mctx = new_ctx(browser, viewport=DESKTOP)
        mocked = mocked_radar_items(data, spec)
        mocked_body = json.dumps(mocked)
        mctx.route("**/data/items.json", lambda route: route.fulfill(status=200, content_type="application/json", headers={"Cache-Control": "no-store"}, body=mocked_body))
        mpage = mctx.new_page()
        merrors = ErrorLog(mpage)
        goto_home(mpage)
        mpage.wait_for_function("(n) => document.querySelectorAll('circle.blip').length === n", arg=min(len(mocked), 400), timeout=WAIT_MS)
        mpage.wait_for_timeout(300)
        mr = mpage.evaluate(RADAR_JS)
        mhits = blip_caption_hits(mr, pad=2.0)
        mby = {item_key(it["url"]): it for it in mocked}
        mgroup, mangles = largest_group_angles(mr, mby)
        mq = [b for b in mr["blips"] if int(blip_angle(b) // 90) != quadrant_of(mby[b["key"]]["kind"])]
        check("P2 mocked (%s): %d blips, none within 2 px of a caption plate, all in their kind's quadrant, >= 5 angles" % (name, len(mr["blips"])), len(mr["blips"]) == min(len(mocked), 400) and not mhits and not mq and len(mangles) >= 5,
              "hits %s; wrong quadrant %d; %s has %d distinct angles" % (mhits[:3], len(mq), mgroup, len(mangles)))
        fan_checks("mocked %s" % name, mr, mby)
        empty = [q for q in range(4) if not any(k == KIND_ORDER[q] for k, _, _ in spec)]
        per_q = [sum(1 for b in mr["blips"] if int(blip_angle(b) // 90) == q) for q in range(4)]
        mtitle = re.search(r"(\d+) items?", mr["title"], re.I)
        check("F6 mocked (%s): the radar renders with %d empty sector(s) - %d blips, none in the empty quadrants, honest title" % (name, len(empty), min(len(mocked), 400)), len(mr["blips"]) == min(len(mocked), 400) and all(per_q[q] == 0 for q in empty) and mtitle is not None and int(mtitle.group(1)) == len(mocked), "blips per quadrant %s, empty %s, title %r" % (per_q, [KIND_ORDER[q] for q in empty], mr["title"]))
        merrors.check("radar mocked (%s)" % name)
        mctx.close()
    page.keyboard.press("t")
    page.wait_for_timeout(200)
    r2 = page.evaluate(RADAR_JS)
    check("R2: plates survive the theme toggle (still contain their text, fill follows --bg-1)", all(p["contains"] and p["inside"] for p in r2["plates"]) and r2["plates"][0]["fill"] != r["plates"][0]["fill"], "%s -> %s" % (r["plates"][0]["fill"], r2["plates"][0]["fill"]))
    page.keyboard.press("t")
    # hover + click + focus return (blips overlap: the target is whatever blip is topmost at the pointer)
    blip = r["blips"][0]
    box = page.evaluate("document.querySelector('svg.radar').getBoundingClientRect().toJSON()")
    scale = box["width"] / 360
    x, y = box["x"] + blip["cx"] * scale, box["y"] + blip["cy"] * scale
    hit_key = page.evaluate("([x, y]) => { const el = document.elementFromPoint(x, y); return el && el.classList.contains('blip') ? el.dataset.key : null; }", [x, y])
    page.mouse.move(x, y)
    page.wait_for_function("() => !document.querySelector('.radar-tip').hidden", timeout=WAIT_MS)
    tip = page.evaluate("(() => { const t = document.querySelector('.radar-tip'); const bg2 = getComputedStyle(document.documentElement).getPropertyValue('--bg-2').trim(); const c = document.createElement('div'); c.style.color = bg2; document.body.append(c); const v = getComputedStyle(c).color; c.remove(); return { bg: getComputedStyle(t).backgroundColor, bg2: v, title: t.querySelector('.tip-title').textContent, role: t.getAttribute('role') }; })()")
    check("AC 20: hovering a blip shows .radar-tip on --bg-2 with that item's title", hit_key in data.by_key and tip["bg"] == tip["bg2"] and tip["title"] == data.by_key[hit_key]["title"] and tip["role"] == "tooltip", "%s | %s" % (tip["title"][:50], data.by_key.get(hit_key, {}).get("title", "?")[:50]))
    # radar fan fix: a hovered blip is drawn at full opacity (the region colour's design.md contrast), whatever its bucket's resting opacity
    hov = page.evaluate("(k) => { const c = document.querySelector('circle.blip[data-key=\"' + k + '\"]'); return c ? { hover: c.matches(':hover'), rest: c.getAttribute('fill-opacity'), computed: getComputedStyle(c).fillOpacity } : null; }", hit_key)
    check("F4: the hovered blip's computed fill-opacity is 1 (styles.css circle.blip:hover) while its resting attribute is the bucket's", hov is not None and hov["hover"] and hov["computed"] == "1" and hov["rest"] in ("0.9", "0.75", "0.6"), str(hov))
    page.mouse.click(x, y)
    page.wait_for_selector("dialog#detail[open]", timeout=WAIT_MS)
    check("AC 20: clicking a blip opens the drawer for that item (open blip highlighted r=5)", page.evaluate("new URLSearchParams(location.search).get('item')") == hit_key and page.evaluate("document.querySelector('circle.blip.is-open').getAttribute('r')") == "5", "%s vs %s" % (page.evaluate("new URLSearchParams(location.search).get('item')"), hit_key))
    page.keyboard.press("Escape")
    page.wait_for_function("() => !document.querySelector('dialog#detail').open", timeout=WAIT_MS)
    page.wait_for_timeout(300)
    check("AC 20: after Esc focus returns to #radar-panel (returnTo = radar)", active(page) == "radar-panel", active(page))
    errors.check("radar")
    ctx.close()


def run_sources_layout(browser):
    """AC 21: table semantics at 1280, stacked cards with td::before labels at 390, values equal sources.json."""
    data = Data(browser.new_context().request)
    by_name = {s["name"]: s for s in data.sources["sources"]}
    ctx = new_ctx(browser, viewport=DESKTOP)
    page = ctx.new_page()
    goto_sources(page)
    t = page.evaluate("(() => ({ role: document.getElementById('sources-table').getAttribute('role'), rowheaders: document.querySelectorAll('#sources-table tbody th[role=rowheader]').length, rows: document.querySelectorAll('#sources-table tbody tr').length, strip: document.querySelectorAll('ul.status-strip li').length, status: document.getElementById('status').textContent, explore: [...document.querySelectorAll('#explore-list li a')].every((a) => a.target === '_blank' && a.rel === 'noopener noreferrer'), caption: document.querySelector('#sources-table caption').textContent }))()")
    check("AC 21 1280px: role=table with a rowheader per row, caption, 3 status tiles, status text, explore links rel", t["role"] == "table" and t["rowheaders"] == t["rows"] == len(data.sources["sources"]) and t["strip"] == 3 and re.match(r"^\d+ configured, \d+ enabled\.$", t["status"]) and t["explore"] and t["caption"] == "Configured sources", str(t))
    ctx.close()
    mctx = new_ctx(browser, viewport=MOBILE, mobile=True)
    mpage = mctx.new_page()
    goto_sources(mpage)
    m = mpage.evaluate("(() => { const rows = [...document.querySelectorAll('#sources-table tbody tr')]; return rows.map((tr) => ({ name: tr.querySelector('th').textContent.trim(), display: getComputedStyle(tr).display, cells: [...tr.querySelectorAll('td')].map((td) => ({ label: td.dataset.label, before: getComputedStyle(td, '::before').content, text: td.textContent.trim(), display: getComputedStyle(td).display })) })); })()")
    labels_ok = all(r["display"] == "block" and all(c["display"] == "flex" and c["before"] == '"%s"' % c["label"] for c in r["cells"]) for r in m)
    values_ok = all(r["cells"][0]["text"].endswith("Yes") == bool(by_name[r["name"]]["enabled"]) and r["cells"][5]["text"] == str(by_name[r["name"]]["itemCount"]) for r in m if r["name"] in by_name)
    check("AC 21 390px: every row is a stacked card, td::before shows data-label, Enabled/Items textContent equal sources.json", labels_ok and values_ok and len(m) == len(data.sources["sources"]), "%d rows" % len(m))
    mctx.close()


SW_STATE_JS = r"""
async () => {
  const reg = await navigator.serviceWorker.getRegistration();
  const keys = await caches.keys();
  const shell = keys.filter((k) => k.startsWith('sr-shell-'));
  let cached = [];
  if (shell.length) { const c = await caches.open(shell[0]); cached = (await c.keys()).map((r) => r.url); }
  return { scope: reg ? reg.scope : null, controlled: !!navigator.serviceWorker.controller, keys, shell, cached, waiting: !!(reg && reg.waiting) };
}
"""


def run_sw(browser, parity):
    """AC 32-36: registration under the real scope, versioned precache, data navigations untouched, offline shell, update flow."""
    mode = "parity" if parity else "smoke"
    ctx = new_ctx(browser, viewport=DESKTOP, sw=True)
    page = ctx.new_page()
    # both pages declare <link rel="icon">; the /favicon.ico probe (404 on every host) only comes from this
    # scenario's own top-level navigations to ./data/items.json and ./manifest.webmanifest
    errors = ErrorLog(page, ignore_urls=("/favicon.ico",))
    loads = []
    page.on("load", lambda: loads.append(page.url))
    goto_home(page)
    base = snapshot(page)
    page.wait_for_function("() => navigator.serviceWorker.controller !== null", timeout=WAIT_MS)
    page.wait_for_function("async () => (await caches.keys()).some((k) => k.startsWith('sr-shell-'))", timeout=WAIT_MS)
    page.wait_for_function("async () => { const k = (await caches.keys()).find((x) => x.startsWith('sr-shell-')); if (!k) return false; const c = await caches.open(k); return (await c.keys()).length >= %d; }" % len(SHELL), timeout=WAIT_MS)
    s = page.evaluate(SW_STATE_JS)
    scope_path = urlsplit(BASE + "/").path
    version = s["shell"][0][len("sr-shell-"):] if s["shell"] else None
    check("AC 34 %s: registration scope ends with %s, exactly one sr-shell-<v> cache, v != __BUILD_VERSION__" % (mode, scope_path), s["scope"] is not None and s["scope"].endswith(scope_path) and len(s["shell"]) == 1 and version and not version.startswith("__"), "scope %s, caches %s" % (s["scope"], s["keys"]))
    expected_urls = set(BASE + "/" + u[2:] if u != "./" else BASE + "/" for u in SHELL)
    cached = set(s["cached"])
    check("AC 34 %s: every SHELL url is precached" % mode, expected_urls <= cached, "missing %s" % sorted(expected_urls - cached)[:4])
    check("AC 34 %s: the page did not reload after the first install" % mode, len(loads) <= 1, "%d loads" % len(loads))
    sw_text = ctx.request.get(BASE + "/sw.js").text()
    check("AC 33/36 %s: sw.js served with the version, no forbidden literals, no importScripts/Workbox import, cache:'reload' precache" % mode, "__BUILD_VERSION__" not in sw_text and not re.search(r"""['"]/(api|data)/""", sw_text) and "importScripts" not in sw_text and not re.search(r"workbox[-./]", sw_text, re.I) and "cache: 'reload'" in sw_text and ("'%s'" % version) in sw_text, "version %s" % version)
    # top-level navigations to data / manifest are not intercepted
    resp = page.goto(BASE + "/data/items.json", wait_until="domcontentloaded")
    body_is_array = page.evaluate("(() => { try { return Array.isArray(JSON.parse(document.body.textContent)); } catch (e) { return false; } })()")
    check("AC 34 %s: navigating to ./data/items.json returns application/json (an array), not the shell" % mode, resp is not None and "application/json" in (resp.headers.get("content-type") or "") and body_is_array, resp.headers.get("content-type") if resp else None)
    resp = page.goto(BASE + "/manifest.webmanifest", wait_until="domcontentloaded")
    check("AC 34 %s: navigating to ./manifest.webmanifest returns the manifest" % mode, resp is not None and "manifest" in (resp.headers.get("content-type") or "") and '"start_url": "./"' in page.evaluate("document.body.textContent"), resp.headers.get("content-type") if resp else None)
    page.goto(BASE + "/?item=" + base["cards"][0]["key"], wait_until="domcontentloaded")
    page.wait_for_selector("dialog#detail[open]", timeout=WAIT_MS)
    check("AC 34 %s: ?item=<key> opens the drawer under service-worker control" % mode, True)
    page.keyboard.press("Escape")
    page.wait_for_function("() => !document.querySelector('dialog#detail').open", timeout=WAIT_MS)
    if parity:
        api = page.evaluate("async () => { const before = (await (await caches.open('sr-data')).keys()).length; const r = await fetch('./api/stats'); const j = await r.json(); const after = (await (await caches.open('sr-data')).keys()).length; return { ok: r.ok, items: typeof j.items, hdr: r.headers.get('X-Startup-Radar-Cache'), hdr2: r.headers.get('X-Startup-Radar-Cached-At'), before, after }; }")
        check("AC 36 parity: fetch('./api/stats') is not intercepted (no X-Startup-Radar-Cache* headers, sr-data unchanged)", api["ok"] and api["items"] == "number" and api["hdr"] is None and api["hdr2"] is None and api["before"] == api["after"], str(api))
    # offline: the page goes offline through Playwright, the worker's own fetch is made to fail (set_offline does not reach it)
    worker_offline(ctx, True)
    ctx.set_offline(True)
    page.reload(wait_until="domcontentloaded")
    wait_cards(page)
    off = page.evaluate("(() => ({ note: document.getElementById('offline-note').hidden ? null : document.getElementById('offline-note').textContent, toasts: document.querySelectorAll('#toasts .toast').length, cards: document.querySelectorAll('#results article').length }))()")
    check("AC 34 %s: offline reload renders the cached shell + cached data with #offline-note and no toast" % mode, off["cards"] >= 1 and off["note"] is not None and off["note"].startswith("Offline \u2014 showing data cached") and off["toasts"] == 0, str(off))
    page.goto(BASE + "/sources.html", wait_until="domcontentloaded")
    page.wait_for_selector("#sources-table tbody tr:not(.skeleton)", timeout=WAIT_MS)
    check("AC 34 %s: ./sources.html renders offline from the precache" % mode, page.evaluate("document.querySelectorAll('#sources-table tbody tr:not(.skeleton)').length") >= 1)
    ctx.set_offline(False)
    worker_offline(ctx, False)
    page.goto(BASE + "/", wait_until="load")
    wait_cards(page)
    check("AC 34 %s: back online the offline note disappears" % mode, page.evaluate("document.getElementById('offline-note').hidden") is True)
    # notebook survival (FEAT-004, D11): save an item now; it must still be there after the worker update below
    page.evaluate("localStorage.removeItem('%s')" % NOTEBOOK_KEY)
    nb_key = base["cards"][0]["key"]
    page.click('#results article.card[data-key="%s"] button.card-save' % nb_key)
    page.wait_for_function("(k) => { const n = JSON.parse(localStorage.getItem('sr:notebook:v1') || 'null'); return !!(n && n.items[k]); }", arg=nb_key, timeout=WAIT_MS)
    page.evaluate("() => document.querySelectorAll('#toasts .toast-close').forEach((b) => b.click())")  # the 'Saved to notebook' toast must not count below
    page.wait_for_function("() => document.querySelectorAll('#toasts .toast').length === 0", timeout=WAIT_MS)
    # update flow: a new sw.js version must yield the toast; Reload activates it exactly once.
    # Browsers fetch sw.js outside page routing, so the new version is really deployed: on disk in smoke mode
    # (STATIC_ROOT, the cache name changes), or in parity mode by registering the same script under a query string
    # (a new URL is a new version to the browser; Express serves one sw.js version per process, so the cache name
    # cannot change there). In both modes the running worker is marked first, so "a new, unmarked worker instance
    # controls the page and the marked one is gone" proves the activation independently of the cache name.
    new_version = "harness-%d" % int(time.time())
    restore = None
    for w in ctx.service_workers:
        try:
            w.evaluate("() => { self.__harnessOld = true; }")
        except Exception:  # noqa: BLE001
            pass

    def live_workers():
        out = []
        for w in ctx.service_workers:
            try:
                out.append((w.url, w.evaluate("() => self.__harnessOld === true")))
            except Exception:  # noqa: BLE001 - a redundant/stopped worker
                pass
        return out
    if not parity and STATIC_ROOT:
        sw_path = Path(STATIC_ROOT) / "sw.js"
        restore = sw_path.read_text(encoding="utf-8")
        sw_path.write_text(sw_text.replace("'%s'" % version, "'%s'" % new_version), encoding="utf-8")
        trigger = lambda: page.reload(wait_until="domcontentloaded")
        expect_cache = "sr-shell-" + new_version
    else:
        trigger = lambda: page.evaluate("() => navigator.serviceWorker.register('./sw.js?harness=%s', { scope: './' })" % new_version)
        expect_cache = "sr-shell-" + version
    try:
        trigger()
        page.wait_for_selector("#toasts .toast.update", timeout=WAIT_MS)
        txt = page.evaluate("document.querySelector('#toasts .toast.update p').textContent")
        check("AC 35 %s: a new sw.js version yields the persistent 'Update available' toast" % mode, txt == "Update available \u2014 Reload", txt)
        page.click("#toasts .toast.update .toast-close")
        page.wait_for_timeout(500)
        check("AC 35 %s: dismissing does not reload" % mode, page.evaluate("performance.getEntriesByType('navigation').length") == 1 and page.evaluate("document.querySelectorAll('#toasts .toast').length") == 0)
        page.reload(wait_until="domcontentloaded")
        wait_cards(page)
        page.wait_for_selector("#toasts .toast.update", timeout=WAIT_MS)
        check("AC 35 %s: the toast comes back on the next load while the worker is waiting" % mode, page.evaluate("(async () => !!(await navigator.serviceWorker.getRegistration()).waiting)()"))
        with page.expect_navigation(wait_until="domcontentloaded", timeout=WAIT_MS):
            page.click("#toasts .toast.update .toast-action")
        wait_cards(page)
        page.wait_for_function("async () => { const k = await caches.keys(); return k.filter((x) => x.startsWith('sr-shell-')).length === 1 && k.includes('%s'); }" % expect_cache, timeout=WAIT_MS)
        deadline = time.time() + WAIT_MS / 1000
        workers = live_workers()
        while time.time() < deadline and (any(old for _, old in workers) or len(workers) < 1 or (restore is not None and len(workers) != 1)):
            page.wait_for_timeout(250)
            workers = live_workers()
        s2 = page.evaluate(SW_STATE_JS)
        active_url = page.evaluate("async () => (await navigator.serviceWorker.getRegistration()).active.scriptURL")
        controller_url = page.evaluate("() => navigator.serviceWorker.controller ? navigator.serviceWorker.controller.scriptURL : null")
        if restore is not None:
            # a really deployed second version: exactly one new worker, the plain ./sw.js, nothing waiting
            controlled = controller_url is not None and controller_url.endswith("/sw.js")
            workers_ok = len(workers) == 1 and not workers[0][1] and not s2["waiting"]
            how = "cache swapped to " + expect_cache
        else:
            # routed emulation (same version under ./sw.js?harness=): the marked worker must be gone and an unmarked
            # one must control the page; on a remote host the page's own ./sw.js re-registration may be left waiting
            # (a different URL to the browser), which a real version bump never produces (proven with STATIC_ROOT).
            harness_urls = {BASE + "/sw.js", BASE + "/sw.js?" + "harness=" + new_version}
            controlled = controller_url is not None and controller_url in harness_urls
            workers_ok = 1 <= len(workers) <= 2 and not any(old for _, old in workers) and set(u for u, _ in workers) <= harness_urls and (not s2["waiting"] or len(workers) == 2)
            how = "same version " + version + ", a new worker instance took over"
        check("AC 35 %s: Reload activates the new worker exactly once (%s); shell caches: %s" % (mode, how, s2["shell"]), s2["shell"] == [expect_cache] and controlled and workers_ok and page.evaluate("performance.getEntriesByType('navigation').length") == 1, "active %s, running workers %s" % (active_url, workers))
        still = page.evaluate("(k) => { const n = JSON.parse(localStorage.getItem('sr:notebook:v1') || 'null'); return !!(n && n.items[k]); }", nb_key)
        page.goto(BASE + "/notebook.html", wait_until="domcontentloaded")
        page.wait_for_selector("#main[data-ready]", timeout=WAIT_MS)
        listed = page.evaluate("document.querySelectorAll('#nb-items article.nb-item[data-key=\"%s\"]').length" % nb_key)
        check("FEAT-004 %s: the saved item survives the service-worker update (localStorage untouched) and notebook.html lists it under the new worker" % mode, still and listed == 1 and page.evaluate("navigator.serviceWorker.controller !== null"), "stored %s, listed %d" % (still, listed))
        page.evaluate("localStorage.removeItem('%s')" % NOTEBOOK_KEY)
    finally:
        if restore is not None:
            Path(STATIC_ROOT, "sw.js").write_text(restore, encoding="utf-8")
    errors.check("service worker %s" % mode)
    ctx.close()
    # installability (Lighthouse 13 has no PWA category; CDP is the substitute). Incognito-like contexts always report
    # "in-incognito", so this runs in a persistent (non-incognito) profile.
    import tempfile
    with tempfile.TemporaryDirectory() as profile:
        pctx = browser_type_launch_persistent(profile)
        try:
            ppage = pctx.pages[0] if pctx.pages else pctx.new_page()
            ppage.goto(BASE + "/", wait_until="load")
            wait_cards(ppage)
            ppage.wait_for_function("() => navigator.serviceWorker.controller !== null", timeout=WAIT_MS)
            cdp = pctx.new_cdp_session(ppage)
            errs = cdp.send("Page.getInstallabilityErrors").get("installabilityErrors", [])
            print("installabilityErrors (%s, persistent profile): %s" % (mode, json.dumps(errs)))
            check("AC 32 %s: CDP Page.getInstallabilityErrors is empty in a persistent profile" % mode, errs == [], json.dumps(errs)[:300])
        except Exception as e:  # noqa: BLE001
            check("AC 32 %s: CDP Page.getInstallabilityErrors" % mode, False, str(e)[:200])
        finally:
            pctx.close()


def run_wide_light_shots(browser):
    """home-dark.png (1920x1080, dark) and home-light.png (1280x900, light)."""
    ctx = new_ctx(browser, viewport=WIDE)
    page = ctx.new_page()
    goto_home(page)
    shot(page, "home-dark.png")
    ctx.close()
    ctx = new_ctx(browser, viewport=DESKTOP, scheme="light")
    page = ctx.new_page()
    goto_home(page)
    shot(page, "home-light.png")
    ctx.close()


def check_files():
    expected = {
        "home.png": (DESKTOP["width"], DESKTOP["height"]),
        "home-filtered.png": (DESKTOP["width"], DESKTOP["height"]),
        "sources.png": (DESKTOP["width"], DESKTOP["height"]),
        "home-mobile.png": (MOBILE["width"] * MOBILE_SCALE, MOBILE["height"] * MOBILE_SCALE),
        "home-dark.png": (WIDE["width"], WIDE["height"]),
        "home-light.png": (DESKTOP["width"], DESKTOP["height"]),
        "detail.png": (DESKTOP["width"], DESKTOP["height"]),
        "home-mobile-sheet.png": (MOBILE["width"] * MOBILE_SCALE, MOBILE["height"] * MOBILE_SCALE),
    }
    for name, (w, h) in expected.items():
        path = OUT / name
        size = path.stat().st_size if path.exists() else 0
        dims = png_size(path) if path.exists() else (0, 0)
        check(
            "%s is viewport-sized %dx%d and between 20 KB and 1 MB" % (name, w, h),
            dims == (w, h) and MIN_PNG_BYTES < size < MAX_PNG_BYTES,
            "%dx%d, %d bytes" % (dims[0], dims[1], size),
        )


PARITY_SCENARIOS = [
    ("run_home_desktop", lambda b: run_home_desktop(b)),
    ("run_sources_desktop", run_sources_desktop),
    ("run_mobile", run_mobile),
    ("run_wide_light_shots", run_wide_light_shots),
    ("run_matrix_dark", lambda b: run_matrix(b, "dark")),
    ("run_matrix_light", lambda b: run_matrix(b, "light")),
    ("run_sticky", run_sticky),
    ("run_topbar_budget", run_topbar_budget),
    ("run_theme", run_theme),
    ("run_fonts", run_fonts),
    ("run_reduced_motion", run_reduced_motion),
    ("run_drawer", run_drawer),
    ("run_shell", run_shell),
    ("run_keyboard", run_keyboard),
    ("run_live_data", run_live_data),
    ("run_sort_view", run_sort_view),
    ("run_states", run_states),
    ("run_radar", run_radar),
    ("run_sources_layout", run_sources_layout),
    ("run_sw", lambda b: run_sw(b, True)),
]
SMOKE_SCENARIOS = [
    ("run_live_smoke", run_live_smoke),
    ("run_sw", lambda b: run_sw(b, False)),
]


PLAYWRIGHT = {"p": None}


def browser_type_launch_persistent(profile_dir):
    """A non-incognito context (the installability check reports in-incognito for ordinary contexts)."""
    return PLAYWRIGHT["p"].chromium.launch_persistent_context(profile_dir, headless=True, channel=CHANNEL, viewport=DESKTOP, color_scheme="dark")


def main():
    print("base url: %s" % BASE)
    print("mode:     %s" % ("smoke (SMOKE_ONLY=1, no screenshots)" if SMOKE_ONLY else "parity (compares the UI with /api/items)"))
    if not SMOKE_ONLY:
        OUT.mkdir(parents=True, exist_ok=True)
        print("output:   %s" % OUT)
    print("channel:  %s" % CHANNEL)
    print("")

    scenarios = SMOKE_SCENARIOS if SMOKE_ONLY else PARITY_SCENARIOS
    if SCENARIOS:
        wanted = set(SCENARIOS)
        scenarios = [(n, f) for n, f in scenarios if n in wanted or n.replace("_dark", "").replace("_light", "") in wanted]
    with sync_playwright() as p:
        PLAYWRIGHT["p"] = p
        browser = p.chromium.launch(headless=True, channel=CHANNEL)
        try:
            for name, fn in scenarios:
                print("== %s" % name)
                try:
                    fn(browser)
                except Exception as e:  # noqa: BLE001 - one broken scenario must not hide the others
                    frames = [f for f in traceback.extract_tb(e.__traceback__) if f.filename == __file__]
                    where = " (screenshots.py:%d)" % frames[-1].lineno if frames else ""
                    check("%s completed without an exception" % name, False, ("%s: %s%s" % (type(e).__name__, e, where)).replace("\n", " ")[:400])
        finally:
            browser.close()

    if not SMOKE_ONLY and not SCENARIOS:
        check_files()

    failed = results.count(False)
    print("")
    print("%d checks, %d failed" % (len(results), failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
