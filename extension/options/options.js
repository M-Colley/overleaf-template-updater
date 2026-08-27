/* Options page: the two behaviour settings, plus full visibility into what the
 * extension tracks, what it has cached, and every URL it can reach. The
 * transparency is the point -- it is what makes the "no telemetry" claim
 * checkable rather than something to take on trust. */
'use strict';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

function bg(type, payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...payload }, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!res || res.ok === false) return reject(new Error((res && res.error) || 'failed'));
      resolve(res);
    });
  });
}

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

function fmtAge(ts) {
  if (!ts) return '—';
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + ' min ago';
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs + (hrs === 1 ? ' hour ago' : ' hours ago');
  const days = Math.round(hrs / 24);
  return days + (days === 1 ? ' day ago' : ' days ago');
}

/* ------------------------------------------------------------------ registry */

let registry = null;

async function loadRegistry() {
  const res = await fetch(chrome.runtime.getURL('registry/templates.json'));
  registry = await res.json();

  const rows = ['<tr><th>Template</th><th>File</th><th>Handling</th><th>Source</th></tr>'];
  for (const t of registry.templates) {
    t.files.forEach((f, i) => {
      const tag = f.action === 'replace'
        ? '<span class="tag t-replace">auto-update</span>'
        : '<span class="tag t-report">report only</span>';

      const shared = f.source && f.source.ref ? (registry.sources || {})[f.source.ref] : null;
      const url = (f.source && f.source.url) || (shared && shared.url);
      const src = url
        ? `<span class="src">${esc(url.replace(/^https:\/\//, ''))}</span>`
        : t.upstream && t.upstream.version && t.upstream.version.kind === 'ctan'
        ? `<span class="src">CTAN: ${esc(t.upstream.version.pkg)} (version only)</span>`
        : '<span class="src muted">—</span>';

      rows.push(
        '<tr>' +
        (i === 0
          ? `<td rowspan="${t.files.length}"><strong>${esc(t.name)}</strong>` +
            `<span class="usedby">${esc((t.usedBy || []).join(', '))}</span></td>`
          : '') +
        `<td><code>${esc(f.name)}</code></td><td>${tag}</td><td>${src}</td></tr>`
      );
    });
  }
  document.querySelector('#registry tbody').innerHTML = rows.join('');
}

/* --------------------------------------------------------------------- cache */

async function renderCache() {
  const tbody = document.querySelector('#cache tbody');
  try {
    const s = await bg('cacheStats');
    if (!s.count) {
      tbody.innerHTML =
        '<tr><td class="muted">Nothing cached yet. Run a scan on an Overleaf project.</td></tr>';
      return;
    }
    const rows = [
      '<tr><th>File</th><th>Version</th><th class="num">Size</th><th>Fetched</th></tr>',
    ];
    for (const e of s.entries) {
      rows.push(
        `<tr><td><code>${esc(e.name)}</code></td>` +
        `<td>${e.version ? 'v' + esc(e.version) : '<span class="muted">—</span>'}</td>` +
        `<td class="num">${fmtBytes(e.bytes)}</td>` +
        `<td>${esc(fmtAge(e.fetchedAt))}</td></tr>`
      );
    }
    rows.push(
      `<tr><td>${s.count} file${s.count === 1 ? '' : 's'}</td><td></td>` +
      `<td class="num">${fmtBytes(s.totalBytes)}</td><td></td></tr>`
    );
    tbody.innerHTML = rows.join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td class="bad-text">Could not read cache: ${esc(err.message)}</td></tr>`;
  }
}

/* -------------------------------------------------------------- connectivity */

async function testSources() {
  const out = document.getElementById('results');
  const btn = document.getElementById('test');
  btn.disabled = true;
  out.innerHTML = '<div class="muted">Testing…</div>';

  const jobs = [];
  for (const t of registry.templates) {
    const pkg = t.upstream && t.upstream.version && t.upstream.version.kind === 'ctan'
      ? t.upstream.version.pkg : null;
    if (pkg) {
      jobs.push({
        label: `CTAN version · ${pkg}`,
        run: () => bg('ctanPackage', { pkg }).then((r) =>
          r.version && r.version.number
            ? `v${r.version.number} (${r.version.date || 'no date'})`
            : 'no version field'),
      });
    }
    for (const f of t.files) {
      if (!f.source) continue;
      const shared = f.source.ref ? (registry.sources || {})[f.source.ref] : null;
      const resolved = shared ? { ...shared, member: f.source.member } : f.source;
      if (!resolved.url) continue;

      jobs.push({
        label: `Download · ${f.name}`,
        run: () => (resolved.kind === 'zip'
          ? bg('fetchZipMember', { url: resolved.url, member: resolved.member })
          : bg('fetchText', { url: resolved.url })
        ).then((r) =>
          `${(r.text.length / 1024).toFixed(1)} KB` +
          (r.cached ? ` (${r.cached === true ? 'cached' : r.cached})` : ' (fetched)')),
      });
    }
  }

  const lines = [];
  for (const job of jobs) {
    try {
      const detail = await job.run();
      lines.push(`<div class="ok-text">✓ ${esc(job.label)} — ${esc(detail)}</div>`);
    } catch (err) {
      lines.push(`<div class="bad-text">✗ ${esc(job.label)} — ${esc(err.message)}</div>`);
    }
    out.innerHTML = lines.join('');
  }
  btn.disabled = false;
  renderCache();
}

/* ------------------------------------------------------------------ settings */

async function initSettings() {
  const stored = await chrome.storage.sync.get(['backupDefault', 'autoClose']);
  for (const [id, dflt] of [['backupDefault', true], ['autoClose', true]]) {
    const cb = document.getElementById(id);
    cb.checked = stored[id] === undefined ? dflt : stored[id];
    cb.addEventListener('change', () => chrome.storage.sync.set({ [id]: cb.checked }));
  }
}

document.getElementById('clearCache').addEventListener('click', async () => {
  const msg = document.getElementById('cacheMsg');
  try {
    const r = await bg('cacheClear');
    msg.textContent = `Cleared ${r.removed} entr${r.removed === 1 ? 'y' : 'ies'}.`;
    msg.className = 'ok-text';
    await renderCache();
  } catch (err) {
    msg.textContent = err.message;
    msg.className = 'bad-text';
  }
});

document.getElementById('test').addEventListener('click', testSources);

loadRegistry().catch((e) => {
  document.querySelector('#registry tbody').innerHTML =
    `<tr><td class="bad-text">Could not load registry: ${esc(e.message)}</td></tr>`;
});
initSettings();
renderCache();
