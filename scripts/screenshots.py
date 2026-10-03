"""Capture Startup Radar screenshots and assert the frontend rules in a real browser.

Usage (from the repo root, server already running on BASE_URL):
    python scripts/screenshots.py

Environment:
    BASE_URL    default http://localhost:3000
    PW_CHANNEL  chromium channel, default "msedge" (bundled browsers are not
                installed on the dev machine; "chrome" also works)

Writes VIEWPORT-ONLY screenshots (never full-page) to docs/screenshots/:
    home.png           desktop 1280x900, unfiltered feed
    home-filtered.png  desktop 1280x900, kind=funding + USA scope
    sources.png        desktop 1280x900, /sources
    home-mobile.png    mobile 390x844 at 2x (780x1688 px)

Every check prints "PASS  <name>  (<detail>)" or "FAIL ...". Exit code is 1
when any check fails. Filter checks compare what the page renders against
what /api/items returns for the same query, so a filter that silently does
nothing is caught even when the URL changes.
"""

import os
import re
import struct
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse

from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE_URL", "http://localhost:3000").rstrip("/")
OUT = Path(__file__).resolve().parents[1] / "docs" / "screenshots"
CHANNEL = os.environ.get("PW_CHANNEL", "msedge")
WAIT_MS = 30000
DESKTOP = {"width": 1280, "height": 900}
MOBILE = {"width": 390, "height": 844}
MOBILE_SCALE = 2
PAGE_SIZE = 30
MIN_FONT_PX = 12
MIN_BODY_FONT_PX = 16
CONTROL_MIN_PX = 40
CONTROL_MAX_PX = 44
MAX_PNG_BYTES = 1024 * 1024
MIN_PNG_BYTES = 20 * 1024

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

results = []


def check(name, ok, detail=""):
    status = "PASS" if ok else "FAIL"
    line = "%s  %s" % (status, name)
    if detail:
        line += "  (%s)" % detail
    print(line)
    results.append(bool(ok))
    return bool(ok)


# ---------------------------------------------------------------------------
# JavaScript evaluated in the page. Each snippet returns plain JSON data only.
# ---------------------------------------------------------------------------

