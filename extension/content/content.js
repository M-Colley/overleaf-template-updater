/* Entry point. Mounts the launcher, drives scan -> review -> apply.
 *
 * Nothing writes to the project until the user clicks Apply: the scan is a
 * read-only zip download plus upstream lookups. */
var OTU = (typeof OTU !== 'undefined' && OTU) || {};

OTU.content = (function () {
  'use strict';

  let plan = null;
  let scanning = false;

  function ready() {
    return !!OTU.overleaf.projectId();
  }

  async function scan() {
    if (scanning) return;
    scanning = true;
    plan = null;
    OTU.ui.setApplyEnabled(false);
    OTU.ui.setBusy(true);
    OTU.ui.showSkeleton();

    try {
      plan = await OTU.planner.scan((msg) => OTU.ui.subtitle(msg));
      OTU.ui.subtitle(
        plan.templates.length
          ? plan.templates.map((t) => t.id).join(', ')
          : 'no known template detected'
      );
      OTU.ui.renderPlan(plan);
    } catch (err) {
      console.error('[Template Updater] scan failed', err);
      OTU.ui.subtitle('Scan failed');
      OTU.ui.showMessage(
        'error',
        `Scan failed: ${err.message}\n\n` +
        `This extension talks to Overleaf's internal, unversioned endpoints. ` +
        `If Overleaf changed them, the project page may simply need a reload — ` +
        `or the endpoint in lib/overleaf.js needs updating.`
      );
    } finally {
      scanning = false;
      OTU.ui.setBusy(false);
    }
  }

  async function applySelected() {
    if (!plan) return;
    const chosen = plan.items.filter((i) => i.selected && i.applicable);
    if (!chosen.length) return;

    // The panel already lists every file with a checkbox, so a second dialog
    // repeating the same list is just friction. Keep it only for deletions,
    // which remove a file outright rather than superseding it.
    const deletions = chosen.filter((i) => i.action !== 'replace');
    if (deletions.length) {
      const names = deletions.map((i) => `  • ${i.name}`).join('\n');
      if (!window.confirm(
        `This will DELETE ${deletions.length} file${deletions.length === 1 ? '' : 's'} ` +
        `from the project:\n\n${names}\n\n` +
        `Overleaf records deletions in its History panel, so this can be undone there.`
      )) return;
    }

    OTU.ui.setApplyEnabled(false, 'Applying…');
    OTU.ui.setBusy(true);

    try {
      if (OTU.ui.backupWanted()) {
        OTU.ui.subtitle('Downloading backup…');
        const id = OTU.overleaf.projectId();
        await OTU.util.bg('backupProject', {
          projectId: id,
          filename: `overleaf-backup-${id}-${OTU.util.timestampSlug()}.zip`,
        });
      }

      const results = await OTU.planner.apply(plan.items, (m) => OTU.ui.subtitle(m));
      const allOk = results.length > 0 && results.every((r) => r.ok);
      OTU.ui.subtitle(allOk ? 'Applied' : 'Applied with errors');

      // Close on success; stay open on failure so the error can be read.
      const { autoClose = true } = await chrome.storage.sync.get('autoClose')
        .catch(() => ({}));
      OTU.ui.renderResults(results, {
        autoCloseIn: allOk && autoClose ? 4000 : 0,
      });
      plan = null; // the project changed; force a fresh scan next time
    } catch (err) {
      console.error('[Template Updater] apply failed', err);
      OTU.ui.subtitle('Apply failed');
      OTU.ui.showMessage('error', `Apply failed: ${err.message}`);
    } finally {
      OTU.ui.setBusy(false);
    }
  }

  function onOpen() {
    if (!plan) scan();
  }

  function rescan() { scan(); }

  /** Open the panel from the toolbar popup. */
  function openPanel() {
    OTU.ui.mount();
    const root = document.getElementById('otu-root');
    const launch = document.getElementById('otu-launch');
    if (root) root.hidden = false;
    if (launch) launch.hidden = true;
    onOpen();
  }

  // Overleaf is a single-page app: you can land on the dashboard and route into
  // a project without a page load, so this keeps watching rather than giving up
  // after a fixed number of tries. It also notices when you switch projects.
  let mountedFor = null;
  setInterval(() => {
    const id = OTU.overleaf.projectId();
    if (id && id !== mountedFor) {
      mountedFor = id;
      plan = null;              // a different project needs a fresh scan
      OTU.ui.mount();
    } else if (!id && mountedFor) {
      mountedFor = null;        // navigated back out to the dashboard
    }
  }, 1000);

  // Answer the toolbar popup. Registered unconditionally so the popup can tell
  // "running here, no project open" apart from "not injected at all".
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return false;
    if (msg.type === 'otu-ping') {
      sendResponse({ ok: true, projectId: OTU.overleaf.projectId(), mounted: !!mountedFor });
      return false;
    }
    if (msg.type === 'otu-open') {
      openPanel();
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  return { onOpen, rescan, applySelected, scan, openPanel };
})();
