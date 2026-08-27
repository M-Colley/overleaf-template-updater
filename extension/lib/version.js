/* Version comparison for LaTeX packages.
 *
 * Two traps this handles that a naive string/float compare gets wrong:
 *   - "2.20" is NEWER than "2.9"  (component-wise integers, not decimals)
 *   - "1.8b" is NEWER than "1.8"  (letter suffixes are real: IEEEtran V1.8b) */
var OTU = (typeof OTU !== 'undefined' && OTU) || {};

OTU.version = (function () {
  'use strict';

  function parse(v) {
    if (!v) return null;
    const m = String(v).trim().match(/^v?\.?\s*(\d+(?:\.\d+)*)\s*([a-z]*)$/i);
    if (!m) return null;
    return {
      parts: m[1].split('.').map((n) => parseInt(n, 10)),
      suffix: (m[2] || '').toLowerCase(),
    };
  }

  /** @returns -1 if a<b, 0 if equal, 1 if a>b, null if not comparable. */
  function compare(a, b) {
    const pa = parse(a), pb = parse(b);
    if (!pa || !pb) return null;
    const n = Math.max(pa.parts.length, pb.parts.length);
    for (let i = 0; i < n; i++) {
      const x = pa.parts[i] ?? 0;
      const y = pb.parts[i] ?? 0;
      if (x !== y) return x < y ? -1 : 1;
    }
    if (pa.suffix === pb.suffix) return 0;
    if (!pa.suffix) return -1; // "1.8" < "1.8b"
    if (!pb.suffix) return 1;
    return pa.suffix < pb.suffix ? -1 : 1;
  }

  /** ISO-ish date strings, already normalised to YYYY-MM-DD by the parser. */
  function compareDates(a, b) {
    if (!a || !b) return null;
    if (a === b) return 0;
    return a < b ? -1 : 1;
  }

  /**
   * Decide whether `local` is behind `upstream`.
   * @returns {{status:'outdated'|'current'|'ahead'|'unknown', by:string, reason:string}}
   */
  function assess(local, upstream) {
    const unknown = (reason) => ({ status: 'unknown', by: 'none', reason });

    if (!local) return unknown('could not read a version from the file in your project');
    if (!upstream) return unknown('could not determine the latest upstream version');

    const vc = compare(local.version, upstream.version);
    if (vc !== null) {
      return {
        status: vc < 0 ? 'outdated' : vc > 0 ? 'ahead' : 'current',
        by: 'version',
        reason: `local v${local.version} vs upstream v${upstream.version}`,
      };
    }

    const dc = compareDates(local.date, upstream.date);
    if (dc !== null) {
      return {
        status: dc < 0 ? 'outdated' : dc > 0 ? 'ahead' : 'current',
        by: 'date',
        reason: `local ${local.date} vs upstream ${upstream.date}`,
      };
    }

    return unknown('no comparable version or date on either side');
  }

  return { parse, compare, compareDates, assess };
})();
