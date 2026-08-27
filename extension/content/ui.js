/* Panel rendering.
 *
 * All project- and network-sourced strings go through escapeHtml before they
 * reach innerHTML.
 *
 * The layout is built around one idea: the version delta is the answer the user
 * came for, so `1.71 -> 2.20` is the loudest object in each row and everything
 * else is subordinate to it. Items are grouped by what the user can act on, so
 * the handful that need attention are never buried among the ones that don't. */
var OTU = (typeof OTU !== 'undefined' && OTU) || {};

OTU.ui = (function () {
  'use strict';

  const esc = (s) => OTU.util.escapeHtml(s);

  const STATUS_LABEL = {
    outdated: 'update',
    current: 'current',
    modified: 'edited',
    unknown: 'unknown',
    absent: 'not bundled',
    ahead: 'ahead',
  };

  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  function root() { return document.getElementById('otu-root'); }
  function body() { return document.getElementById('otu-body'); }

  function mount() {
    if (document.getElementById('otu-root')) return;

    const launch = el(`
      <button id="otu-launch" title="Check this project's LaTeX template against upstream">
        <span class="otu-glyph" aria-hidden="true">&#8635;</span><span>Template</span>
      </button>`);

    const panel = el(`
      <aside id="otu-root" hidden aria-label="Template Updater">
        <div class="otu-head">
          <div>
            <h2>Template Updater</h2>
            <p id="otu-subtitle">Ready</p>
          </div>
          <button class="otu-close" title="Close" aria-label="Close">&times;</button>
        </div>
        <div class="otu-body" id="otu-body"></div>
        <div class="otu-foot">
          <label>
            <input type="checkbox" id="otu-backup" checked>
            <span>Download a .zip backup before applying</span>
          </label>
          <div class="otu-buttons">
            <button class="otu-secondary" id="otu-rescan">Rescan</button>
            <button class="otu-primary" id="otu-apply" disabled>Apply updates</button>
          </div>
        </div>
      </aside>`);

    document.body.appendChild(launch);
    document.body.appendChild(panel);

    launch.addEventListener('click', () => {
      panel.hidden = false;
      launch.hidden = true;
      OTU.content.onOpen();
    });
    panel.querySelector('.otu-close').addEventListener('click', closePanel);
    panel.querySelector('#otu-rescan').addEventListener('click', () => OTU.content.rescan());
    panel.querySelector('#otu-apply').addEventListener('click', () => OTU.content.applySelected());

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !panel.hidden) closePanel();
    });

    // Honour the preference set on the options page.
    const backup = panel.querySelector('#otu-backup');
    chrome.storage.sync.get('backupDefault').then(({ backupDefault = true }) => {
      backup.checked = backupDefault;
    }).catch(() => { /* keep the checked-by-default fallback */ });
    backup.addEventListener('change', () =>
      chrome.storage.sync.set({ backupDefault: backup.checked }).catch(() => {})
    );
  }

  function closePanel() {
    const r = root();
    const launch = document.getElementById('otu-launch');
    if (r) r.hidden = true;
    if (launch) launch.hidden = false;
  }

  function subtitle(text) {
    const n = document.getElementById('otu-subtitle');
    if (n) n.textContent = text;
  }

  /** Drives the hairline progress sweep under the header. */
  function setBusy(on) {
    const r = root();
    if (r) r.classList.toggle('otu-busy', !!on);
  }

  function showSkeleton() {
    body().innerHTML = '<div class="otu-skel"></div>'.repeat(3);
    setApplyEnabled(false);
  }

  function showMessage(kind, text) {
    body().innerHTML = `<div class="otu-${kind}">${esc(text)}</div>`;
    setApplyEnabled(false);
  }

  function setApplyEnabled(on, label) {
    const btn = document.getElementById('otu-apply');
    if (!btn) return;
    btn.disabled = !on;
    if (label) btn.textContent = label;
  }

  function backupWanted() {
    const cb = document.getElementById('otu-backup');
    return !!(cb && cb.checked);
  }

  /* ------------------------------------------------------------- formatting */

  function cacheLabel(cached) {
    switch (cached) {
      case 'version': return 'cached &middot; version confirmed current';
      case 'ttl': return 'cached';
      case 'revalidated': return 'cached &middot; revalidated';
      default: return 'downloaded just now';
    }
  }

  function shortVersion(v) {
    if (!v) return null;
    if (v.version) return 'v' + v.version;
    if (v.date) return v.date;
    return null;
  }

  /** `v1.71 -> v2.20`, or a single value when there is nothing to compare. */
  function deltaHtml(item) {
    const from = shortVersion(item.local);
    const to = shortVersion(item.upstream);

    if (from && to && from !== to) {
      return `<div class="otu-delta">
        <span class="otu-v otu-v-old">${esc(from)}</span>
        <span class="otu-arrow" aria-hidden="true">&#8594;</span>
        <span class="otu-v otu-v-new">${esc(to)}</span>
      </div>`;
    }
    const only = to || from;
    if (!only) {
      return `<div class="otu-delta"><span class="otu-single">version not detectable</span></div>`;
    }
    // Only claim a match when the file really matches. A "modified" item has the
    // same version number as upstream but different bytes, so saying "matches
    // upstream" there would contradict its own badge.
    const note = from && to
      ? (item.status === 'current' ? ' &middot; matches upstream'
        : item.status === 'modified' ? ' &middot; same version, edited locally' : '')
      : '';
    return `<div class="otu-delta"><span class="otu-single">${esc(only)}${note}</span></div>`;
  }

  function renderDiff(result) {
    if (!result) return '';
    if (result.identical) {
      return `<pre class="otu-diff"><span class="ctx">Files are identical.</span></pre>`;
    }
    if (result.summaryOnly) {
      return `<pre class="otu-diff"><span class="head">${esc(result.note)}</span>` +
        `<span class="ctx">${result.removed} lines replaced by ${result.added} lines.</span></pre>`;
    }
    const parts = [
      `<span class="head">+${result.added}  &minus;${result.removed}${
        result.truncated ? '   (diff truncated)' : ''}</span>`,
    ];
    result.hunks.forEach((hunk, idx) => {
      if (idx > 0) parts.push('<span class="sep">   &middot;&middot;&middot;</span>');
      for (const op of hunk) {
        const cls = op.t === '+' ? 'add' : op.t === '-' ? 'del' : 'ctx';
        parts.push(`<span class="${cls}">${esc(op.t + ' ' + op.line)}</span>`);
      }
    });
    return `<pre class="otu-diff">${parts.join('')}</pre>`;
  }

  function renderItem(item, index, delay) {
    const label = STATUS_LABEL[item.status] || item.status;
    const canSelect = item.applicable;

    const actionNote = item.action === 'replace'
      ? 'Will be overwritten with the upstream file.'
      : item.recommendation === 'unbundle'
      ? 'Will be removed so Overleaf&rsquo;s own TeX Live copy is used.'
      : 'Reported only &mdash; no automatic update available.';

    const bits = [];
    if (canSelect) bits.push(`<div class="otu-note">${actionNote}</div>`);
    if (item.reason) bits.push(`<div class="otu-note"><strong>Why:</strong> ${esc(item.reason)}</div>`);
    if (item.recommendationText) {
      bits.push(`<div class="otu-note"><strong>Also an option:</strong> ${esc(item.recommendationText)}</div>`);
    }
    if (item.sizeNote) bits.push(`<div class="otu-note"><strong>Source:</strong> ${esc(item.sizeNote)}</div>`);
    if (item.fromCache !== undefined && item.newText) {
      bits.push(`<div class="otu-tag">${cacheLabel(item.fromCache)}</div>`);
    }
    if (!item.present) {
      bits.push(`<div class="otu-meta">${esc(item.statusReason)}</div>`);
    }

    return `
      <div class="otu-item" data-index="${index}" style="animation-delay:${delay}ms">
        <div class="otu-item-head">
          <input type="checkbox" ${item.selected ? 'checked' : ''} ${canSelect ? '' : 'disabled'}
                 data-role="select" aria-label="Select ${esc(item.name)}">
          <div class="otu-item-main">
            <div class="otu-file">${esc(item.name)}</div>
            ${item.present ? deltaHtml(item) : ''}
            ${bits.join('')}
          </div>
          <span class="otu-badge otu-b-${esc(item.status)}">${esc(label)}</span>
        </div>
        ${item.newText && item.localText
          ? `<div class="otu-actions">
               <button class="otu-link" data-role="diff">Show what would change</button>
             </div><div data-role="diffhost"></div>`
          : ''}
      </div>`;
  }

  /* ------------------------------------------------------------------ plan */

  const GROUPS = [
    { title: 'Needs attention', match: (i) => i.present && i.status !== 'current' },
    { title: 'Up to date', match: (i) => i.present && i.status === 'current' },
    { title: 'Not bundled in this project', match: (i) => !i.present },
  ];

  function renderPlan(plan) {
    const tpl = plan.templates.length
      ? plan.templates.map((t) => t.name).join(', ')
      : 'none recognised';

    const parts = [
      `<div class="otu-status"><strong>${esc(tpl)}</strong><br>` +
      (plan.classNames.length
        ? `<code>\\documentclass{${esc(plan.classNames.join(', '))}}</code> &middot; ` : '') +
      `${plan.files.length} files scanned &middot; nothing changed yet</div>`,
    ];

    for (const w of plan.warnings) parts.push(`<div class="otu-warn">${esc(w)}</div>`);

    if (!plan.items.length) {
      parts.push(
        `<div class="otu-warn">No known template files found. If this project uses ` +
        `a class the extension doesn&rsquo;t know yet, add it to ` +
        `<code>registry/templates.json</code>.</div>`
      );
    }

    let delay = 0;
    for (const group of GROUPS) {
      const members = plan.items
        .map((item, i) => ({ item, i }))
        .filter(({ item }) => group.match(item));
      if (!members.length) continue;
      parts.push(`<div class="otu-section">${group.title} &middot; ${members.length}</div>`);
      for (const { item, i } of members) {
        parts.push(renderItem(item, i, delay));
        delay += 28;
      }
    }

    if (plan.unclaimed && plan.unclaimed.length) {
      parts.push(
        `<div class="otu-section">Not tracked</div>` +
        `<div class="otu-status">` +
        plan.unclaimed.map((f) => `<code>${esc(f.path)}</code>`).join(' ') +
        `</div>`
      );
    }

    body().innerHTML = parts.join('');
    wireItems(plan);
    refreshApplyButton(plan);
  }

  function wireItems(plan) {
    body().querySelectorAll('.otu-item').forEach((node) => {
      const item = plan.items[Number(node.dataset.index)];

      const cb = node.querySelector('[data-role=select]');
      if (cb) cb.addEventListener('change', () => {
        item.selected = cb.checked;
        refreshApplyButton(plan);
      });

      const diffBtn = node.querySelector('[data-role=diff]');
      if (diffBtn) diffBtn.addEventListener('click', () => {
        const host = node.querySelector('[data-role=diffhost]');
        if (host.innerHTML) {
          host.innerHTML = '';
          diffBtn.textContent = 'Show what would change';
          return;
        }
        diffBtn.textContent = 'Computing…';
        setTimeout(() => {
          host.innerHTML = renderDiff(OTU.diff.compare(item.localText, item.newText));
          diffBtn.textContent = 'Hide diff';
        }, 0);
      });
    });
  }

  function refreshApplyButton(plan) {
    const n = plan.items.filter((i) => i.selected && i.applicable).length;
    setApplyEnabled(n > 0, n > 0 ? `Apply ${n} update${n === 1 ? '' : 's'}` : 'Apply updates');
  }

  /* --------------------------------------------------------------- results */

  function renderResults(results, { autoCloseIn } = {}) {
    const okCount = results.filter((r) => r.ok).length;
    const parts = [
      `<div class="otu-status"><strong>${okCount} file${okCount === 1 ? '' : 's'} updated.</strong><br>` +
      `Overleaf records every change in its History panel, so this can be reverted there.` +
      (autoCloseIn ? ` <span id="otu-countdown"></span>` : '') + `</div>`,
    ];
    for (const r of results) {
      parts.push(
        `<div class="otu-${r.ok ? 'status' : 'error'}">` +
        `<strong>${esc(r.item.name)}</strong><br>${esc(r.what)}</div>`
      );
    }
    body().innerHTML = parts.join('');
    setApplyEnabled(false, 'Apply updates');

    if (!autoCloseIn) return null;

    // Close on its own, but visibly and cancellably -- silently vanishing after
    // writing to someone's paper is worse than one extra second of feedback.
    let left = Math.ceil(autoCloseIn / 1000);
    const span = document.getElementById('otu-countdown');
    const paint = () => {
      if (!span) return;
      span.innerHTML =
        `Closing in ${left}s &middot; <button class="otu-link" id="otu-stay">stay open</button>`;
      const stay = document.getElementById('otu-stay');
      if (stay) stay.addEventListener('click', cancel);
    };
    const timer = setInterval(() => {
      if (--left <= 0) { clearInterval(timer); closePanel(); return; }
      paint();
    }, 1000);
    function cancel() {
      clearInterval(timer);
      if (span) span.textContent = '';
    }
    paint();
    return cancel;
  }

  return {
    mount, subtitle, showMessage, showSkeleton, setBusy,
    renderPlan, renderResults, closePanel, setApplyEnabled, backupWanted,
  };
})();
