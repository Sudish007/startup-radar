// Startup Radar PWA client plumbing, imported by ui.js startPwa() after `load`
// (like sw.js, outside the first-render budget): registers ./sw.js with a
// relative scope, shows the "Update available" toast and the install button.

let awaitingReload = false;
let updateToast = null;

function showUpdateToast(toast, worker) {
  if (updateToast?.isConnected) return;
  updateToast = toast('Update available \u2014 Reload', {
    variant: 'update',
    action: { label: 'Reload', onClick: () => { awaitingReload = true; worker.postMessage({ type: 'SKIP_WAITING' }); } },
  });
}

/** Register on https or localhost only; the first install (clients.claim) never reloads the page. */
async function registerServiceWorker(toast) {
  if (!('serviceWorker' in navigator)) return;
  const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (location.protocol !== 'https:' && !local) return;
  try {
    const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
    if (reg.waiting && navigator.serviceWorker.controller) showUpdateToast(toast, reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) showUpdateToast(toast, w);
      });
    });
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!awaitingReload) return;
      awaitingReload = false;
      location.reload();
    });
  } catch (err) {
    console.warn('[radar] service worker registration failed:', err?.message ?? err);
  }
}

/** Show the footer Install button only when the browser offers beforeinstallprompt. */
function initInstallPrompt() {
  const btn = document.getElementById('install');
  if (!btn) return;
  let deferred = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; btn.hidden = false; });
  btn.addEventListener('click', async () => {
    const ev = deferred;
    deferred = null;
    btn.hidden = true;
    try { await ev?.prompt(); } catch { /* dismissed or unavailable */ }
  });
  window.addEventListener('appinstalled', () => { btn.hidden = true; });
}

export function init({ toast }) {
  initInstallPrompt();
  return registerServiceWorker(toast);
}
