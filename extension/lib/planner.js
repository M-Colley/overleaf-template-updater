/* Scan a project, work out what is stale, and build a plan.
 *
 * Design rule: this tool only ever touches *template machinery* -- .cls, .sty,
 * .bst. It never rewrites a .tex file, because that is where the author's paper
 * lives and no version heuristic is worth the risk of clobbering it. Drift in
 * your preamble is reported, not "fixed". */
var OTU = (typeof OTU !== 'undefined' && OTU) || {};

OTU.planner = (function () {
  'use strict';

  const { util, latex, version: ver } = OTU;

  async function loadRegistry() {
    const url = chrome.runtime.getURL('registry/templates.json');
    const res = await fetch(url);
    if (!res.ok) throw new Error('Could not load the bundled template registry.');
    return res.json();
  }

  /** Read the project zip into an inventory of decoded files. */
  async function buildInventory(onProgress) {
    onProgress && onProgress('Downloading project…');
    const zipBuf = await OTU.overleaf.downloadProjectZip();

    onProgress && onProgress('Unpacking project…');
    let entries = await OTU.unzip.read(zipBuf);
    entries = util.normalizeZipPaths(entries);

    const files = [];
    for (const e of entries) {
      const ext = util.extname(e.name);
      const isText = ['.tex', '.cls', '.sty', '.bst', '.bib', '.bbx', '.cbx',
        '.clo', '.def', '.txt', '.md'].includes(ext);
      files.push({
        path: e.name,
        base: util.basename(e.name),
        ext,
        size: e.size,
        bytes: e.bytes,
        text: isText ? util.bytesToText(e.bytes) : null,
      });
    }
    return files;
  }

  /** Which templates does this project appear to use? */
  function detectTemplates(files, registry) {
    const hits = new Map();

    const classNames = new Set();
    for (const f of files) {
      if (f.ext === '.tex' && f.text) {
        const dc = latex.parseDocumentClass(f.text);
        if (dc) classNames.add(dc.name);
      }
    }

    for (const t of registry.templates) {
      const byClass = (t.detect.documentclass || []).some((c) => classNames.has(c));
      const byFile = (t.detect.files || []).some((n) =>
        files.some((f) => f.base.toLowerCase() === n.toLowerCase())
      );
      if (byClass || byFile) {
        hits.set(t.id, { template: t, byClass, byFile });
      }
    }

    return { hits: [...hits.values()], classNames: [...classNames] };
  }

  /** Locate a registry file inside the project, preferring the root copy. */
  function findInProject(files, name) {
    const lower = name.toLowerCase();
    const matches = files.filter((f) => f.base.toLowerCase() === lower);
    if (!matches.length) return null;
    matches.sort((a, b) => a.path.split('/').length - b.path.split('/').length);
    return matches[0];
  }

  /**
   * A file's `source` is either inline ({kind:'raw', url}) or a `ref` into the
   * registry's shared `sources` block, which is how several files can come out
   * of one big archive that is downloaded and cached once.
   */
  function resolveSource(source, registry) {
    if (!source) return null;
    if (source.ref) {
      const shared = (registry.sources || {})[source.ref];
      if (!shared) throw new Error(`Registry references unknown source "${source.ref}"`);
      return { ...shared, member: source.member || shared.member };
    }
    return source;
  }

  /**
   * Every other tracked file that comes out of the same archive. Passing these
   * along means one 15 MB download caches all seven acmart files at once, so
   * the next project needs no network at all.
   */
  function siblingMembers(registry, ref) {
    const out = new Set();
    for (const t of registry.templates) {
      for (const f of t.files) {
        if (f.source && f.source.ref === ref && f.source.member) {
          out.add(f.source.member);
        }
      }
    }
    return [...out];
  }

  /**
   * Fetch a file's upstream content, whatever kind of source it comes from.
   * `expectedVersion` is the version the package index reports; when the cached
   * copy already carries it, the fetch is skipped entirely.
   * @returns {Promise<{text:string, cached:false|'version'|'ttl'|'revalidated'}>}
   */
  async function fetchSourceText(resolved, opts = {}) {
    if (resolved.kind === 'raw') {
      const res = await util.bg('fetchText', {
        url: resolved.url,
        mirrors: resolved.mirrors,
        expectName: opts.expectName,
        expectedVersion: opts.expectedVersion,
        versionFrom: opts.versionFrom,
      });
      return { text: res.text, cached: res.cached };
    }
    if (resolved.kind === 'zip') {
      const res = await util.bg('fetchZipMember', {
        url: resolved.url,
        member: resolved.member,
        expectName: opts.expectName,
        expectedVersion: opts.expectedVersion,
        versionFrom: opts.versionFrom,
        alsoCache: opts.alsoCache,
      });
      return { text: res.text, cached: res.cached };
    }
    throw new Error(`Unsupported source kind "${resolved.kind}"`);
  }

  async function fetchUpstreamVersion(spec, cache) {
    if (!spec) return null;
    if (spec.kind === 'ctan') {
      const key = 'ctan:' + spec.pkg;
      if (!cache.has(key)) cache.set(key, util.bg('ctanPackage', { pkg: spec.pkg }));
      const res = await cache.get(key);
      return res.version && res.version.number
        ? { version: res.version.number, date: res.version.date, from: 'CTAN' }
        : null;
    }
    return null;
  }

  /**
   * Build the full plan. Nothing here writes to the project.
   * @returns {Promise<{items:Array, templates:Array, warnings:Array, files:Array}>}
   */
  async function scan(onProgress) {
    const registry = await loadRegistry();
    const files = await buildInventory(onProgress);

    onProgress && onProgress('Identifying template…');
    const { hits, classNames } = detectTemplates(files, registry);

    const items = [];
    const warnings = [];
    const cache = new Map();
    const claimed = new Set();

    for (const { template } of hits) {
      for (const spec of template.files) {
        claimed.add(spec.name.toLowerCase());
        const local = findInProject(files, spec.name);

        const item = {
          templateId: template.id,
          templateName: template.name,
          homepage: template.homepage,
          name: spec.name,
          action: spec.action,
          reason: spec.reason || null,
          recommendation: spec.recommendation || null,
          recommendationText: spec.recommendationText || null,
          present: !!local,
          projectPath: local ? local.path : null,
          projectEntrySize: local ? local.size : null,
          local: null,
          upstream: null,
          status: 'unknown',
          statusReason: '',
          newText: null,
          selected: false,
          applicable: false,
        };

        if (local && local.text) {
          item.local = latex.readVersion(local.text, spec.versionFrom);
          item.localText = local.text;
          item.localSha = await util.sha256Hex(local.bytes);
        }

        onProgress && onProgress(`Checking ${spec.name} upstream…`);

        try {
          const resolved = resolveSource(spec.source, registry);

          // The package index lookup is small and fast, and its version doubles
          // as the cache tag: if the cached file already reports it, no
          // download happens at all.
          const declared = await fetchUpstreamVersion(
            template.upstream && template.upstream.version, cache
          ).catch(() => null);

          // Only pay for the download if the file is actually in the project.
          if (spec.action === 'replace' && resolved && item.present) {
            item.sizeNote = resolved.sizeNote || null;
            if (resolved.sizeNote) {
              onProgress && onProgress(`Fetching ${spec.name}…`);
            }
            const res = await fetchSourceText(resolved, {
              // Only this template's primary class shares the package's version
              // number; a .bst has its own scheme, so tagging it would be wrong.
              expectedVersion: spec.versionTracksPackage && declared
                ? declared.version : null,
              versionFrom: spec.versionFrom,
              expectName: spec.expectName,
              alsoCache: spec.source && spec.source.ref
                ? siblingMembers(registry, spec.source.ref) : undefined,
            });
            item.newText = res.text;
            item.fromCache = res.cached || false;
            item.upstream = latex.readVersion(res.text, spec.versionFrom);
            item.upstream.from = resolved.url;
            item.upstreamSha = await util.sha256Hex(util.textToBytes(res.text));
          } else {
            item.upstream = declared;
          }
        } catch (err) {
          warnings.push(`Could not reach upstream for ${spec.name}: ${err.message}`);
        }

        // Decide status.
        if (!item.present) {
          item.status = 'absent';
          item.statusReason =
            'Not bundled in this project — Overleaf’s own TeX Live supplies it.';
        } else if (item.localSha && item.upstreamSha && item.localSha === item.upstreamSha) {
          item.status = 'current';
          item.statusReason = 'Byte-identical to upstream.';
        } else {
          const verdict = ver.assess(item.local, item.upstream);
          item.status = verdict.status;
          item.statusReason = verdict.reason;
          if (verdict.status === 'current' && item.localSha && item.upstreamSha) {
            item.status = 'modified';
            item.statusReason =
              'Same version as upstream, but the file content differs — ' +
              'it looks locally patched.';
          }
        }

        item.applicable =
          (spec.action === 'replace' && item.present && !!item.newText &&
            ['outdated', 'unknown', 'modified'].includes(item.status)) ||
          (spec.recommendation === 'unbundle' && item.present &&
            ['outdated', 'unknown'].includes(item.status));

        item.selected = item.applicable && item.status === 'outdated';
        items.push(item);
      }
    }

    // Consistency check: ACM-Reference-Format.bst records the acmart release it
    // was built against, so a mismatch is detectable even without a .cls update.
    const bst = items.find((i) => i.name === 'ACM-Reference-Format.bst' && i.local);
    const cls = items.find((i) => i.name === 'acmart.cls' && i.local);
    if (bst && cls && bst.local.related && bst.local.related.acmart && cls.local.version) {
      const c = ver.compare(cls.local.version, bst.local.related.acmart);
      if (c !== null && c !== 0) {
        warnings.push(
          `Mismatch: your ACM-Reference-Format.bst was built for acmart ` +
          `v${bst.local.related.acmart}, but your acmart.cls is v${cls.local.version}. ` +
          `Bibliography formatting may not match the class.`
        );
      }
    }

    // Anything class-shaped we do not have a registry entry for.
    const unclaimed = files.filter(
      (f) => latex.isTemplateAsset(f.path) && !claimed.has(f.base.toLowerCase())
    );

    return { items, templates: hits.map((h) => h.template), classNames, warnings, files, unclaimed };
  }

  /**
   * Apply the selected items. Returns a per-item result log.
   * Requires the entity tree (for folder ids), fetched here rather than during
   * scan so a read-only scan never opens a socket it does not need.
   */
  async function apply(items, onProgress) {
    const selected = items.filter((i) => i.selected && i.applicable);
    if (!selected.length) return [];

    onProgress && onProgress('Reading project file tree…');
    const root = await OTU.overleaf.getFileTree();
    const { byPath } = OTU.overleaf.flattenTree(root);

    const results = [];
    for (const item of selected) {
      try {
        const entry = byPath.get(item.projectPath);
        if (!entry) {
          throw new Error(
            `Could not locate "${item.projectPath}" in the project tree ` +
            `(was it renamed or deleted since the scan?)`
          );
        }

        if (item.action === 'replace') {
          onProgress && onProgress(`Updating ${item.name}…`);
          await OTU.overleaf.uploadFile(
            entry.folderId, entry.name, OTU.util.textToBytes(item.newText)
          );
          results.push({
            item, ok: true,
            what: `Replaced with upstream ${item.upstream && item.upstream.version
              ? 'v' + item.upstream.version : 'latest'}`,
          });
        } else if (item.recommendation === 'unbundle') {
          onProgress && onProgress(`Removing bundled ${item.name}…`);
          await OTU.overleaf.deleteEntity(entry.type, entry.id);
          results.push({
            item, ok: true,
            what: 'Removed the bundled copy so Overleaf’s TeX Live version applies',
          });
        } else {
          results.push({ item, ok: false, what: 'No applicable action' });
        }
      } catch (err) {
        results.push({ item, ok: false, what: err.message });
      }
    }
    return results;
  }

  return { scan, apply, loadRegistry, buildInventory, detectTemplates };
})();
