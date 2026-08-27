/* Package reconciliation between venue classes.
 *
 * Classes differ sharply in what they load for you. acmart pulls in graphicx,
 * booktabs, hyperref, amsmath and more; IEEEtran pulls in almost nothing and
 * expects the author to load their own.
 *
 * That asymmetry cuts both ways, and both directions silently break papers:
 *
 *   - Carrying \usepackage{hyperref} into acmart can break the class.
 *   - Converting acmart -> IEEEtran without ADDING graphicx breaks every
 *     \includegraphics in the body, because the source document never had to
 *     say \usepackage{graphicx} out loud.
 *
 * The second is the nastier one: nothing in the source document records the
 * dependency, so it can only be recovered by looking at what the body actually
 * uses. That is what this does. */

/** What using a package looks like in a document body. */
const USE = {
  graphicx: /\\includegraphics\b/,
  booktabs: /\\(toprule|midrule|bottomrule|cmidrule)\b/,
  hyperref: /\\(href|autoref|nameref)\b/,
  url: /\\url\b/,
  amsmath: /\\begin\{(align|align\*|gather|gather\*|multline|equation\*|split)\}|\\(text|dfrac|binom)\b/,
  amssymb: /\\(mathbb|mathfrak|leqslant|geqslant|checkmark)\b/,
  xcolor: /\\(textcolor|colorbox|definecolor|cellcolor)\b/,
  multirow: /\\multirow\b/,
  subcaption: /\\begin\{subfigure\}/,
  algorithm: /\\begin\{algorithm\}/,
  listings: /\\begin\{lstlisting\}|\\lstinline\b/,
  siunitx: /\\(SI|si|num|qty|unit)\{/,
};

/**
 * Work out the \usepackage lines the target document should carry.
 *
 * @param {object} ir            the parsed document
 * @param {Set<string>} provides what the TARGET class loads itself
 * @param {Report} report
 * @returns {{lines: string[], dropped: string[], added: string[]}}
 */
export function reconcile(ir, provides, report) {
  const lines = [];
  const dropped = [];
  const explicit = new Set();

  for (const p of ir.packages) {
    for (const n of p.names) explicit.add(n);
    const keep = p.names.filter((n) => !provides.has(n));
    dropped.push(...p.names.filter((n) => provides.has(n)));
    if (!keep.length) continue;
    lines.push(`\\usepackage${p.options ? `[${p.options}]` : ''}{${keep.join(',')}}`);
  }

  // Anything the body uses that the target will not provide and the source
  // never had to declare.
  const text = [ir.body, ir.abstract || '', ir.title || ''].join('\n');
  const added = [];
  for (const [pkg, pattern] of Object.entries(USE)) {
    if (provides.has(pkg) || explicit.has(pkg)) continue;
    if (!pattern.test(text)) continue;
    added.push(pkg);
  }
  if (added.length) {
    lines.push(`\\usepackage{${added.join(',')}}`);
  }

  if (dropped.length) {
    report.map(`Dropped \`${[...new Set(dropped)].join(', ')}\` from the preamble`,
      'the target class loads these itself');
  }
  if (added.length) {
    report.map(`Added \`${added.join(', ')}\``,
      'used by the body but provided implicitly by the source class, so never ' +
      'declared; the target class does not provide them');
  }

  return { lines, dropped, added };
}
