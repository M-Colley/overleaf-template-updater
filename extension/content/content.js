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
    if (tab === 'convert') return openTab('convert');
    if (!plan) scan();
  }

  function rescan() { scan(); }

  /* ------------------------------------------------------- convert venue */

  let tab = 'update';
  let conv = null;

  function freshConvertState() {
    return {
      entries: null, selectedPath: null, className: null,
      source: null, targets: [], targetId: null,
      result: null, error: null, exists: false,
    };
  }

  /** The project inventory, reusing the update scan's copy if there is one. */
  async function inventory() {
    if (plan && plan.files) return plan.files;
    if (conv && conv.files) return conv.files;
    const files = await OTU.planner.buildInventory((m) => OTU.ui.subtitle(m));
    conv.files = files;
    return files;
  }

  async function openTab(name) {
    tab = name;
    OTU.ui.setTab(name);

    if (name === 'update') {
      if (plan) OTU.ui.renderPlan(plan);
      else scan();
      return;
    }

    if (!conv) conv = freshConvertState();
    if (conv.entries) return OTU.ui.renderConvert(conv);

    OTU.ui.setBusy(true);
    OTU.ui.showSkeleton();
    try {
      const files = await inventory();
      conv.files = files;
      conv.entries = await OTU.convert.candidates(files);
      if (conv.entries.length) await selectConvertSource(conv.entries[0].file.path);
      else OTU.ui.renderConvert(conv);
      OTU.ui.subtitle('convert venue');
    } catch (err) {
      console.error('[Template Updater] convert setup failed', err);
      conv.error = err.message;
      OTU.ui.renderConvert(conv);
    } finally {
      OTU.ui.setBusy(false);
    }
  }

  async function selectConvertSource(path) {
    const entry = conv.entries.find((e) => e.file.path === path);
    if (!entry) return;

    conv.selectedPath = path;
    conv.className = entry.className;
    conv.result = null;
    conv.targetId = null;
    conv.exists = false;

    const { source, targets } = await OTU.convert.targetsFor(entry.className);
    conv.source = source;
    conv.targets = targets;
    OTU.ui.renderConvert(conv);
  }

  async function selectConvertTarget(venueId) {
    const entry = conv.entries.find((e) => e.file.path === conv.selectedPath);
    if (!entry) return;

    conv.targetId = venueId;
    OTU.ui.setBusy(true);
    try {
      conv.result = await OTU.convert.run(entry, venueId);
      conv.exists = OTU.convert.existsInProject(conv.files, conv.result.outPath);
      conv.error = null;
    } catch (err) {
      console.error('[Template Updater] convert failed', err);
      conv.result = null;
      conv.error = err.message;
    } finally {
      OTU.ui.setBusy(false);
    }
    OTU.ui.renderConvert(conv);
  }

  async function applyConvert() {
    if (!conv || !conv.result) return;

    // Creating a file is additive, so it needs no confirmation. Replacing an
    // existing one does.
    if (conv.exists && !window.confirm(
      `${conv.result.outPath} already exists and will be replaced.\n\n` +
      `Overleaf keeps the previous version in its History panel, so this can ` +
      `be undone there. Continue?`
    )) return;

    OTU.ui.setConvertEnabled(false, 'Creating…');
    OTU.ui.setBusy(true);
    try {
      await OTU.convert.apply(conv.result, conv.selectedPath, (m) => OTU.ui.subtitle(m));
      OTU.ui.subtitle('created');
      OTU.ui.renderConvertResult(conv.result, conv.result.outPath);
      plan = null;   // the project gained a file; the update scan is stale
      conv.files = null;
      conv.entries = null;
    } catch (err) {
      console.error('[Template Updater] convert apply failed', err);
      OTU.ui.subtitle('Failed');
      OTU.ui.showMessage('error', `Could not create the file: ${err.message}`);
    } finally {
      OTU.ui.setBusy(false);
    }
  }

  function resetConvert() {
    const files = conv && conv.files;
    conv = freshConvertState();
    conv.files = files;
    openTab('convert');
  }

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
      conv = null;
      tab = 'update';
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

  return {
    onOpen, rescan, applySelected, scan, openPanel,
    openTab, selectConvertSource, selectConvertTarget, applyConvert, resetConvert,
  };
})();
