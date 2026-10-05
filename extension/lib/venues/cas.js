/* Elsevier CAS profile — cas-dc / cas-sc, the "Complex Article Service"
 * templates many Elsevier journals now ship in place of elsarticle.
 *
 * Front-matter shape, from Elsevier's own documentation (elsdoc-cas.tex in the
 * CTAN bundle):
 *
 *   \documentclass[a4paper,fleqn]{cas-dc}
 *   \begin{document}
 *   \shorttitle{..}  \shortauthors{..}
 *   \title [mode = title]{..}
 *   \tnotemark[1]  \tnotetext[1]{..}
 *   \author[1,3]{J.K. Krishnan}[orcid=0000-0001-0000-0000, role=Researcher]
 *   \cormark[1]  \fnmark[1]
 *   \ead{jkk@example.in}  \ead[url]{www.jkkrishnan.in}
 *   \credit{Conceptualization of this study, Methodology, Software}
 *   \affiliation[1]{organization={..}, addressline={..}, city={..},
 *                   postcode={..}, state={..}, country={..}}
 *   \cortext[1]{Corresponding author}
 *   \begin{abstract}..\end{abstract}
 *   \begin{highlights}\item ..\end{highlights}
 *   \begin{keywords} a \sep b \end{keywords}
 *   \maketitle
 *
 * Unlike elsarticle, an author carries a trailing [key=value] list -- which is
 * where ORCID lives, so an acmart \orcid finally has somewhere to go -- and
 * affiliations are linked to authors by label, like llncs's \inst.
 */

import {
  findCommand, findCommands, extractEnv, readOptional,
  documentClass, packages, tidy, splitList,
} from './latex.js';
import {
  makeIR, makeAffiliation, preserveRest, retargetBibStyle, TODO,
  keyValues, numberAffiliations, abbreviateName,
} from './ir.js';
import { affiliationPairs, BIB_STYLES } from './elsarticle.js';
import { reconcile } from './packages.js';

export const id = 'cas';
export const name = 'Elsevier CAS (cas-dc / cas-sc)';
export const detect = (cls) => cls === 'cas-dc' || cls === 'cas-sc';

/* Loaded unconditionally by cas-dc.cls and cas-common.sty. geometry is set to
 * Elsevier's page, so a source document's own geometry must not override it. */
const CLASS_PROVIDES = new Set([
  'graphicx', 'amsmath', 'amsfonts', 'amssymb', 'etoolbox', 'balance', 'booktabs',
  'makecell', 'multirow', 'array', 'colortbl', 'dcolumn', 'stfloats', 'xspace',
  'xstring', 'footmisc', 'xcolor', 'hyperref', 'geometry', 'moreverb', 'wrapfig',
]);

const OPTIONS = new Set(['a4paper', 'letterpaper', 'fleqn', 'longmktitle', 'review',
  'twocolumn', 'onecolumn', 'final', 'draft', '10pt', '11pt', '12pt']);

/** The only bibliography style in the CAS bundle (author-year, natbib). */
const BIB_STYLE = 'cas-model2-names';

/* ------------------------------------------------------------------- parse */

/**
 * Authors linked to labelled affiliations, with \cormark/\fnmark notes -- the
 * CAS scheme, which CEUR-WS's ceurart class inherits.
 *
 * @param {string} front   the front matter
 * @param {Map<string, object>} affiliations  label -> affiliation
 * @param {Report} report
 * @param {object} how
 * @param {string} [how.emailFrom]  'ead' (Elsevier) or 'kv' (CEUR's email= key)
 */
