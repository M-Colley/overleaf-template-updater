/* Toolbar popup: says plainly whether the extension is active on this tab and,
 * if not, why -- then offers the one action that would fix it.
 *
 * The common confusion this exists to answer: Chrome files the extension under
 * "No access needed" whenever the tab's origin is not one it asked for. That
 * happens on a university-hosted Overleaf (Server Pro runs on the institution's
 * own domain), which no static match pattern can cover. Granting it here uses
 * optional_host_permissions, so the user opts in per site. */
'use strict';

const stateEl = document.getElementById('state');
const actionsEl = document.getElementById('actions');
const hintEl = document.getElementById('hint');

function show(kind, html, url) {
  stateEl.className = 'card ' + kind;
  stateEl.innerHTML = html + (url ? `<div class="url">${url}</div>` : '');
}

function button(label, primary, onClick) {
  const b = document.createElement('button');
  b.textContent = label;
  if (primary) b.className = 'primary';
  b.addEventListener('click', onClick);
  actionsEl.appendChild(b);
  return b;
}

const OVERLEAF_HOST = /(^|\.)overleaf\.com$/i;

/** Is the content script alive in this tab? */
async function ping(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'otu-ping' });
  } catch {
    return null; // no receiver == not injected here
  }
}

async function main() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) {
    return show('warn', 'Cannot read this tab.');
  }

  let url;
  try {
    url = new URL(tab.url);
  } catch {
    return show('warn', 'This is not a normal web page.', tab.url);
  }

  if (url.protocol !== 'https:') {
    return show('warn',
      '<strong>Not an Overleaf page.</strong><br>' +
      'Open a project on Overleaf, then click this button again.', url.href);
  }

  const pong = await ping(tab.id);

  if (pong) {
    if (pong.projectId) {
      show('ok',
        '<strong>Active on this project.</strong><br>' +
        'Look for the <b>&#8635; Template</b> button at the bottom-right.',
        url.origin + url.pathname);
      button('Open the panel', true, async () => {
        await chrome.tabs.sendMessage(tab.id, { type: 'otu-open' });
        window.close();
      });
    } else {
      show('info',
        '<strong>Running here, but no project is open.</strong><br>' +
        'The panel only appears inside a project (a URL like ' +
        '<code>/project/&lt;id&gt;</code>). Open one and the button will appear.',
        url.origin + url.pathname);
    }
    return;
  }

  // Not injected. Either the page predates the extension being loaded, or this
  // origin was never granted.
  const granted = await chrome.permissions.contains({
    origins: [url.origin + '/*'],
  });

  if (granted || OVERLEAF_HOST.test(url.hostname)) {
    show('warn',
      '<strong>Not running on this page yet.</strong><br>' +
      'The tab was open before the extension was loaded or reloaded. ' +
      'Reloading the page injects it.', url.origin);
    button('Reload this page', true, async () => {
      await chrome.tabs.reload(tab.id);
      window.close();
    });
    return;
  }

  // An unrecognised host: most likely a self-hosted Overleaf Server Pro.
  show('warn',
    '<strong>Not enabled on this site.</strong><br>' +
    'If this is a self-hosted Overleaf (many universities run their own), ' +
    'you can grant access to just this domain.', url.origin);

  button(`Enable on ${url.hostname}`, true, async () => {
    const ok = await chrome.permissions.request({ origins: [url.origin + '/*'] });
    if (!ok) return show('warn', 'Permission was declined.', url.origin);

    const res = await chrome.runtime.sendMessage({
      type: 'registerSite', origin: url.origin,
    });
    if (!res || res.ok === false) {
      return show('warn', 'Could not enable: ' + ((res && res.error) || 'unknown error'),
        url.origin);
    }
    await chrome.tabs.reload(tab.id);
    window.close();
  });

  hintEl.innerHTML =
    'Only grant this on a site you know is your Overleaf instance.';
}

main().catch((err) => show('warn', 'Error: ' + err.message));
