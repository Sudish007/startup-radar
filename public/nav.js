// Navigation (DOM-free): NAV is the static <ul> of every public/*.html (shell.js re-fills it); pageOf(pathname) -> page id or null; GOTO_ROWS = help rows of the `g` chords.

export const NAV = [
  { href: './index.html', label: 'Feed', page: 'feed', key: 'h' },
  { href: './trends.html', label: 'Trends', page: 'trends', key: 't' },
  { href: './funding.html', label: 'Funding', page: 'funding', key: 'f' },
  { href: './yc.html', label: 'YC', page: 'yc', key: 'y' },
  { href: './notebook.html', label: 'Notebook', page: 'notebook', key: 'n' },
  { href: './signals.html', label: 'Signals', page: 'signals', key: 's' },
  { href: './digest.html', label: 'Digest', page: 'digest', key: 'd' },
  { href: './resources.html', label: 'Resources', page: 'resources', key: 'r' },
  { href: './sources.html', label: 'Sources', page: 'sources', key: null },
];

export function pageOf(pathname) {
  const last = String(pathname ?? '').split('/').pop() ?? '';
  if (last === '' || last === 'index.html') return 'feed';
  const name = last.replace(/\.html$/, '');
  return NAV.find((n) => n.page === name)?.page ?? null;
}

export const GOTO_ROWS = NAV.filter((n) => n.key).map((n) => [['g', n.key], `Go to ${n.label}`]);
