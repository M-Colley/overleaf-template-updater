/* Line diff for the "what would change?" preview.
 *
 * IEEEtran.cls is ~282 KB / ~7000 lines, so a plain O(n*m) LCS table is out of
 * the question. This uses Myers' O(ND) algorithm with a work cap, after
 * stripping the common prefix/suffix -- which is exactly the shape of a version
 * bump (small edits scattered through a large, mostly-identical file). If the
 * files turn out to be wildly different, we bail out to a summary rather than
 * hanging the tab. */
var OTU = (typeof OTU !== 'undefined' && OTU) || {};

OTU.diff = (function () {
  'use strict';

  const MAX_D = 3000; // give up past this many edits and just summarise

  function splitLines(text) {
    return text.replace(/\r\n?/g, '\n').split('\n');
  }

  /** Myers diff over two line arrays. Returns ops, or null if it exceeds MAX_D. */
  function myers(a, b) {
    const n = a.length, m = b.length;
    const max = Math.min(MAX_D, n + m);
    const v = new Map([[1, 0]]);
    const trace = [];

    for (let d = 0; d <= max; d++) {
      trace.push(new Map(v));
      for (let k = -d; k <= d; k += 2) {
        let x;
        if (k === -d || (k !== d && (v.get(k - 1) ?? 0) < (v.get(k + 1) ?? 0))) {
          x = v.get(k + 1) ?? 0;
        } else {
          x = (v.get(k - 1) ?? 0) + 1;
        }
        let y = x - k;
        while (x < n && y < m && a[x] === b[y]) { x++; y++; }
        v.set(k, x);
        if (x >= n && y >= m) return backtrack(trace, a, b, d);
      }
    }
    return null;
  }

  function backtrack(trace, a, b, d) {
    const ops = [];
    let x = a.length, y = b.length;
    for (let depth = d; depth > 0; depth--) {
      const v = trace[depth];
      const k = x - y;
      let prevK;
      if (k === -depth || (k !== depth && (v.get(k - 1) ?? 0) < (v.get(k + 1) ?? 0))) {
        prevK = k + 1;
      } else {
        prevK = k - 1;
      }
      const prevX = v.get(prevK) ?? 0;
      const prevY = prevX - prevK;

      while (x > prevX && y > prevY) { ops.push({ t: ' ', line: a[--x] }); y--; }
      if (x > prevX) ops.push({ t: '-', line: a[--x] });
      else if (y > prevY) ops.push({ t: '+', line: b[--y] });
    }
    while (x > 0 && y > 0) { ops.push({ t: ' ', line: a[--x] }); y--; }
    while (x > 0) ops.push({ t: '-', line: a[--x] });
    while (y > 0) ops.push({ t: '+', line: b[--y] });
    return ops.reverse();
  }

  /**
   * @returns {{ok:boolean, added:number, removed:number, hunks?:Array, summaryOnly?:boolean}}
   */
  function compare(oldText, newText, { context = 3, maxHunks = 40 } = {}) {
    let a = splitLines(oldText);
    let b = splitLines(newText);

    if (oldText === newText) return { ok: true, added: 0, removed: 0, hunks: [], identical: true };

    // Strip the identical head and tail; they dominate a version bump.
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head++;
    let tail = 0;
    while (
      tail < a.length - head && tail < b.length - head &&
      a[a.length - 1 - tail] === b[b.length - 1 - tail]
    ) tail++;

    const aCore = a.slice(head, a.length - tail);
    const bCore = b.slice(head, b.length - tail);

    const ops = myers(aCore, bCore);
    if (!ops) {
      return {
        ok: true, summaryOnly: true,
        added: bCore.length, removed: aCore.length,
        hunks: [],
        note: 'Files differ too extensively to render a line-by-line diff.',
      };
    }

    let added = 0, removed = 0;
    for (const op of ops) {
      if (op.t === '+') added++;
      else if (op.t === '-') removed++;
    }

    // Group changed ops into hunks with a few lines of context.
    const hunks = [];
    let i = 0;
    let lineNoOld = head + 1;
    const withNumbers = ops.map((op) => {
      const rec = { ...op, oldNo: op.t === '+' ? null : lineNoOld };
      if (op.t !== '+') lineNoOld++;
      return rec;
    });

    while (i < withNumbers.length && hunks.length < maxHunks) {
      if (withNumbers[i].t === ' ') { i++; continue; }
      let start = Math.max(0, i - context);
      let end = i;
      while (end < withNumbers.length) {
        if (withNumbers[end].t !== ' ') { end++; continue; }
        // extend through up to `context*2` unchanged lines to merge nearby hunks
        let run = 0, j = end;
        while (j < withNumbers.length && withNumbers[j].t === ' ') { run++; j++; }
        if (run > context * 2 || j >= withNumbers.length) break;
        end = j;
      }
      hunks.push(withNumbers.slice(start, Math.min(end + context, withNumbers.length)));
      i = end + context;
    }

    return {
      ok: true, added, removed, hunks,
      truncated: hunks.length >= maxHunks,
    };
  }

  return { compare, splitLines };
})();
