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
 * newlines: a line-anchored pattern silently reports "unknown version" there.
 *
 * Just as common, it turned out, is a declaration that names no version at all
 * and points at macros instead:
 *   elsarticle.cls -> \def\RCSversion{3.5}  \def\@shortjid{elsarticle}
 *                     \ProvidesClass{\@shortjid}[\RCSdate, \RCSversion: \@journal]
 *   asmeconf.cls   -> \def\versionno{1.46}
 *                     \ProvidesClass{asmeconf}[\versiondate ASME Conference ...]
 *   ceurart.cls    -> \ProvidesExplClass{\RCSfile}{\RCSdate}{\RCSversion}{...}
 * Read literally, every one of those is "unknown version", and the first fails
 * an expectName check outright -- so simple parameterless macros are expanded. */
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
    } else {
      // cvpr.sty is versioned by edition alone: [2026 LaTeX class for IEEE CVPR].
      // A leading bare year still orders correctly against another one.
      const year = options.match(/^\s*((?:19|20)\d{2})(?![\d/\-.])/);
      if (year) info.date = year[1];
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

  /* ------------------------------------------------- macro-indirected headers */

  /** Skip whitespace and %-comments, which may sit between macro arguments. */
  function skipBlank(text, i) {
    for (;;) {
      while (i < text.length && /\s/.test(text[i])) i++;
      if (text[i] !== '%') return i;
      const nl = text.indexOf('\n', i);
      if (nl < 0) return text.length;
      i = nl + 1;
    }
  }

  /** Read a balanced group delimited by `open`/`close` at `from`, or null. */
  function readDelimited(text, from, open, close) {
    const i = skipBlank(text, from);
    if (text[i] !== open) return null;
    let depth = 0;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (c === '\\') { j++; continue; }
      if (c === open) depth++;
      else if (c === close && --depth === 0) {
        return { value: text.slice(i + 1, j), end: j + 1 };
      }
    }
    return null;
  }

  /**
   * Every parameterless macro definition in the file:
   *   \def\x{..}  \edef  \gdef  \xdef
   *   \newcommand\x{..}  \newcommand{\x}{..}  \providecommand  \renewcommand
   * A definition with parameters (\def\x#1{..}, \newcommand\x[1]{..}) is code,
   * not data, and is skipped.
   * @returns {Map<string, Array<{index:number, value:string}>>}
   */
  function macroDefinitions(text) {
    const defs = new Map();
    const add = (name, index, value) => {
      if (!defs.has(name)) defs.set(name, []);
      defs.get(name).push({ index, value });
    };

    const def = /\\[egx]?def\s*\\([A-Za-z@]+)(?![A-Za-z@])/g;
    let m;
    while ((m = def.exec(text)) !== null) {
      if (isCommented(text, m.index)) continue;
      // Only a brace right after the name: anything else is a parameter text.
      let i = m.index + m[0].length;
      while (i < text.length && /[ \t]/.test(text[i])) i++;
      if (text[i] !== '{') continue;
      const g = readDelimited(text, i, '{', '}');
      if (g) add(m[1], m.index, g.value);
    }

    const cmd = /\\(?:new|renew|provide)command\*?\s*(?:\{\s*\\([A-Za-z@]+)\s*\}|\\([A-Za-z@]+)(?![A-Za-z@]))/g;
    while ((m = cmd.exec(text)) !== null) {
      if (isCommented(text, m.index)) continue;
      const after = skipBlank(text, m.index + m[0].length);
      if (text[after] !== '{') continue; // takes arguments
      const g = readDelimited(text, after, '{', '}');
      if (g) add(m[1] || m[2], m.index, g.value);
    }
    return defs;
  }

  /** The definition in force at `at`: the last one before it, else the first. */
  function definitionAt(defs, name, at) {
    const list = defs.get(name);
    if (!list) return null;
    let best = null;
    for (const d of list) if (d.index < at) best = d;
    return (best || list[0]).value;
  }

  /**
   * Expand parameterless macros in a short string. Anything without a simple
   * definition is left in place, and depth is bounded so a self-referential
   * definition cannot hang a scan.
   *
   * Deliberately NOT faithful to TeX in one respect. TeX swallows the space
   * after a control word, so jacow.cls's [\filedate\space v\fileversion fixes]
   * really does typeset as "v2.7fixes" -- and a version regex reading that
   * finds "2", not "2.7". This is extracting data, not typesetting, so every
   * expansion is padded to keep it a separate token.
   */
  function expandMacros(s, defs, at) {
    let out = String(s);
    for (let depth = 0; depth < 6; depth++) {
      let changed = false;
      out = out.replace(/\\(?:([A-Za-z@]+)|( ))/g, (whole, name, space) => {
        if (space || name === 'space') { changed = true; return ' '; }
        const v = definitionAt(defs, name, at);
        if (v === null) return whole;
        changed = true;
        return ' ' + v + ' ';
      });
      if (!changed) break;
    }
    return out.replace(/\s+/g, ' ');
  }

  // Macro names that conventionally hold a file's own version or date
  // (\fileversion, \versionno, \RCSversion, \@version, \iscram@version ...),
  // excluding the engine and format versions a class may also record.
  const VERSION_MACRO = /version(?:no|number)?$/i;
  const DATE_MACRO = /(?:file|release|version|rcs|modified)@?date$/i;
  const NOT_OURS = /pdf|latex|tex(?:live)?version|bib/i;

  /**
   * Fallback for declarations that leave the version out of the option group
   * entirely: asmeconf.cls says [\versiondate ASME Conference Paper ...] and
   * keeps the number in \versionno, iacrj.cls says just [\filedate].
   * Only definitions before `at` count -- a class names its own version before
   * it declares itself; later \def's of that shape are something else.
   */
  function versionFromMacros(defs, at) {
    const pick = (re) => {
      let best = null;
      for (const [name, list] of defs) {
        if (!re.test(name) || NOT_OURS.test(name)) continue;
        for (const d of list) {
          if (d.index < at && (!best || d.index > best.index)) best = { name, ...d };
        }
      }
      return best;
    };
    const info = { version: null, date: null };

    const v = pick(VERSION_MACRO);
    if (v) {
      const m = expandMacros(v.value, defs, v.index).trim()
        .match(/^v?\.?\s*(\d+(?:\.\d+)+[a-z]?)$/i);
      if (m) info.version = m[1];
    }
    const d = pick(DATE_MACRO);
    if (d) info.date = parseVersionInfo(expandMacros(d.value, defs, d.index)).date;
    return info;
  }

  /**
   * Parse \ProvidesClass / \ProvidesPackage / \ProvidesFile, and the expl3
   * \ProvidesExplClass{name}{date}{version}{description} family.
   */
  function parseProvides(text) {
    const re = /\\Provides(Expl)?(Class|Package|File)(?![A-Za-z@])/g;
    let m, defs = null;
    while ((m = re.exec(text)) !== null) {
      if (isCommented(text, m.index)) continue;

      const name = readDelimited(text, m.index + m[0].length, '{', '}');
      if (!name) continue;

      // expl3 declarations carry date and version as separate arguments; they
      // are expanded one at a time and then joined, so neither can run into
      // the other.
      let parts;
      if (m[1]) {
        const date = readDelimited(text, name.end, '{', '}');
        const version = date && readDelimited(text, date.end, '{', '}');
        parts = date && version ? [date.value, version.value] : null;
      } else {
        const opt = readDelimited(text, name.end, '[', ']');
        parts = opt ? [opt.value] : null;
      }

      const literal = name.value.trim();
      const indirect = /\\[A-Za-z@]/.test(literal + (parts || []).join(''));
      if (indirect && !defs) defs = macroDefinitions(text);
      const expand = (s) => (indirect ? expandMacros(s, defs, m.index) : s);

      const resolvedName = expand(literal).trim();
      let options = null;
      if (parts && m[1]) {
        options = `${expand(parts[0]).trim()} v${expand(parts[1]).trim().replace(/^v/i, '')}`;
      } else if (parts) {
        options = expand(parts[0]);
      }
      const info = parseVersionInfo(options);

      if (!info.version || !info.date) {
        if (!defs) defs = macroDefinitions(text);
        const fallback = versionFromMacros(defs, m.index);
        info.version = info.version || fallback.version;
        info.date = info.date || fallback.date;
      }

      return Object.assign(
        {
          kind: m[2].toLowerCase(),
          // An unresolvable macro name is reported as written rather than guessed.
          name: /\\/.test(resolvedName) ? literal : resolvedName,
        },
        info
      );
    }
    return null;
  }

  /**
   * Version and date for a file that declares neither, but defines them as
   * macros. cas-common.sty has no \Provides line at all -- only
   * \def\RCSversion{2.4} and \def\RCSdate{2024/05/04}.
   */
  function parseVersionMacros(text) {
    const defs = macroDefinitions(text.slice(0, 20000));
    const info = versionFromMacros(defs, Infinity);
    return info.version || info.date ? info : null;
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

  /*
   * Version-shaped text in a file's leading comments that is NOT that file's
   * version. Each pattern was a wrong reading against a real upstream file:
   *   cas-common.sty "either version 1.3c of this license"  -> read as v1.3c
   *                  "... of LaTeX version 1999/12/01"      -> read as 1999-12-01
   *   splncs04.bst   "For use with BibTeX version 0.99a"    -> read as v0.99a
   *   acl_natbib.bst "by urlbst, version 0.9.1"             -> read as v0.9.1
   *   most .bst      "% \ProvidesFile{merlin.mbs}[2011/11/18 4.33 ...]" -- the
   *                  makebst generator's own provenance, not the style's
   * The LPPL clause alone is in nearly every LaTeX file there is.
   */
  const NOT_THE_FILE_VERSION = [
    /\bversion\s+[\d.]+[a-z]?\s+of\s+(?:this|the)\s+licen[cs]e/gi,
    /\blicen[cs]e,?\s+either\s+version\s+[\d.]+[a-z]?/gi,
    /\bversion\s+[\d.]+[a-z]?\s+or\s+later\s+is\s+part\s+of/gi,
    /\b(?:La)?TeX\s+version\s+\d{4}\/\d{1,2}\/\d{1,2}/gi,
    /\bBibTeX\s+versions?\s+[\d.]+[a-z]?/gi,
    /\burlbst,?\s+version\s+[\d.]+[a-z]?/gi,
    /^.*\.mbs\b.*$/gmi,
  ];

  /** Last resort: scan leading comments for something version-shaped. */
  function parseCommentVersion(text) {
    // Comment markers are dropped first so a phrase wrapped across two comment
    // lines ("... distributions of LaTeX\n%% version 1999/12/01") still matches.
    let head = text.split('\n').slice(0, 80)
      .map((l) => l.replace(/^\s*%+/, '')).join('\n');
    for (const re of NOT_THE_FILE_VERSION) head = head.replace(re, ' ');

    const m =
      head.match(/\bversion\s+v?\.?\s*(\d+(?:\.\d+)+[a-z]?)/i) ||
      head.match(/\bv(\d+\.\d+(?:\.\d+)*[a-z]?)\b/) ||
      // aasjournalv7.bst: "Revision 1.19: Aptara", newest entry first.
      head.match(/\brevision\s+(\d+(?:\.\d+)+[a-z]?)\b/i);
    if (!m) return null;
    const info = parseVersionInfo(m[0]);
    info.version = info.version || m[1];

    // A date only counts if it belongs to that version: on its line or just
    // after ("Version 1.14 (2015/08/26)"), or an RCS keyword dating the file
    // itself ("$Id: elsarticle-num.bst 288 2026-01-09 ..."). The first date
    // anywhere is not good enough -- aasjournalv7.bst's newest entry carries
    // none, and the next one down is a 2019 changelog line.
    const DATE = /\b(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})\b/;
    const lines = head.split('\n');
    const at = head.slice(0, m.index).split('\n').length - 1;
    const d =
      lines.slice(at, at + 3).join('\n').match(DATE) ||
      (head.match(/\$(?:Id|Date):[^$\n]*/) || [''])[0].match(DATE);
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
    // Files whose only version-shaped text is somebody else's version -- the
    // BibTeX lineage of oup-plain.bst ("Version 0.99b"), the 1995 first release
    // at the top of mnras.bst's changelog -- are compared by content alone. A
    // wrong version is worse than none: it reports a stale file as current.
    if (strategy === 'none') return { version: null, date: null, source: 'none' };

    if (strategy === 'bst-header' || strategy === 'comment-scan') {
      const bst = parseBstHeader(text);
      if (bst) return { ...bst, source: 'bst-header' };
      const c = parseCommentVersion(text);
      if (c) return { ...c, source: 'comment-scan' };
      return { version: null, date: null, source: 'none' };
    }

    const p = parseProvides(text);
    if (p) return { version: p.version, date: p.date, name: p.name, source: 'provides' };

    const macros = parseVersionMacros(text);
    if (macros) return { ...macros, source: 'macros' };

    const bst = parseBstHeader(text);
    if (bst) return { ...bst, source: 'bst-header' };

    const c = parseCommentVersion(text);
    if (c) return { ...c, source: 'comment-scan' };

    return { version: null, date: null, source: 'none' };
  }

  /**
   * Every package a file loads. ACL, CVPR and TMLR papers are plain
   * \documentclass{article} documents whose template is a .sty -- so for them
   * the class says nothing, and the \usepackage line is the whole signal.
   */
  function parseUsePackages(text) {
    const re = /\\(?:usepackage|RequirePackage)(?![A-Za-z@])/g;
    const names = new Set();
    let m;
    while ((m = re.exec(text)) !== null) {
      if (isCommented(text, m.index)) continue;
      let at = m.index + m[0].length;
      const opt = readDelimited(text, at, '[', ']');
      if (opt) at = opt.end;
      const arg = readDelimited(text, at, '{', '}');
      if (!arg) continue;
      for (const n of arg.value.split(',')) {
        const name = n.replace(/%[^\n]*/g, '').trim();
        if (name) names.add(name);
      }
    }
    return [...names];
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
    parseVersionInfo, parseVersionMacros, parseUsePackages, readVersion,
    splitPreamble, isTemplateAsset, isCommented,
  };
})();