export function parseLabelledAuthors(front, affiliations, report, { emailFrom = 'ead' } = {}) {
  const notes = (cmd) => findCommands(front, cmd, 1).map((c) => ({
    label: (c.optional || '').trim(), text: tidy(c.args[0]),
  }));
  const cortext = notes('cortext');
  const fntext = notes('fntext');
  // \cormark[1] refers to a \cortext by label; Elsevier's own sample pairs
  // \cormark[1] with \cortext[cor1], so fall back to position.
  const noteFor = (list, mark) =>
    (list.find((n) => n.label === mark) || list[parseInt(mark, 10) - 1] || {}).text || null;

  const authors = [];
  const cmds = findCommands(front, 'author', 1);
  cmds.forEach((cmd, i) => {
    const trailing = readOptional(front, cmd.end);
    const kv = trailing ? keyValues(trailing.value) : {};
    const from = trailing ? trailing.end : cmd.end;
    const to = i + 1 < cmds.length ? cmds[i + 1].start : front.length;
    const region = front.slice(from, to);

    const labels = splitList(cmd.optional || '', ',');
    if (labels.length > 1) {
      report.warn(`${tidy(cmd.args[0])} lists ${labels.length} affiliations ` +
        `([${labels.join(',')}]). Only the first is carried across.`);
    }

    const marks = [
      ...findCommands(region, 'cormark', 0).map((c) => noteFor(cortext, (c.optional || '').trim())),
      ...findCommands(region, 'fnmark', 0).map((c) => noteFor(fntext, (c.optional || '').trim())),
    ].filter(Boolean);

    const ead = findCommands(region, 'ead', 1).find((c) => !c.optional);
    const credit = findCommand(region, 'credit', 1);

    authors.push({
      name: tidy(cmd.args[0]),
      email: emailFrom === 'kv' ? (kv.email || null) : (ead ? tidy(ead.args[0]) : null),
      orcid: kv.orcid || null,
      note: marks.length ? marks.join(' ') : null,
      credit: credit ? tidy(credit.args[0]) : null,
      // An unlabelled \author takes an unlabelled \affiliation.
      affiliation: affiliations.get(labels.length ? labels[0] : '') || makeAffiliation(),
    });
  });
  return authors;
}

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

  const shortTitle = findCommand(text, 'shorttitle', 1);
  if (shortTitle) ir.shortTitle = tidy(shortTitle.args[0]);

  // \title[mode=alt]{..} and friends are alternates; the main one has
  // mode=title, or no mode at all.
  const titles = findCommands(front, 'title', 1);
  const main = titles.find((t) => !t.optional || /mode\s*=\s*title\b/.test(t.optional));
  if (main) ir.title = tidy(main.args[0]);
  const tnote = findCommand(front, 'tnotetext', 1);
  if (tnote) ir.titleNote = tidy(tnote.args[0]);

  const affiliations = new Map();
  for (const a of findCommands(front, 'affiliation', 1)) {
    const kv = keyValues(a.args[0]);
    const f = makeAffiliation();
    for (const key of ['organization', 'department', 'addressline', 'city',
      'state', 'postcode', 'country']) {
      if (kv[key]) f[key] = tidy(kv[key]);
    }
    if (!f.organization && !f.city) f.raw = tidy(a.args[0]);
    affiliations.set((a.optional || '').trim(), f);
  }
  ir.authors = parseLabelledAuthors(front, affiliations, report);

  const abs = extractEnv(front, 'abstract');
  // \begin{abstract}[S U M M A R Y] takes a heading as an optional argument.
  if (abs) ir.abstract = abs.inner.replace(/^\s*\[[^\]]*\]/, '').trim();

  const kw = extractEnv(front, 'keywords');
  if (kw) ir.keywords = splitList(kw.inner, 'sep');

  const hl = extractEnv(front, 'highlights');
  if (hl) ir.highlights = hl.inner.split(/\\item\b/).map((s) => tidy(s)).filter(Boolean);
  const ga = extractEnv(front, 'graphicalabstract');
  if (ga && ga.inner.trim()) ir.graphicalAbstract = ga.inner.trim();

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

/** "M. Colley and J. Doe", or "M. Colley et al." past two. */
export function shortAuthors(authors) {
  if (!authors.length) return TODO('short author list');
  if (authors.length > 2) return `${abbreviateName(authors[0].name)} et al.`;
  return authors.map((a) => abbreviateName(a.name)).join(' and ');
}

/**
 * Author notes as numbered \cormark/\fnmark references plus their texts.
 * A note that says "corresponding" is what \cormark is for.
 */
export function markNotes(authors) {
  let cor = 0, fn = 0;
  const marks = new Map();
  const texts = [];
  for (const a of authors) {
    if (!a.note) continue;
    if (/\bcorrespond/i.test(a.note)) {
      cor++;
      marks.set(a, `\\cormark[${cor}]`);
      texts.push(`\\cortext[${cor}]{${a.note}}`);
    } else {
      fn++;
      marks.set(a, `\\fnmark[${fn}]`);
      texts.push(`\\fntext[${fn}]{${a.note}}`);
    }
  }
  return { marks, texts };
}

