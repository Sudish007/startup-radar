// Static Atom 1.0 feed of the weekly digest (plan D10: string-built, no XML dependency). Every text node and
// attribute goes through esc(); the HTML inside <content type="html"> is built with esc() for its own text
// and then escaped again as the element's text content, as Atom requires.

// Characters XML 1.0 forbids even when escaped (C0 controls other than tab, LF and CR).
const XML_ILLEGAL = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

export function esc(s) {
  return String(s ?? '')
    .replace(XML_ILLEGAL, '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function trimSlash(url) {
  return String(url ?? '').replace(/\/+$/, '');
}

function absolute(href, publicUrl) {
  if (/^https?:\/\//i.test(href)) return href;
  return `${publicUrl}/${String(href).replace(/^\.?\//, '')}`;
}

function list(title, rows, note = '') {
  if (!rows.length) return '';
  return `<h2>${esc(title)}</h2>${note}<ul>${rows.join('')}</ul>`;
}

/** Signal highlights carried over from a failed fetch keep the label the Signals page gives them. */
export function staleNote(state) {
  if (!state || state.ok !== false) return '';
  return `<p>Carried over from an earlier fetch: last good data from ${esc(state.lastSuccessAt ?? 'an unknown time')} — unavailable since ${esc(state.unavailableSince ?? 'an unknown time')}.</p>`;
}

function li(href, text, note, publicUrl) {
  const a = href ? `<a href="${esc(absolute(href, publicUrl))}">${esc(text)}</a>` : esc(text);
  return `<li>${a}${note ? ` — ${esc(note)}` : ''}</li>`;
}

/** HTML body of one week entry (unescaped HTML string; the caller escapes it for Atom). */
export function weekHtml(week, publicUrl) {
  const digestUrl = `${publicUrl}/digest.html?week=${week.week}`;
  const parts = [
    `<p>ISO week ${esc(week.week)} (${esc(week.from.slice(0, 10))} to ${esc(week.to.slice(0, 10))})${week.partial ? ', partial week' : ''}. <a href="${esc(digestUrl)}">Open in Startup Radar</a>.</p>`,
    list('Funding rounds (ordered by approx. USD at static rates)', week.rounds.map((r) => li(r.url, r.title, [r.amountText, r.stage].filter(Boolean).join(', '), publicUrl))),
    list('Launches (HN points / PH votes)', week.launches.map((l) => li(l.url, l.title, `${l.value} ${l.metric}`, publicUrl))),
    list('New YC companies (by launch date)', week.ycNew.map((c) => li(c.url, c.name, [c.batch, c.oneLiner].filter(Boolean).join(': '), publicUrl))),
    list('Rising terms (this week vs the 4 prior weeks)', week.risingTerms.map((t) => li(null, t.term, `${t.thisWeek} this week, ${t.priorWeeklyAvg} per prior week`, publicUrl))),
  ];
  if (week.signalHighlights) {
    const { repos = [], models = [], github = null, huggingface = null } = week.signalHighlights;
    parts.push(list('GitHub: new repositories (stars since creation, <= 7 days)', repos.map((r) => li(r.url, r.fullName, `${r.stars} stars`, publicUrl)), staleNote(github)));
    parts.push(list('Hugging Face: trending models (API order)', models.map((m) => li(m.url, m.id, `#${m.position}${m.likes != null ? `, ${m.likes} likes` : ''}`, publicUrl)), staleNote(huggingface)));
  }
  return parts.join('');
}

/**
 * buildAtom({ digest, publicUrl, now }) -> Atom 1.0 document string, one <entry> per digest week (newest first).
 * Entry ids/links are `${publicUrl}/digest.html?week=YYYY-Www`; every href is absolute from publicUrl.
 */
export function buildAtom({ digest, publicUrl, now = new Date() }) {
  const base = trimSlash(publicUrl);
  const updated = digest?.generatedAt ?? now.toISOString();
  const weeks = [...(Array.isArray(digest?.weeks) ? digest.weeks : [])].reverse();
  const entries = weeks.map((w) => {
    const url = `${base}/digest.html?week=${w.week}`;
    const entryUpdated = w.partial ? updated : w.to;
    return [
      '  <entry>',
      `    <id>${esc(url)}</id>`,
      `    <title>Startup Radar digest — week ${esc(w.week)}</title>`,
      `    <link rel="alternate" type="text/html" href="${esc(url)}"/>`,
      `    <updated>${esc(entryUpdated)}</updated>`,
      `    <published>${esc(w.from)}</published>`,
      `    <content type="html">${esc(weekHtml(w, base))}</content>`,
      '  </entry>',
    ].join('\n');
  });
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `  <id>${esc(base)}/feed.xml</id>`,
    '  <title>Startup Radar weekly digest</title>',
    '  <subtitle>Weekly funding rounds, launches, new YC companies and rising terms from the Startup Radar feed; every number is a real count or sum with its basis stated.</subtitle>',
    `  <link rel="self" type="application/atom+xml" href="${esc(base)}/feed.xml"/>`,
    `  <link rel="alternate" type="text/html" href="${esc(base)}/digest.html"/>`,
    `  <updated>${esc(updated)}</updated>`,
    '  <author><name>Startup Radar</name></author>',
    `  <generator>Startup Radar</generator>`,
    ...entries,
    '</feed>',
    '',
  ].join('\n');
}
