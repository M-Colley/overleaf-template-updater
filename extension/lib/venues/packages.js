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
  // acmart and ceurart load natbib themselves, so a body full of \citet and
  // \citeauthor never had to declare it. Plain \cite needs no natbib.
  natbib: /\\cite(?:t|p|alt|alp|author|year|yearpar|num)\*?(?![a-zA-Z])/,
};

/*
 * Commands a class defines that a body then uses: ACM requires a \Description
 * on every figure, and IEEEtran has no idea what one is. The body is carried
 * verbatim, so an acmart paper converted to IEEEtran stopped at its first
 * figure with "Undefined control sequence". A guarded, do-nothing definition
 * in the target's preamble keeps it compiling without touching the body.
 */
const SHIMS = [
  { use: /\\Description\b/, native: ['acmart'],
    line: '\\providecommand{\\Description}[2][]{}',
    what: '\\Description', why: 'the figure descriptions stay in the source' },
  { use: /\\begin\s*\{acks\}/, native: ['acmart'],
    line: '\\ifcsname acks\\endcsname\\else\\newenvironment{acks}{\\section*{Acknowledgments}}{}\\fi',
    what: 'the acks environment', why: 'it becomes an unnumbered Acknowledgments section' },
  { use: /\\begin\s*\{acknowledgments\}/, native: ['ceurart'],
    line: '\\ifcsname acknowledgments\\endcsname\\else\\newenvironment{acknowledgments}' +
      '{\\section*{Acknowledgments}}{}\\fi',
    what: 'the acknowledgments environment', why: 'it becomes an unnumbered Acknowledgments section' },
  { use: /\\printcredits\b/, native: ['cas'],
    line: '\\providecommand{\\printcredits}{}',
    what: '\\printcredits', why: 'the CRediT list prints nothing' },
  { use: /\\IEEEPARstart\b/, native: ['ieeetran'],
    line: '\\providecommand{\\IEEEPARstart}[2]{#1#2}',
    what: '\\IEEEPARstart', why: 'the drop capital becomes plain text' },
];

/**
 * Work out the \usepackage lines the target document should carry.
 *
 * @param {object} ir            the parsed document
 * @param {Set<string>} provides what the TARGET class loads itself
 * @param {Report} report
 * @param {object} [target]
 * @param {Object<string,string>} [target.options]  options for a package this
 *   adds -- natbib needs `numbers` before a numeric style, or it stops with
 *   "Bibliography not compatible with author-year citations"
 * @param {string[]} [target.require]  packages the target needs regardless
 *   of the body (Elsevier CAS's bibliography style is a natbib one)
 * @param {string} [target.venue]  the target's id, for the body shims
 * @returns {{lines: string[], dropped: string[], added: string[]}}
 */
export function reconcile(ir, provides, report, { options = {}, require = [], venue = null } = {}) {
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
    if (!pattern.test(text) && !require.includes(pkg)) continue;
    added.push(pkg);
  }
  // A package that needs options gets a line of its own.
  const plain = added.filter((p) => !options[p]);
  if (plain.length) lines.push(`\\usepackage{${plain.join(',')}}`);
  for (const p of added.filter((x) => options[x])) {
    lines.push(`\\usepackage[${options[p]}]{${p}}`);
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

  for (const s of SHIMS) {
    if (s.native.includes(venue) || !s.use.test(ir.body)) continue;
    lines.push(s.line);
    report.map(`Kept ${s.what} compiling`,
      `the target class lacks it, so the preamble defines a stand-in; ${s.why}`);
  }

  return { lines, dropped, added };
}