export function emit(ir, report) {
  const L = [];

  const known = ir.classOptions.filter((o) => OPTIONS.has(o));
  const foreign = ir.classOptions.filter((o) => !known.includes(o));
  const opts = known.length ? known : ['a4paper', 'fleqn'];
  if (foreign.length) {
    report.drop(`Class options \`${foreign.join(', ')}\``,
      `not CAS options; using \`${opts.join(',')}\``);
  }
  L.push(`\\documentclass[${opts.join(',')}]{cas-dc}`, '');
  report.map('Layout', 'cas-dc, the two-column CAS class; cas-sc is its ' +
    'single-column twin, if your journal wants that');

  // CAS loads no natbib, yet its bibliography style is a natbib one.
  const { lines } = reconcile(ir, CLASS_PROVIDES, report,
    { venue: id, options: { natbib: 'authoryear' }, require: ['natbib'] });
  if (lines.length) L.push(...lines, '');
  const bibAt = L.length;

  L.push('\\begin{document}', '');
  if (ir.shortTitle) L.push(`\\shorttitle{${ir.shortTitle}}`);
  L.push(`\\shortauthors{${shortAuthors(ir.authors)}}`, '');

  L.push(`\\title [mode = title]{${ir.title || TODO('title')}}`);
  if (ir.titleNote) {
    L.push('\\tnotemark[1]', `\\tnotetext[1]{${ir.titleNote}}`);
    report.map('Title note', 'carried as a CAS \\tnotetext');
  }
  L.push('');

  const { list, labelOf } = numberAffiliations(ir.authors);
  const { marks, texts } = markNotes(ir.authors);
  for (const a of ir.authors) {
    L.push(`\\author[${labelOf(a)}]{${a.name}}${a.orcid ? `[orcid=${a.orcid}]` : ''}`);
    if (marks.has(a)) L.push(marks.get(a));
    if (a.email) L.push(`\\ead{${a.email}}`);
    if (a.credit) L.push(`\\credit{${a.credit}}`);
    L.push('');
  }
  if (ir.authors.some((a) => a.orcid)) {
    report.map('ORCID', 'carried in the CAS \\author key list');
  }
  list.forEach((f, i) => {
    L.push(`\\affiliation[${i + 1}]{` + affiliationPairs(f).join(',\n            ') + '}', '');
  });
  if (texts.length) L.push(...texts, '');

  if (ir.abstract) L.push('\\begin{abstract}', ir.abstract, '\\end{abstract}', '');

  if (ir.graphicalAbstract) {
    L.push('\\begin{graphicalabstract}', ir.graphicalAbstract, '\\end{graphicalabstract}', '');
  }
  L.push('\\begin{highlights}');
  if (ir.highlights.length) {
    for (const h of ir.highlights) L.push(`\\item ${h}`);
  } else {
    L.push(`\\item ${TODO('research highlight 1 (max 85 characters)')}`);
    L.push(`\\item ${TODO('research highlight 2')}`);
    L.push(`\\item ${TODO('research highlight 3')}`);
    report.need('Research highlights',
      'most Elsevier journals require 3-5 bullets of max 85 characters each');
  }
  L.push('\\end{highlights}', '');

  if (ir.keywords.length) {
    L.push('\\begin{keywords}', ir.keywords.join(' \\sep '), '\\end{keywords}', '');
    report.map('Keywords', '\\sep-separated keywords environment');
  }

  L.push(...preserveRest(ir, report, 'Elsevier',
    new Set(['titleNote', 'highlights', 'graphicalAbstract', 'credit'])));

  L.push('\\maketitle', '');

  const accepted = [BIB_STYLE, 'model1-num-names', ...BIB_STYLES];
  const { body, preambleLine } = retargetBibStyle(ir, report, BIB_STYLE, accepted);
  if (preambleLine) L.splice(bibAt, 0, preambleLine, '');
  if (ir.bib.style && !accepted.includes(ir.bib.style)) {
    report.warn(`${BIB_STYLE} gives author-year citations. If your journal ` +
      'numbers its references, use Elsevier\'s model1-num-names style instead ' +
      'and load natbib with the `numbers` option.');
  }

  L.push(body.replace(/^\n+/, ''));
  L.push('\\end{document}');
  return L.join('\n');
}
