/* LaTeX source parsing: which template is this, and which version of it?
 *
 * Every pattern here was checked against the real upstream files:
 *   IEEEtran.cls  ->  \ProvidesClass{IEEEtran}[2015/08/26 V1.8b by Michael Shell]
 *   llncs.cls     ->  \ProvidesClass{llncs}[2025/02/25 v2.26        <- unterminated
 *                                                                      on its line!
 *   ACM-Reference-Format.bst -> %%%  version = "2.2",
 *                               %%%  acmart-version = "2.19",
 *
 * The llncs case is the reason the option-group regex must be allowed to span
 * newlines: a line-anchored pattern silently reports "unknown version" there. */
var OTU = (typeof OTU !== 'undefined' && OTU) || {};

OTU.latex = (function () {
  'use strict';

  /** True if the character at `index` sits after an unescaped % on its line. */
  function isCommented(text, index) {
    let lineStart = text.lastIndexOf('\n', index - 1) + 1;
    for (let i = lineStart; i < index; i++) {
      if (text[i] === '%') {
        // count preceding backslashes; an odd number escapes the %
        let bs = 0, j = i - 1;
        while (j >= lineStart && text[j] === '\\') { bs++; j--; }
        if (bs % 2 === 0) return true;
      }
    }
    return false;
  }

  /** Pull a version + date out of a \ProvidesX option group. */
  function parseVersionInfo(options) {
    const info = { version: null, date: null, raw: (options || '').trim() };
    if (!options) return info;

    const dateMatch = options.match(/\b(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})\b/);
    if (dateMatch) {
      info.date = dateMatch[1] + '-' +
        dateMatch[2].padStart(2, '0') + '-' + dateMatch[3].padStart(2, '0');
    }

    // "v2.26", "V1.8b", "v. 3.5" -- prefer an explicitly v-marked version.
    let m = options.match(/\bv\.?\s*(\d+(?:\.\d+)*[a-z]?)\b/i);
    if (!m) {
      // Otherwise take a bare dotted number that is not part of the date.
      const stripped = dateMatch ? options.replace(dateMatch[0], ' ') : options;
      m = stripped.match(/\b(\d+\.\d+(?:\.\d+)*[a-z]?)\b/);
    }
    if (m) info.version = m[1];

    return info;
  }

  /** Parse \ProvidesClass / \ProvidesPackage / \ProvidesFile. */
  function parseProvides(text) {
    const re = /\\Provides(Class|Package|File)\s*\{([^}]*)\}\s*(?:\[([^\]]*)\])?/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (isCommented(text, m.index)) continue;
      return Object.assign(
        {
          kind: m[1].toLowerCase(),
          name: m[2].trim(),
        },
        parseVersionInfo(m[3])
      );
    }
    return null;
  }

  /** Parse the first uncommented \documentclass. */
  function parseDocumentClass(text) {
    const re = /\\documentclass\s*(?:\[([^\]]*)\])?\s*\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (isCommented(text, m.index)) continue;
      return {
        name: m[2].trim(),
        options: (m[1] || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      };
    }
    return null;
  }

  /** BibTeX .bst files carry a mail-header style block instead of \ProvidesX. */
  function parseBstHeader(text) {
    const head = text.slice(0, 20000);
    const out = { version: null, date: null, related: {}, raw: null };

    const v = head.match(/^%+\s*version\s*=\s*"([^"]+)"/mi);
    if (v) { out.version = v[1].trim(); out.raw = v[0].trim(); }

    const d = head.match(/^%+\s*date\s*=\s*"([^"]+)"/mi);
    if (d) out.date = d[1].trim();

    // e.g. acmart-version = "2.19" -- tells us which class this .bst pairs with.
    const rel = head.matchAll(/^%+\s*([a-z0-9]+)-version\s*=\s*"([^"]+)"/gmi);
    for (const r of rel) out.related[r[1].toLowerCase()] = r[2].trim();

    return out.version || out.date ? out : null;
  }

  /** Last resort: scan leading comments for something version-shaped. */
  function parseCommentVersion(text) {
    const head = text.split('\n').slice(0, 80).join('\n');
    const m =
      head.match(/\bversion\s+v?\.?\s*(\d+(?:\.\d+)+[a-z]?)/i) ||
      head.match(/\bv(\d+\.\d+(?:\.\d+)*[a-z]?)\b/);
    if (!m) return null;
    const info = parseVersionInfo(m[0]);
    info.version = info.version || m[1];
    const d = head.match(/\b(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})\b/);
    if (d && !info.date) {
      info.date = d[1] + '-' + d[2].padStart(2, '0') + '-' + d[3].padStart(2, '0');
    }
    return info;
  }

  /**
   * Best-effort version read for any template asset, dispatching on the
   * strategy the registry declared for that file.
   * @returns {{version:?string, date:?string, source:string, related?:object}}
   */
  function readVersion(text, strategy) {
    if (strategy === 'bst-header' || strategy === 'comment-scan') {
      const bst = parseBstHeader(text);
      if (bst) return { ...bst, source: 'bst-header' };
      const c = parseCommentVersion(text);
      if (c) return { ...c, source: 'comment-scan' };
      return { version: null, date: null, source: 'none' };
    }

    const p = parseProvides(text);
    if (p) return { version: p.version, date: p.date, name: p.name, source: 'provides' };

    const bst = parseBstHeader(text);
    if (bst) return { ...bst, source: 'bst-header' };

    const c = parseCommentVersion(text);
    if (c) return { ...c, source: 'comment-scan' };

    return { version: null, date: null, source: 'none' };
  }

  /** Split a .tex file into (preamble, body) at \begin{document}. */
  function splitPreamble(text) {
    const m = /\\begin\s*\{document\}/.exec(text);
    if (!m) return { preamble: text, body: '', hasDocument: false };
    return {
      preamble: text.slice(0, m.index),
      body: text.slice(m.index),
      hasDocument: true,
    };
  }

  const TEMPLATE_ASSET_EXTS = new Set(['.cls', '.sty', '.bst', '.clo', '.def']);

  function isTemplateAsset(path) {
    return TEMPLATE_ASSET_EXTS.has(OTU.util.extname(path));
  }

  return {
    parseProvides, parseDocumentClass, parseBstHeader, parseCommentVersion,
    parseVersionInfo, readVersion, splitPreamble, isTemplateAsset, isCommented,
  };
})();
