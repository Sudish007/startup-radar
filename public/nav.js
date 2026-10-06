// Startup Radar navigation data (DOM-free): the one list every public/*.html ships statically and shell.js re-fills.

export const NAV = [
  { href: './index.html', label: 'Feed', page: 'feed', key: 'h' },
  { href: './trends.html', label: 'Trends', page: 'trends', key: 't' },
  { href: './funding.html', label: 'Funding', page: 'funding', key: 'f' },
  { href: './yc.html', label: 'YC', page: 'yc', key: 'y' },
  { href: './notebook.html', label: 'Notebook', page: 'notebook', key: 'n' },
  { href: './sources.html', label: 'Sources', page: 'sources', key: null },
];

/** '/startup-radar/trends.html' -> 'trends'; '/', '/index.html' -> 'feed'; '/sources' -> 'sources'; unknown -> null. */
export function pageOf(pathname) {
  const last = String(pathname ?? '').split('/').pop() ?? '';
  if (last === '' || last === 'index.html') return 'feed';
  const name = last.replace(/\.html$/, '');
  return NAV.find((n) => n.page === name)?.page ?? null;
}

/** Help-dialog rows for the `g` + letter go-to chords ([[keys], description]). */
export const GOTO_ROWS = NAV.filter((n) => n.key).map((n) => [['g', n.key], `Go to ${n.label}`]);