# Current result list as rendered.
SNAPSHOT_JS = r"""
() => {
  const text = (el) => (el ? el.textContent.trim() : '');
  const countText = text(document.querySelector('#result-count'));
  const m = /^(\d+) items/.exec(countText);
  const total = m ? parseInt(m[1], 10) : (countText.startsWith('No items') ? 0 : null);
  const cards = Array.from(document.querySelectorAll('#results article')).map((a) => {
    const t = a.querySelector('time');
    const kindBadge = a.querySelector('.badge:not(.badge-source):not(.badge-region)');
    return {
      title: text(a.querySelector('h2 a')),
      source: text(a.querySelector('.badge-source')),
      kind: text(kindBadge),
      region: text(a.querySelector('.badge-region')),
      time: t ? t.getAttribute('datetime') : null,
      text: text(a),
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

# Computed-style audit over every visible element.
UI_AUDIT_JS = r"""
() => {
  const px = (v) => parseFloat(v) || 0;
  const rect = (el) => el.getBoundingClientRect();
  const visible = (el) => {
    const r = rect(el);
    return r.width > 0 && r.height > 0;
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


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

ABSENT = ""  # marker for "this query key must be absent" (None would be dropped by the Python binding)


def wait_state(page, expected):
    """Block until the URL query equals `expected` and the result list finished loading."""
    if any(v is None for v in expected.values()):
        raise ValueError("use ABSENT, not None, in wait_state expectations")
    page.wait_for_function(WAIT_STATE_JS, arg=expected, timeout=WAIT_MS)


def snapshot(page):
    return page.evaluate(SNAPSHOT_JS)


def parse_iso(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def png_size(path):
    with open(path, "rb") as f:
        head = f.read(24)
    if len(head) < 24 or head[:8] != b"\x89PNG\r\n\x1a\n":
        return (0, 0)
    return struct.unpack(">II", head[16:24])


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
    def __init__(self, request):
        self.request = request

    def items(self, params):
        qs = dict(params)
        qs.setdefault("limit", PAGE_SIZE)
        res = self.request.get(BASE + "/api/items?" + urlencode(qs))
        if not res.ok:
            raise RuntimeError("GET /api/items %s -> %d" % (qs, res.status))
        return res.json()

    def sources(self):
        res = self.request.get(BASE + "/api/sources")
        if not res.ok:
            raise RuntimeError("GET /api/sources -> %d" % res.status)
        return res.json()


def ui_matches_api(snap, api_data):
    """Rendered total + first title match the API answer for the same query."""
    if snap["total"] != api_data["total"]:
        return False
    if snap["total"] == 0:
        return snap["shown"] == 0 and snap["emptyShown"]
    return first_title(snap) == first_title(api_data)


def audit_page(page, label, want_controls=True, open_details=False):
    """Font-size, control-height, link-rel and overflow audit for the current page."""
    if open_details and page.locator("#sources-filter").count():
        page.click("#sources-filter summary")
        page.wait_for_selector("#source-list input", state="visible", timeout=WAIT_MS)
    a = page.evaluate(UI_AUDIT_JS)
    if open_details and page.locator("#sources-filter").count():
        page.click("#sources-filter summary")

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
        a["blankLinks"] >= 1 and a["badLinks"] == 0,
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
        for word in re.findall(r"[A-Za-z]{4,}", title):
            data = api.items({"q": word})
            if 1 <= data["total"] < base_total:
                return word, data
    return None, None


# ---------------------------------------------------------------------------
# Scenarios
# ---------------------------------------------------------------------------

def run_home_desktop(browser):
    ctx = browser.new_context(viewport=DESKTOP)
    page = ctx.new_page()
    api = Api(ctx.request)
    console_errors = []
    item_requests = []
    page.on("pageerror", lambda err: console_errors.append(str(err)))
    page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)
    page.on("request", lambda req: item_requests.append(req.url) if "/api/items" in req.url else None)

    page.goto(BASE + "/", wait_until="domcontentloaded")
    wait_state(page, {})
    base = snapshot(page)
    api_base = api.items({})
    base_titles = [c["title"] for c in base["cards"]]

    check("home: at least 1 article rendered", base["shown"] >= 1, "%d articles, total %s" % (base["shown"], base["total"]))
    check("home: result list matches /api/items (total + first title)", ui_matches_api(base, api_base), "total %s" % base["total"])
    times = [parse_iso(c["time"]) for c in base["cards"] if c["time"]]
    check(
        "home: newest first",
        len(times) == base["shown"] and all(times[i] >= times[i + 1] for i in range(len(times) - 1)),
        "%d timestamps, first %s" % (len(times), times[0].isoformat() if times else "-"),
    )
    check("home: 'Last refreshed' text present", page.evaluate("/Last refreshed/.test(document.body.innerText)"))
    check("home: has source, kind and region badges on every card", all(c["source"] and c["kind"] and c["region"] for c in base["cards"]))

    page.screenshot(path=str(OUT / "home.png"), full_page=False)
    print("wrote home.png (viewport %dx%d)" % (DESKTOP["width"], DESKTOP["height"]))

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
        last_req = parse_qs(urlparse(item_requests[-1]).query) if item_requests else {}
        since_iso = (last_req.get("since") or [None])[0]
        if not since_iso:
            check("chip %s: request carried an ISO since parameter" % label, False, item_requests[-1] if item_requests else "no request")
            continue
        exp = api.items({"since": since_iso})
        chg_ok, changed, note = describe_change(snap, base, exp, api_base)
        changed_flags.append(("since=" + value, changed, chg_ok))
        cutoff = parse_iso(since_iso)
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
    candidates = [s for s in src if s["enabled"] and s["itemCount"] > 0 and s["itemCount"] < base["total"]]
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
    page.screenshot(path=str(OUT / "home-filtered.png"), full_page=False)
    print("wrote home-filtered.png (viewport %dx%d, url %s)" % (DESKTOP["width"], DESKTOP["height"], page.url))

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
    check("home: no console errors or page errors", len(console_errors) == 0, "; ".join(console_errors)[:300])

    ctx.close()
    return base


def run_sources_desktop(browser):
    ctx = browser.new_context(viewport=DESKTOP)
    page = ctx.new_page()
    api = Api(ctx.request)
    console_errors = []
    page.on("pageerror", lambda err: console_errors.append(str(err)))
    page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)

    page.goto(BASE + "/sources", wait_until="domcontentloaded")
    page.wait_for_selector("#sources-table tbody tr", timeout=WAIT_MS)
    page.wait_for_selector("#explore-list li", timeout=WAIT_MS)
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

    audit_page(page, "sources desktop", want_controls=False)
    page.screenshot(path=str(OUT / "sources.png"), full_page=False)
    print("wrote sources.png (viewport %dx%d)" % (DESKTOP["width"], DESKTOP["height"]))
    check("sources: no console errors or page errors", len(console_errors) == 0, "; ".join(console_errors)[:300])

    per_source = ["%s=%d" % (s["id"], s["itemCount"]) for s in api_sources]
    print("per-source item counts: " + ", ".join(per_source))
    ctx.close()


def run_mobile(browser):
    ctx = browser.new_context(viewport=MOBILE, device_scale_factor=MOBILE_SCALE, is_mobile=True, has_touch=True)
    page = ctx.new_page()
    console_errors = []
    page.on("pageerror", lambda err: console_errors.append(str(err)))
    page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)

    page.goto(BASE + "/", wait_until="domcontentloaded")
    wait_state(page, {})
    snap = snapshot(page)
    check("mobile home: at least 1 article rendered", snap["shown"] >= 1, "%d articles" % snap["shown"])
    page.screenshot(path=str(OUT / "home-mobile.png"), full_page=False)
    print("wrote home-mobile.png (viewport %dx%d at %dx)" % (MOBILE["width"], MOBILE["height"], MOBILE_SCALE))
    a = audit_page(page, "home mobile 390px", want_controls=True, open_details=True)
    check("mobile home: document.documentElement.scrollWidth <= 390", a["scrollWidth"] <= MOBILE["width"], "scrollWidth %d" % a["scrollWidth"])

    page.goto(BASE + "/sources", wait_until="domcontentloaded")
    page.wait_for_selector("#sources-table tbody tr", timeout=WAIT_MS)
    b = audit_page(page, "sources mobile 390px", want_controls=False)
    check("mobile sources: document.documentElement.scrollWidth <= 390", b["scrollWidth"] <= MOBILE["width"], "scrollWidth %d" % b["scrollWidth"])
    check("mobile: no console errors or page errors", len(console_errors) == 0, "; ".join(console_errors)[:300])
    ctx.close()


def check_files():
    expected = {
        "home.png": (DESKTOP["width"], DESKTOP["height"]),
        "home-filtered.png": (DESKTOP["width"], DESKTOP["height"]),
        "sources.png": (DESKTOP["width"], DESKTOP["height"]),
        "home-mobile.png": (MOBILE["width"] * MOBILE_SCALE, MOBILE["height"] * MOBILE_SCALE),
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


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    print("base url: %s" % BASE)
    print("output:   %s" % OUT)
    print("channel:  %s" % CHANNEL)
    print("")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, channel=CHANNEL)
        try:
            run_home_desktop(browser)
            run_sources_desktop(browser)
            run_mobile(browser)
        finally:
            browser.close()

    check_files()

    failed = results.count(False)
    print("")
    print("%d checks, %d failed" % (len(results), failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
