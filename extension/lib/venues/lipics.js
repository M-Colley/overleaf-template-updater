/* LIPIcs profile — Dagstuhl's Leibniz International Proceedings in
 * Informatics (ICALP, STACS, SoCG, ESA, ...), and OASIcs, which shares it.
 *
 * Front-matter shape, from Dagstuhl's own lipics-v2021-sample-article.tex:
 *
 *   \documentclass[a4paper,UKenglish,cleveref,autoref,thm-restate]{lipics-v2021}
 *   \bibliographystyle{plainurl}
 *   \title{..}  \titlerunning{..}
 *   \author{Jane {Open Access}}{Dummy University Computing Laboratory, Country
 *           \and My second affiliation, Country}{email}{https://orcid.org/..}{funding}
 *   \author{Joan R. Public\footnote{e.g. to mark corresponding author}}{..}{..}{..}{..}
 *   \authorrunning{J. Open Access and J.\,R. Public}
 *   \Copyright{Jane Open Access and Joan R. Public}
 *   \ccsdesc[100]{Theory of computation~...}
 *   \keywords{a, b}
 *   \funding{..}  \acknowledgements{..}
 *   \begin{document}
 *   \maketitle
 *   \begin{abstract}..\end{abstract}
 *
 * Two things set it apart. The whole front matter -- \bibliographystyle
 * included -- sits in the PREAMBLE, with only the abstract after \maketitle.
 * And LIPIcs classifies papers with the ACM CCS taxonomy, as the same \ccsdesc
 * lines acmart uses, so CCS concepts carry between the two in both directions:
 * the one classification that survives a change of publisher.
 */

import {
  findCommand, findCommands, extractEnv, documentClass, packages,
  tidy, splitList, splitOnCommand, stripCommand,
} from './latex.js';
import {
  makeIR, preserve, preserveRest, retargetBibStyle, TODO,
  affiliationFromText, affiliationText, orcidId, abbreviateName,
} from './ir.js';
import { reconcile } from './packages.js';

export const id = 'lipics';
export const name = 'Dagstuhl LIPIcs / OASIcs (lipics-v2021)';
export const detect = (cls) => cls === 'lipics-v2021' || cls === 'oasics-v2021';

/* Loaded unconditionally by lipics-v2021.cls. cleveref, thm-restate and
 * aliascnt are left out: the class loads those only for the matching option. */
const CLASS_PROVIDES = new Set([
  'microtype', 'inputenc', 'fontenc', 'textcomp', 'amssymb', 'soul', 'color',
  'babel', 'amsmath', 'enumerate', 'graphicx', 'array', 'multirow', 'tabularx',
  'threeparttable', 'listings', 'lineno', 'hyperref', 'caption', 'rotating',
  'subcaption', 'xstring', 'comment', 'amsthm',
]);

const OPTIONS = new Set(['a4paper', 'letterpaper', 'UKenglish', 'USenglish',
  'numberwithinsect', 'cleveref', 'autoref', 'thm-restate', 'anonymous',
  'authorcolumns', 'pdfa']);

/* Set by the volume editors, not the author ("do not touch as author"). */
const EDITOR_ONLY = ['EventEditors', 'EventNoEds', 'EventLongTitle', 'EventShortTitle',
  'EventAcronym', 'EventYear', 'EventDate', 'EventLocation', 'EventLogo',
  'SeriesVolume', 'ArticleNo'];

/* ------------------------------------------------------------------- parse */

