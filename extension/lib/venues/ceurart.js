/* CEUR-WS profile — ceurart, the class for CEUR Workshop Proceedings, where a
 * great many workshop papers appear before growing into full papers.
 *
 * Front-matter shape, from the class's own sample__1col.tex:
 *
 *   \documentclass{ceurart}
 *   \begin{document}
 *   \copyrightyear{2026}
 *   \copyrightclause{Copyright for this paper by its authors. Use permitted
 *     under Creative Commons License Attribution 4.0 International (CC BY 4.0).}
 *   \conference{Woodstock'22: Symposium on the irreproducible science, ...}
 *   \title{..}  \tnotemark[1] \tnotetext[1]{..}
 *   \author[1,2]{Dmitry S. Kulyabov}[orcid=.., email=.., url=..]
 *   \cormark[1]  \fnmark[1]
 *   \address[1]{RUDN University, 6 Miklukho-Maklaya St, Moscow, 117198, Russian Federation}
 *   \cortext[1]{Corresponding author.}
 *   \begin{abstract}..\end{abstract}
 *   \begin{keywords} a \sep b \end{keywords}
 *   \maketitle
 *
 * ceurart is built on Elsevier's CAS classes, and its author scheme -- labels,
 * a trailing key list, \cormark notes -- is theirs; only the email moves into
 * the key list and the affiliation becomes free text. The parser is shared.
 */

import {
  findCommand, findCommands, extractEnv, documentClass, packages, tidy, splitList,
} from './latex.js';
import {
  makeIR, preserveRest, retargetBibStyle, TODO,
  affiliationFromText, affiliationText, numberAffiliations,
} from './ir.js';
import { parseLabelledAuthors, markNotes } from './cas.js';
import { reconcile } from './packages.js';

export const id = 'ceurart';
export const name = 'CEUR Workshop Proceedings (ceurart)';
export const detect = (cls) => cls === 'ceurart';

/* Loaded unconditionally by ceurart.cls (natbib with `numbers`). */
const CLASS_PROVIDES = new Set([
  'graphicx', 'amsmath', 'amsfonts', 'amssymb', 'etoolbox', 'balance', 'booktabs',
  'makecell', 'multirow', 'array', 'colortbl', 'dcolumn', 'stfloats', 'xspace',
  'xstring', 'footmisc', 'xcolor', 'microtype', 'hyperref', 'moreverb', 'csquotes',
  'calc', 'wrapfig', 'natbib', 'geometry',
]);

/** The class sets this style itself; a document may override it. */
const BIB_STYLE = 'elsarticle-num-names';

const LICENCE = 'Copyright for this paper by its authors.\n' +
  '  Use permitted under Creative Commons License Attribution 4.0 International (CC BY 4.0).';

/* ------------------------------------------------------------------- parse */

export function parse(text, report) {
  const ir = makeIR(id);

  const cls = documentClass(text);
  ir.classOptions = cls ? cls.options : [];

  const bd = text.match(/\\begin\s*\{document\}/);
  const preamble = bd ? text.slice(0, bd.index) : text;
  const afterBegin = bd ? text.slice(bd.index + bd[0].length) : '';

  for (const p of packages(preamble)) ir.packages.push(p);

  const mt = afterBegin.search(/\\maketitle/);
  const front = mt >= 0 ? afterBegin.slice(0, mt) : afterBegin;

  const year = findCommand(front, 'copyrightyear', 1);
  if (year) ir.meta.copyrightYear = tidy(year.args[0]);
  const conf = findCommand(front, 'conference', 1);
  if (conf) ir.meta.conferenceText = tidy(conf.args[0]);

  const title = findCommand(front, 'title', 1);
  if (title) ir.title = tidy(title.args[0]);
  const tnote = findCommand(front, 'tnotetext', 1);
  if (tnote) ir.titleNote = tidy(tnote.args[0]);

  const affiliations = new Map();
  for (const a of findCommands(front, 'address', 1)) {
    affiliations.set((a.optional || '').trim(), affiliationFromText(a.args[0]));
  }
  ir.authors = parseLabelledAuthors(front, affiliations, report, { emailFrom: 'kv' });
  if (affiliations.size) {
    report.warn('CEUR-WS addresses are free text, so the organisation, city and ' +
      'country were split out heuristically. Check they came out right.');
  }

  const abs = extractEnv(front, 'abstract');
  if (abs) ir.abstract = abs.inner.trim();
  const kw = extractEnv(front, 'keywords');
  if (kw) ir.keywords = splitList(kw.inner, 'sep');

  let body = mt >= 0 ? afterBegin.slice(mt + '\\maketitle'.length) : '';
  body = body.replace(/\\end\s*\{document\}\s*$/, '');

  const bibStyle = findCommand(body, 'bibliographystyle', 1);
  if (bibStyle) ir.bib.style = tidy(bibStyle.args[0]);
  const bibFiles = findCommand(body, 'bibliography', 1);
  if (bibFiles) ir.bib.files = splitList(bibFiles.args[0], ',');

  ir.body = body;
  return ir;
}

