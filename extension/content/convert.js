/* The "Convert venue" tab.
 *
 * Runs the exact same venue profiles the CLI uses. They live under
 * lib/venues/ as ES modules, so this pulls them in with a dynamic import of an
 * extension URL rather than duplicating any of the mapping logic — a conversion
 * behaves identically whether you ran it in a terminal or clicked it here.
 *
 * The safety model is the CLI's, unchanged: the conversion writes a NEW file
 * into the project and never modifies the source. That is what makes it safe to
 * do this to a .tex at all, given the updater's standing promise never to
 * rewrite one. */
var OTU = (typeof OTU !== 'undefined' && OTU) || {};

OTU.convert = (function () {
  'use strict';

  let modulesPromise = null;

  /** Load the shared venue profiles once per page. */
  function venues() {
    if (!modulesPromise) {
      modulesPromise = import(chrome.runtime.getURL('lib/venues/index.js'))
        .catch((err) => {
          modulesPromise = null;
          throw new Error(
            'Could not load the venue profiles: ' + err.message +
            '. They must be listed in web_accessible_resources.'
          );
        });
    }
    return modulesPromise;
  }

  /** Every .tex in the project that actually starts a document. */
  async function candidates(files) {
    const { documentClass } = await venues();
    const out = [];
    for (const f of files) {
      if (f.ext !== '.tex' || !f.text) continue;
      const cls = documentClass(f.text);
      if (!cls) continue;
      out.push({ file: f, className: cls.name });
    }
    // A root-level main.tex is nearly always the one you mean.
    out.sort((a, b) => {
      const depth = a.file.path.split('/').length - b.file.path.split('/').length;
      if (depth) return depth;
      const main = (x) => (/^main\.tex$/i.test(x.file.base) ? 0 : 1);
      return main(a) - main(b);
    });
    return out;
  }

  /** Which venues this document could be converted to. */
  async function targetsFor(className) {
    const { VENUES, detectVenue } = await venues();
    const source = detectVenue(className);
    return {
      source,
      targets: source ? VENUES.filter((v) => v.id !== source.id) : [],
      // Named from the registry itself, so the list can never go stale.
      known: VENUES.map((v) => v.name),
    };
  }

  /**
   * Convert one file. Nothing is written; this only produces the text.
   * @returns {Promise<{text, report, outName, sourceVenue, targetVenue}>}
   */
  async function run(entry, targetId) {
    const { Report, detectVenue, venueById } = await venues();

    const source = detectVenue(entry.className);
    if (!source) throw new Error(`\\documentclass{${entry.className}} is not a known venue.`);
    const target = venueById(targetId);
    if (!target) throw new Error(`Unknown target venue "${targetId}".`);
    if (source.id === target.id) throw new Error('Source and target are the same venue.');

    const report = new Report();
    const ir = source.parse(entry.file.text, report);

    if (!ir.title) report.warn('No \\title was found in the source.');
    if (!ir.authors.length) report.warn('No \\author was found in the source.');
    if (/\\begin\s*\{(figure|table)\*\}/.test(ir.body)) {
      report.warn('The body uses full-width `figure*`/`table*` floats. Column ' +
        'layouts differ between these templates, so check they still fit.');
    }

    const text = target.emit(ir, report);

    const dir = OTU.util.dirname(entry.file.path);
    const stem = entry.file.base.replace(/\.tex$/i, '');
    const name = `${stem}-${target.id}.tex`;

    return {
      text,
      report,
      outName: name,
      outPath: dir ? `${dir}/${name}` : name,
      sourceVenue: source,
      targetVenue: target,
    };
  }

  /**
   * Write the converted file into the project, alongside its source.
   * Creates a new file; never touches the original.
   */
  async function apply(result, sourcePath, onProgress) {
    onProgress && onProgress('Reading project file tree…');
    const root = await OTU.overleaf.getFileTree();
    const { byPath } = OTU.overleaf.flattenTree(root);

    const source = byPath.get(sourcePath);
    if (!source) {
      throw new Error(
        `Could not locate "${sourcePath}" in the project tree ` +
        `(was it renamed since the scan?)`
      );
    }

    onProgress && onProgress(`Creating ${result.outName}…`);
    await OTU.overleaf.uploadFile(
      source.folderId, result.outName, OTU.util.textToBytes(result.text)
    );

    return { created: result.outPath, replaced: byPath.has(result.outPath) };
  }

  /** Does a file of that name already exist? Answered from the scan, not the socket. */
  function existsInProject(files, outPath) {
    return files.some((f) => f.path === outPath);
  }

  return { venues, candidates, targetsFor, run, apply, existsInProject };
})();