export function parse(text, report) {
  const ir = makeIR(id);

  const cls = documentClass(text);
  ir.classOptions = cls ? cls.options : [];

  const bd = text.match(/\\begin\s*\{document\}/);
  const preamble = bd ? text.slice(0, bd.index) : text;
  const afterBegin = bd ? text.slice(bd.index + bd[0].length) : '';

  for (const p of packages(preamble)) ir.packages.push(p);

  const title = findCommand(preamble, 'title', 1);
  if (title) ir.title = tidy(title.args[0]);
  const running = findCommand(preamble, 'titlerunning', 1);
  if (running && tidy(running.args[0])) ir.shortTitle = tidy(running.args[0]);

  // \author{name}{affiliations}{email}{orcid}{funding}, one per author.
  for (const a of findCommands(preamble, 'author', 5)) {
    const [rawName = '', rawAff = '', email = '', orcid = '', funding = ''] = a.args;

    const notes = [];
    const fn = findCommand(rawName, 'footnote', 1);
    if (fn) notes.push(tidy(fn.args[0]));
    if (tidy(funding) && !/^\[?funding\]?$/i.test(tidy(funding))) notes.push(tidy(funding));
    const nameText = tidy(stripCommand(rawName, 'footnote', 1));

    // Several affiliations, and a homepage, share the argument, \and-separated.
    const places = splitOnCommand(rawAff, 'and')
      .map((p) => stripCommand(p, 'url', 1).trim())
      .filter(Boolean);
    if (places.length > 1) {
      report.warn(`${nameText} lists ${places.length} affiliations. Only the ` +
        'first is carried across.');
    }

    ir.authors.push({
      name: nameText,
      email: tidy(email) && tidy(email).includes('@') ? tidy(email) : null,
      orcid: orcidId(orcid),
      note: notes.length ? notes.join(' ') : null,
      affiliation: affiliationFromText(places[0] || ''),
    });
  }
  if (ir.authors.length) {
    report.warn('LIPIcs affiliations are free text, so the organisation, city ' +
      'and country were split out heuristically. Check they came out right.');
  }

  ir.ccs.descs = findCommands(preamble, 'ccsdesc', 1)
    .map((c) => ({ weight: c.optional, value: tidy(c.args[0]) }))
    .filter((d) => d.value && !/Replace ccsdesc macro/.test(d.value));

  const kw = findCommand(preamble, 'keywords', 1);
  if (kw) ir.keywords = splitList(kw.args[0], ',');

  const funding = findCommand(preamble, 'funding', 1);
  if (funding && tidy(funding.args[0])) ir.titleNote = tidy(funding.args[0]);
  const acks = findCommand(preamble, 'acknowledgements', 1);
  if (acks && tidy(acks.args[0])) ir.acknowledgements = tidy(acks.args[0]);

  if (EDITOR_ONLY.some((m) => findCommand(preamble, m, 1))) {
    report.drop('LIPIcs volume metadata (\\EventEditors, \\SeriesVolume, ...)',
      'set by the volume editors, not the author');
  }

  const mt = afterBegin.search(/\\maketitle/);
  let body = mt >= 0 ? afterBegin.slice(mt + '\\maketitle'.length) : afterBegin;
  body = body.replace(/\\end\s*\{document\}\s*$/, '');

  // The abstract follows \maketitle, so it is lifted out of the body.
  const abs = extractEnv(body, 'abstract');
  if (abs) {
    ir.abstract = abs.inner.trim();
    body = body.slice(0, abs.start) + body.slice(abs.end);
  }

  // The style is declared in the preamble; \bibliography stays in the body.
  const bibStyle = findCommand(body, 'bibliographystyle', 1) ||
    findCommand(preamble, 'bibliographystyle', 1);
  if (bibStyle) ir.bib.style = tidy(bibStyle.args[0]);
  const bibFiles = findCommand(body, 'bibliography', 1);
  if (bibFiles) ir.bib.files = splitList(bibFiles.args[0], ',');

  ir.body = body;
  return ir;
}

/* -------------------------------------------------------------------- emit */

/** "M. Colley and J. Doe"; "M. Colley, J. Doe, and A. Roe". */
function authorRunning(authors) {
  const short = authors.map((a) => abbreviateName(a.name));
  if (short.length <= 2) return short.join(' and ');
  return `${short.slice(0, -1).join(', ')}, and ${short[short.length - 1]}`;
}

