/* acmart profile — ACM's template (CHI, CSCW, UIST, AutomotiveUI, IMWUT, ...).
 *
 * Front-matter shape, from ACM's own samples/sigconf.tex:
 *
 *   \documentclass[sigconf]{acmart}
 *   \setcopyright{...} \copyrightyear{} \acmYear{} \acmDOI{}
 *   \acmConference[short]{name}{date}{place}  \acmISBN{}
 *   \begin{document}
 *   \title{}  \author{}\authornote{}\email{}\orcid{}
 *   \affiliation{\institution{}\city{}\state{}\country{}}
 *   \begin{abstract}..\end{abstract}
 *   \begin{CCSXML}..\end{CCSXML} \ccsdesc[500]{}
 *   \keywords{a, b, c}
 *   \maketitle
 */

import {
  findCommand, findCommands, extractEnv, indexOfCommand,
  documentClass, packages, tidy, splitList,
} from './latex.mjs';
import { makeIR, makeAffiliation, preserve, TODO } from './ir.mjs';

export const id = 'acmart';
export const name = 'ACM Primary Article Template (acmart)';
export const detect = (cls) => cls === 'acmart';

/** acmart loads these itself; a paper re-loading them tends to break it. */
const CLASS_PROVIDES = new Set([
  'hyperref', 'geometry', 'graphicx', 'natbib', 'caption', 'xcolor', 'color',
  'booktabs', 'amsmath', 'amssymb', 'amsfonts', 'balance', 'fontenc', 'inputenc',
  'microtype', 'url', 'cite',
]);

/* ------------------------------------------------------------------- parse */

export function parse(text, report) {
  const ir = makeIR(id);

  const cls = documentClass(text);
  ir.classOptions = cls ? cls.options : [];

  const beginDoc = indexOfCommand(text, 'begin\\s*\\{document\\}') >= 0
    ? text.search(/\\begin\s*\{document\}/)
    : -1;
  const preamble = beginDoc >= 0 ? text.slice(0, beginDoc) : text;
  const afterBegin = beginDoc >= 0
    ? text.slice(beginDoc + text.slice(beginDoc).match(/\\begin\s*\{document\}/)[0].length)
    : '';

  // Keep every package. Only the TARGET class knows which are redundant:
  // acmart provides booktabs but elsarticle does not, so filtering here would
  // silently break every \toprule in a converted body.
  for (const p of packages(preamble)) ir.packages.push(p);

  // Venue + copyright block.
  const g = (n, arity = 1) => findCommand(preamble, n, arity);
  const conf = g('acmConference', 3);
  if (conf) {
    ir.meta.conference = {
      short: conf.optional,
      name: conf.args[0], date: conf.args[1], place: conf.args[2],
    };
  }
  const pick = (cmd) => { const c = g(cmd); return c ? tidy(c.args[0]) : null; };
  ir.meta.copyright = pick('setcopyright');
  ir.meta.copyrightYear = pick('copyrightYear');
  ir.meta.acmYear = pick('acmYear');
  ir.meta.doi = pick('acmDOI');
  ir.meta.isbn = pick('acmISBN');

  // Title.
  const title = findCommand(afterBegin, 'title', 1);
  if (title) {
    ir.title = tidy(title.args[0]);
    ir.shortTitle = title.optional ? tidy(title.optional) : null;
  }

  // Authors. acmart lists \author then its satellites, repeating per author,
  // so we slice the region between consecutive \author commands.
  const authorCmds = findCommands(afterBegin, 'author', 1);
  for (let i = 0; i < authorCmds.length; i++) {
    const from = authorCmds[i].end;
    const to = i + 1 < authorCmds.length ? authorCmds[i + 1].start : afterBegin.length;
    const region = afterBegin.slice(from, to);

    const email = findCommand(region, 'email', 1);
    const orcid = findCommand(region, 'orcid', 1);
    const note = findCommand(region, 'authornote', 1);
    const aff = findCommand(region, 'affiliation', 1);

    const affiliation = makeAffiliation();
    if (aff) {
      const inner = aff.args[0];
      const f = (n) => { const c = findCommand(inner, n, 1); return c ? tidy(c.args[0]) : null; };
      affiliation.organization = f('institution');
      affiliation.department = f('department');
      affiliation.addressline = f('streetaddress');
      affiliation.city = f('city');
      affiliation.state = f('state');
      affiliation.postcode = f('postcode');
      affiliation.country = f('country');
      if (!affiliation.organization) affiliation.raw = tidy(inner);
    }

    ir.authors.push({
      name: tidy(authorCmds[i].args[0]),
      email: email ? tidy(email.args[0]) : null,
      orcid: orcid ? tidy(orcid.args[0]) : null,
      note: note ? tidy(note.args[0]) : null,
      affiliation,
    });
  }

  // Abstract, keywords, CCS, teaser.
  const abs = extractEnv(afterBegin, 'abstract');
  if (abs) ir.abstract = abs.inner.trim();

  const kw = findCommand(afterBegin, 'keywords', 1);
  if (kw) ir.keywords = splitList(kw.args[0], ',');

  const ccsxml = extractEnv(afterBegin, 'CCSXML');
  if (ccsxml) ir.ccs.xml = ccsxml.inner.trim();
  ir.ccs.descs = findCommands(afterBegin, 'ccsdesc', 1)
    .map((c) => ({ weight: c.optional, value: tidy(c.args[0]) }));

  const teaser = extractEnv(afterBegin, 'teaserfigure');
  if (teaser) ir.teaser = teaser.inner.trim();

  // Body: everything after \maketitle, verbatim.
  const mt = afterBegin.search(/\\maketitle/);
  let body = mt >= 0 ? afterBegin.slice(mt + '\\maketitle'.length) : afterBegin;
  body = body.replace(/\\end\s*\{document\}\s*$/, '');

  const bibStyle = findCommand(body, 'bibliographystyle', 1);
  if (bibStyle) ir.bib.style = tidy(bibStyle.args[0]);
  const bibFiles = findCommand(body, 'bibliography', 1);
  if (bibFiles) ir.bib.files = splitList(bibFiles.args[0], ',');

  ir.body = body;
  return ir;
}

