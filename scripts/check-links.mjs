#!/usr/bin/env node
// Probe every URL in public/resources-data.js (Node >= 22, no deps, network): GET with the StartupRadar
// User-Agent, follow redirects, print `<status> <url> -> <final url>` per link and exit 1 on anything other
// than 200 or a 3xx. Not part of `npm test`; run it when the list changes and record the output.
//
//   node scripts/check-links.mjs

import { RESOURCE_GROUPS } from '../public/resources-data.js';

const UA = 'StartupRadar/1.0 (+https://sudish007.github.io/startup-radar)';
const TIMEOUT_MS = 20_000;

async function probe(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*' }, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
    await res.arrayBuffer().catch(() => null); // drain so the socket is reusable
    return { status: res.status, finalUrl: res.url, ok: res.status === 200 || (res.status >= 300 && res.status < 400) };
  } catch (err) {
    return { status: 'ERR', finalUrl: err?.message ?? String(err), ok: false };
  }
}

let failed = 0;
let total = 0;
for (const group of RESOURCE_GROUPS) {
  console.log(`# ${group.title}`);
  for (const link of group.links) {
    total += 1;
    const r = await probe(link.url);
    if (!r.ok) failed += 1;
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.status}  ${link.url}${r.finalUrl && r.finalUrl !== link.url ? ` -> ${r.finalUrl}` : ''}`);
  }
}
console.log('');
console.log(`${total} links, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