export function emit(ir, report) {
  const L = [];

  const known = ir.classOptions.filter((o) => OPTIONS.has(o));
  const foreign = ir.classOptions.filter((o) => !known.includes(o));
  // A paper size and a hyphenation language, unless the source chose them.
  const opts = [
    ...(known.some((o) => o.endsWith('paper')) ? [] : ['a4paper']),
    ...(known.some((o) => o.endsWith('english')) ? [] : ['USenglish']),
    ...known,
  ];
  if (foreign.length) {
    report.drop(`Class options \`${foreign.join(', ')}\``,
      `not LIPIcs options; using \`${opts.join(',')}\``);
  }
  L.push(`\\documentclass[${opts.join(',')}]{lipics-v2021}`, '');

  // plainurl is numeric; natbib without `numbers` would stop on it.
  const { lines } = reconcile(ir, CLASS_PROVIDES, report, { venue: id, options: { natbib: 'numbers' } });
  if (lines.length) L.push(...lines, '');

  // LIPIcs mandates plainurl, and declares it here in the preamble.
  const { body, preambleLine } = retargetBibStyle(ir, report, 'plainurl');
  if (preambleLine) L.push(preambleLine, '');

  L.push(`\\title{${ir.title || TODO('title')}}`);
  if (ir.shortTitle) L.push(`\\titlerunning{${ir.shortTitle}}`);
  L.push('');

  for (const a of ir.authors) {
    const f = a.affiliation;
    const place = affiliationText(f) + (f.country ? '' : `, ${TODO('country')}`);
    if (!f.country) {
      report.need(`Country for ${a.name}`, 'LIPIcs requires at least an affiliation and a country');
    }
    const nameArg = a.note ? `${a.name}\\footnote{${a.note}}` : a.name;
    const orcid = a.orcid ? `https://orcid.org/${a.orcid}` : '';
    L.push(`\\author{${nameArg}}{${place}}{${a.email || ''}}{${orcid}}{}`, '');
  }
  if (ir.authors.some((a) => a.note)) {
    report.map('Author notes', 'carried as a \\footnote on the name, as the LIPIcs sample does');
  }
  if (ir.authors.length) {
    L.push(`\\authorrunning{${authorRunning(ir.authors)}}`);
    L.push(`\\Copyright{${ir.authors.map((a) => a.name).join(' and ')}}`, '');
    report.map('\\authorrunning and \\Copyright', 'derived from the author list');
  }

  if (ir.ccs.descs.length) {
    for (const d of ir.ccs.descs) L.push(`\\ccsdesc[${d.weight || 100}]{${d.value}}`);
    report.map('CCS concepts', 'LIPIcs uses the same ACM taxonomy, so the \\ccsdesc lines carry over');
    if (ir.ccs.xml) {
      L.push(preserve('ACM CCSXML block (LIPIcs needs only the \\ccsdesc lines)', ir.ccs.xml));
    }
  } else {
    L.push(`\\ccsdesc[100]{${TODO('ACM 2012 CCS concept, e.g. Theory of computation~...')}}`);
    report.need('\\ccsdesc', 'mandatory in LIPIcs; pick ACM 2012 CCS concepts at https://dl.acm.org/ccs');
  }
  L.push('');

  if (ir.keywords.length) {
    L.push(`\\keywords{${ir.keywords.join(', ')}}`);
  } else {
    L.push(`\\keywords{${TODO('comma-separated keywords')}}`);
    report.need('\\keywords', 'mandatory in LIPIcs');
  }
  if (ir.titleNote) {
    L.push(`\\funding{${ir.titleNote}}`);
    report.map('Title note', 'carried as the LIPIcs \\funding statement');
  }
  if (ir.acknowledgements) L.push(`\\acknowledgements{${ir.acknowledgements}}`);
  L.push('');

  L.push(...preserveRest(ir, report, 'LIPIcs',
    new Set(['titleNote', 'ccs', 'acknowledgements'])));

  L.push('\\begin{document}', '', '\\maketitle', '');
  if (ir.abstract) L.push('\\begin{abstract}', ir.abstract, '\\end{abstract}', '');

  L.push(body.replace(/^\n+/, ''));
  L.push('\\end{document}');
  return L.join('\n');
}