/* -------------------------------------------------------------------- emit */

/** Options acmart actually understands. Anything else is another class's. */
const FORMATS = new Set(['acmsmall', 'acmlarge', 'acmtog', 'sigconf', 'sigchi',
  'sigchi-a', 'sigplan', 'manuscript', 'acmengage', 'acmcp']);
const MODIFIERS = new Set(['review', 'screen', 'authorversion', 'anonymous',
  'timestamp', 'authordraft', 'nonacm', 'balance', 'pbalance', 'natbib',
  'urlbreakonhyphens']);

export function emit(ir, report) {
  const L = [];

  // elsarticle's `preprint,12pt` means nothing to acmart and would error, so
  // only options acmart knows are carried; the rest are reported, not smuggled.
  const known = ir.classOptions.filter((o) =>
    FORMATS.has(o) || MODIFIERS.has(o) || o.startsWith('language='));
  const foreign = ir.classOptions.filter((o) => !known.includes(o));
  const opts = known.some((o) => FORMATS.has(o)) ? known : ['sigconf', ...known];

  if (foreign.length) {
    report.drop(`Class options \`${foreign.join(', ')}\``,
      `not acmart options; using \`${opts.join(',')}\``);
  }
  L.push(`\\documentclass[${opts.join(',')}]{acmart}`, '');

  // Drop only what acmart itself loads; re-loading those tends to break it.
  const redundant = [];
  let emitted = 0;
  for (const p of ir.packages) {
    const keep = p.names.filter((n) => !CLASS_PROVIDES.has(n));
    redundant.push(...p.names.filter((n) => CLASS_PROVIDES.has(n)));
    if (!keep.length) continue;
    L.push(`\\usepackage${p.options ? `[${p.options}]` : ''}{${keep.join(',')}}`);
    emitted++;
  }
  if (emitted) L.push('');
  if (redundant.length) {
    report.map(`Dropped \`${[...new Set(redundant)].join(', ')}\` from the preamble`,
      'acmart loads these itself and re-loading them can break the class');
  }

  // Venue block. ACM requires all of it for a real submission; anything the
  // source could not supply is scaffolded so the paper still compiles.
  L.push('%% Venue and rights. ACM assigns the DOI and ISBN on acceptance.');
  L.push(`\\setcopyright{${ir.meta.copyright || 'acmlicensed'}}`);
  const year = ir.meta.copyrightYear || ir.meta.acmYear || String(new Date().getFullYear());
  L.push(`\\copyrightyear{${year}}`);
  L.push(`\\acmYear{${ir.meta.acmYear || year}}`);
  L.push(`\\acmDOI{${ir.meta.doi || TODO('ACM DOI, e.g. XXXXXXX.XXXXXXX')}}`);

  if (ir.meta.conference) {
    const c = ir.meta.conference;
    L.push(`\\acmConference[${c.short || ''}]{${c.name}}{${c.date}}{${c.place}}`);
  } else {
    L.push(`\\acmConference[${TODO('acronym')}]{${TODO('conference name')}}` +
      `{${TODO('dates')}}{${TODO('location')}}`);
    report.need('\\acmConference', 'the target venue, dates and location');
  }
  L.push(`\\acmISBN{${ir.meta.isbn || TODO('ACM ISBN')}}`);
  if (!ir.meta.isbn) report.need('\\acmISBN', 'assigned by ACM on acceptance');
  if (!ir.meta.doi) report.need('\\acmDOI', 'assigned by ACM on acceptance');
  L.push('');

  for (const extra of ir.preambleExtras) L.push(extra);

  L.push('\\begin{document}', '');
  L.push(`\\title${ir.shortTitle ? `[${ir.shortTitle}]` : ''}{${ir.title || TODO('title')}}`, '');

  for (const a of ir.authors) {
    L.push(`\\author{${a.name}}`);
    if (a.note) L.push(`\\authornote{${a.note}}`);
    if (a.orcid) L.push(`\\orcid{${a.orcid}}`);
    if (a.email) L.push(`\\email{${a.email}}`);

    const f = a.affiliation;
    const fields = [];
    if (f.department) fields.push(`  \\department{${f.department}}`);
    fields.push(`  \\institution{${f.organization || f.raw || TODO('institution')}}`);
    if (f.addressline) fields.push(`  \\streetaddress{${f.addressline}}`);
    if (f.city) fields.push(`  \\city{${f.city}}`);
    if (f.state) fields.push(`  \\state{${f.state}}`);
    if (f.postcode) fields.push(`  \\postcode{${f.postcode}}`);
    fields.push(`  \\country{${f.country || TODO('country')}}`);
    L.push('\\affiliation{%', ...fields, '}', '');

    if (!f.country) {
      report.need(`\\country for ${a.name}`, 'acmart requires a country per affiliation');
    }
  }

  if (ir.abstract) L.push('\\begin{abstract}', ir.abstract, '\\end{abstract}', '');

  // CCS concepts cannot be invented: ACM's taxonomy tool generates the XML.
  if (ir.ccs.xml) {
    L.push('\\begin{CCSXML}', ir.ccs.xml, '\\end{CCSXML}');
    for (const d of ir.ccs.descs) L.push(`\\ccsdesc[${d.weight || 500}]{${d.value}}`);
    L.push('');
  } else {
    L.push('%% CCS concepts are required by ACM. Generate them at');
    L.push('%% https://dl.acm.org/ccs and paste the CCSXML block here.');
    L.push(`%% ${TODO('CCS concepts')}`, '');
    report.need('CCS concepts', 'required by ACM; generated at dl.acm.org/ccs, not derivable from the source');
  }

  if (ir.keywords.length) L.push(`\\keywords{${ir.keywords.join(', ')}}`, '');

  L.push('\\maketitle', '');

  if (ir.teaser) L.push('\\begin{teaserfigure}', ir.teaser, '\\end{teaserfigure}', '');

  // Anything the source venue had that ACM has no concept of.
  if (ir.highlights.length) {
    L.push(preserve('Elsevier research highlights',
      ir.highlights.map((h) => `\\item ${h}`).join('\n')), '');
    report.drop('Research highlights', 'ACM templates have no highlights section');
  }
  if (ir.graphicalAbstract) {
    L.push(preserve('Elsevier graphical abstract', ir.graphicalAbstract), '');
    report.drop('Graphical abstract', 'ACM templates have no graphical abstract');
  }

  let body = ir.body;
  if (ir.bib.style && ir.bib.style !== 'ACM-Reference-Format') {
    body = body.replace(/(\\bibliographystyle\s*\{)[^}]*(\})/,
      '$1ACM-Reference-Format$2');
    report.map('Bibliography style', `${ir.bib.style} → ACM-Reference-Format`);
  }

  L.push(body.replace(/^\n+/, ''));
  L.push('\\end{document}');
  return L.join('\n');
}
