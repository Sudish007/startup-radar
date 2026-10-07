// Startup Radar resources page (plan §3.2 item 20): renders RESOURCE_GROUPS from ./resources-data.js as one list per
// group. Links only (extLink -> new tab, noopener noreferrer); nothing is fetched, counted or ranked here.

import { hostnameOf } from './format.js';
import { clear, el, extLink } from './ui.js';
import { createLensPage, num } from './lens.js';
import { RESOURCE_GROUPS } from './resources-data.js';

const els = { status: document.getElementById('status'), groups: document.getElementById('resource-groups') };
const lens = createLensPage({ page: 'resources', getList: () => [], findItem: () => null, buildUrl: () => location.pathname });

function linkRow(link) {
  return el('li', { className: 'resource-row' }, [
    extLink(link.url, link.name, { className: 'resource-name' }),
    el('span', { className: 'resource-host', text: hostnameOf(link.url) }),
    el('span', { className: 'note', text: link.note }),
  ]);
}

function renderGroups() {
  clear(els.groups);
  let total = 0;
  RESOURCE_GROUPS.forEach((group, i) => {
    total += group.links.length;
    const id = `group-${i}`;
    els.groups.append(el('section', { className: 'lens-section resource-group', 'aria-labelledby': id }, [
      el('h2', { id, text: group.title }),
      el('ul', { className: 'resource-list' }, group.links.map(linkRow)),
    ]));
  });
  els.status.textContent = `${num(total)} links in ${num(RESOURCE_GROUPS.length)} groups \u00b7 hand-picked, not fetched`;
}

async function init() {
  renderGroups();
  await lens.loadStats();
  await lens.start();
}

init();