/* -------------------------------------------------------------------- emit */

export function emit(ir, report) {
  const L = [];

  // CEUR-WS: "Do not use twocolumn for papers submitted to CEUR-WS!"
  if (ir.classOptions.length) {
    report.drop(`Class options \`${ir.classOptions.join(', ')}\``,
      'CEUR-WS papers use the class defaults (and never twocolumn)');
  }
  L.push('\\documentclass{ceurart}', '');

  const { lines } = reconcile(ir, CLASS_PROVIDES, report, { venue: id });
  if (lines.length) L.push(...lines, '');
  const bibAt = L.length;

  L.push('\\begin{document}', '');
  L.push(`\\copyrightyear{${ir.meta.copyrightYear || new Date().getFullYear()}}`);
  L.push(`\\copyrightclause{${LICENCE}}`, '');

  // The source venue's own event is not the workshop this is going to.
  L.push(`\\conference{${TODO('workshop name, date and location')}}`, '');
  report.need('\\conference', 'the CEUR-WS workshop: its name, date and location');

  L.push(`\\title{${ir.title || TODO('title')}}`);
  if (ir.titleNote) {
    L.push('\\tnotemark[1]', `\\tnotetext[1]{${ir.titleNote}}`);
    report.map('Title note', 'carried as a \\tnotetext');
  }
  L.push('');

  const { list, labelOf } = numberAffiliations(ir.authors);
  const { marks, texts } = markNotes(ir.authors);
  for (const a of ir.authors) {
    const keys = [a.orcid && `orcid=${a.orcid}`, a.email && `email=${a.email}`].filter(Boolean);
    L.push(`\\author[${labelOf(a)}]{${a.name}}${keys.length ? `[${keys.join(', ')}]` : ''}`);
    if (marks.has(a)) L.push(marks.get(a));
  }
  L.push('');
  if (ir.authors.some((a) => a.orcid)) report.map('ORCID', 'carried in the \\author key list');
  list.forEach((f, i) => L.push(`\\address[${i + 1}]{${affiliationText(f)}}`));
  if (list.length) L.push('');
  if (texts.length) L.push(...texts, '');

  if (ir.abstract) L.push('\\begin{abstract}', ir.abstract, '\\end{abstract}', '');
  if (ir.keywords.length) {
    L.push('\\begin{keywords}', ir.keywords.join(' \\sep\n'), '\\end{keywords}', '');
    report.map('Keywords', '\\sep-separated keywords environment');
  }

  L.push(...preserveRest(ir, report, 'CEUR-WS', new Set(['titleNote'])));

  // Required since January 2025 (ceur-ws.org/GenAI/Policy.html). It belongs in
  // the body, which is never edited, so it is flagged rather than inserted.
  if (!/Declaration on Generative AI/i.test(ir.body)) {
    L.push('%% ' + TODO('add a \\section*{Declaration on Generative AI} before the ' +
      'bibliography (required by CEUR-WS; see ceur-ws.org/GenAI/Policy.html)'), '');
    report.need('Declaration on Generative AI',
      'CEUR-WS has required this section since January 2025; add it before the bibliography');
  }

  L.push('\\maketitle', '');

  const { body, preambleLine } = retargetBibStyle(ir, report, BIB_STYLE);
  if (preambleLine) L.splice(bibAt, 0, preambleLine, '');

  L.push(body.replace(/^\n+/, ''));
  L.push('\\end{document}');
  return L.join('\n');
}
