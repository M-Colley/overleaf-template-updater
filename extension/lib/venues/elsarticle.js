/* elsarticle profile — Elsevier's journal template.
 *
 * Front-matter shape, from CTAN's elsarticle-template-num.tex:
 *
 *   \documentclass[preprint,12pt]{elsarticle}
 *   \journal{Journal Name}
 *   \begin{document}
 *   \begin{frontmatter}
 *   \title{}
 *   \author{}  \ead{}
 *   \affiliation{organization={}, addressline={}, city={},
 *                postcode={}, state={}, country={}}
 *   \begin{abstract}..\end{abstract}
 *   \begin{graphicalabstract}..\end{graphicalabstract}
 *   \begin{highlights}\item ..\end{highlights}
 *   \begin{keyword} a \sep b \end{keyword}
 *   \end{frontmatter}
 */

import {
  findCommand, findCommands, extractEnv,
  documentClass, packages, tidy, splitList,
} from './latex.js';
import {
  makeIR, makeAffiliation, preserve, preserveRest, retargetBibStyle, TODO,
} from './ir.js';
import { reconcile } from './packages.js';

export const id = 'elsarticle';
export const name = 'Elsevier Article (elsarticle)';
export const detect = (cls) => cls === 'elsarticle';

const CLASS_PROVIDES = new Set([
  'hyperref', 'geometry', 'natbib', 'graphicx', 'fontenc', 'inputenc',
]);

/** Elsevier ships three styles; numeric is the common default. */
export const BIB_STYLES = new Set(['elsarticle-num', 'elsarticle-harv', 'elsarticle-num-names']);

/* ------------------------------------------------------------------- parse */

export function parse(text, report) {
  const ir = makeIR(id);

  const cls = documentClass(text);
  ir.classOptions = cls ? cls.options : [];

  const bd = text.match(/\\begin\s*\{document\}/);
  const preamble = bd ? text.slice(0, bd.index) : text;
  const afterBegin = bd ? text.slice(bd.index + bd[0].length) : '';

  // Keep every package; the target emitter decides what is redundant.
  for (const p of packages(preamble)) ir.packages.push(p);

  const journal = findCommand(preamble, 'journal', 1);
  if (journal) ir.meta.journal = tidy(journal.args[0]);

  const fm = extractEnv(afterBegin, 'frontmatter');
  const front = fm ? fm.inner : afterBegin;

  const title = findCommand(front, 'title', 1);
  if (title) ir.title = tidy(title.args[0].replace(/\\tnoteref\s*\{[^}]*\}/g, ''));
  // \title{..\tnoteref{t1}} + \tnotetext[t1]{..}: Elsevier's title footnote.
  const tnote = findCommand(front, 'tnotetext', 1);
  if (tnote) ir.titleNote = tidy(tnote.args[0]);

  // Authors: \author{Name} followed by \ead / \affiliation until the next one.
  const authorCmds = findCommands(front, 'author', 1);
  for (let i = 0; i < authorCmds.length; i++) {
    const from = authorCmds[i].end;
    const to = i + 1 < authorCmds.length ? authorCmds[i + 1].start : front.length;
    const region = front.slice(from, to);

    const ead = findCommand(region, 'ead', 1);
    const aff = findCommand(region, 'affiliation', 1);

    const affiliation = makeAffiliation();
    if (aff) {
      // key={value} pairs, comma separated, values may contain braces.
      const inner = aff.args[0];
      for (const key of ['organization', 'department', 'addressline', 'city',
        'state', 'postcode', 'country']) {
        const m = new RegExp(key + '\\s*=\\s*\\{').exec(inner);
        if (!m) continue;
        let depth = 1, j = m.index + m[0].length, out = '';
        for (; j < inner.length && depth > 0; j++) {
          if (inner[j] === '{') depth++;
          else if (inner[j] === '}') { depth--; if (!depth) break; }
          out += inner[j];
        }
        affiliation[key] = tidy(out) || null;
      }
      if (!affiliation.organization && !affiliation.city) affiliation.raw = tidy(inner);
    }

    ir.authors.push({
      name: tidy(authorCmds[i].args[0]),
      // \ead is Elsevier's email command; \ead[url]{...} carries a homepage.
      email: ead && !ead.optional ? tidy(ead.args[0]) : null,
      orcid: null,
      note: null,
      affiliation,
    });
  }

  const abs = extractEnv(front, 'abstract');
  if (abs) ir.abstract = abs.inner.trim();

  const kw = extractEnv(front, 'keyword');
  if (kw) ir.keywords = splitList(kw.inner, 'sep');

  const hl = extractEnv(front, 'highlights');
  if (hl) {
    ir.highlights = hl.inner.split(/\\item\b/).map((s) => tidy(s)).filter(Boolean);
  }
  const ga = extractEnv(front, 'graphicalabstract');
  if (ga && ga.inner.trim()) ir.graphicalAbstract = ga.inner.trim();

  let body = fm ? afterBegin.slice(fm.end) : afterBegin;
  body = body.replace(/\\end\s*\{document\}\s*$/, '');

  const bibStyle = findCommand(body, 'bibliographystyle', 1);
  if (bibStyle) ir.bib.style = tidy(bibStyle.args[0]);
  const bibFiles = findCommand(body, 'bibliography', 1);
  if (bibFiles) ir.bib.files = splitList(bibFiles.args[0], ',');

  ir.body = body;
  return ir;
}

/* -------------------------------------------------------------------- emit */

/** Elsevier's key={value} affiliation fields, shared with the CAS templates. */
export function affiliationPairs(f) {
  const pairs = [];
  if (f.organization || f.raw) pairs.push(`organization={${f.organization || f.raw}}`);
  if (f.department) pairs.push(`department={${f.department}}`);
  if (f.addressline) pairs.push(`addressline={${f.addressline}}`);
  if (f.city) pairs.push(`city={${f.city}}`);
  if (f.postcode) pairs.push(`postcode={${f.postcode}}`);
  if (f.state) pairs.push(`state={${f.state}}`);
  if (f.country) pairs.push(`country={${f.country}}`);
  return pairs;
}

export function emit(ir, report) {
  const L = [];
  // acmart options (sigconf, review, anonymous...) mean nothing to elsarticle.
  const carried = ir.classOptions.filter((o) => ['review', 'preprint', '3p', '5p',
    'twocolumn', 'final', '1p'].includes(o));
  const opts = carried.length ? carried : ['preprint', '12pt'];
  if (ir.venue === 'acmart' && ir.classOptions.length) {
    report.drop(`Class options \`${ir.classOptions.join(', ')}\``,
      'ACM layout options have no elsarticle equivalent; using preprint,12pt');
  }
  L.push(`\\documentclass[${opts.join(',')}]{elsarticle}`, '');

  const { lines } = reconcile(ir, CLASS_PROVIDES, report, { venue: id });
  if (lines.length) L.push(...lines, '');
  const bibAt = L.length;

  L.push(`\\journal{${ir.meta.journal || TODO('target journal name')}}`);
  if (!ir.meta.journal) {
    report.need('\\journal', 'the Elsevier journal you are submitting to');
  }
  L.push('');

  L.push('\\begin{document}', '', '\\begin{frontmatter}', '');
  if (ir.titleNote) {
    L.push(`\\title{${ir.title || TODO('title')}\\tnoteref{t1}}`);
    L.push(`\\tnotetext[t1]{${ir.titleNote}}`, '');
    report.map('Title note', 'carried as an Elsevier \\tnotetext');
  } else {
    L.push(`\\title{${ir.title || TODO('title')}}`, '');
  }

  for (const a of ir.authors) {
    L.push(`\\author{${a.name}}`);
    if (a.email) L.push(`\\ead{${a.email}}`);

    L.push('\\affiliation{' + affiliationPairs(a.affiliation).join(',\n            ') + '}', '');

    if (a.orcid) {
      report.drop(`ORCID for ${a.name} (${a.orcid})`,
        'elsarticle has no ORCID command; Elsevier collects it in the submission system');
    }
    if (a.note) {
      L.push(preserve(`Author note for ${a.name}`, a.note), '');
      report.drop(`Author note for ${a.name}`, 'no direct elsarticle equivalent');
    }
  }

  if (ir.abstract) L.push('\\begin{abstract}', ir.abstract, '\\end{abstract}', '');

  // Highlights and a graphical abstract are expected by most Elsevier journals.
  if (ir.highlights.length) {
    L.push('\\begin{highlights}');
    for (const h of ir.highlights) L.push(`\\item ${h}`);
    L.push('\\end{highlights}', '');
  } else {
    L.push('\\begin{highlights}');
    L.push(`\\item ${TODO('research highlight 1 (max 85 characters)')}`);
    L.push(`\\item ${TODO('research highlight 2')}`);
    L.push(`\\item ${TODO('research highlight 3')}`);
    L.push('\\end{highlights}', '');
    report.need('Research highlights',
      'most Elsevier journals require 3-5 bullets of max 85 characters each');
  }

  if (ir.graphicalAbstract) {
    L.push('\\begin{graphicalabstract}', ir.graphicalAbstract, '\\end{graphicalabstract}', '');
  }

  if (ir.keywords.length) {
    L.push('\\begin{keyword}', ir.keywords.join(' \\sep '), '\\end{keyword}', '');
    report.map('Keywords', `comma-separated \\keywords → \\sep-separated keyword environment`);
  }

  // CCS concepts, a teaser figure and the like have no Elsevier counterpart.
  L.push(...preserveRest(ir, report, 'Elsevier',
    new Set(['titleNote', 'highlights', 'graphicalAbstract'])));

  L.push('\\end{frontmatter}', '');

  const { body, preambleLine } =
    retargetBibStyle(ir, report, 'elsarticle-num', [...BIB_STYLES]);
  if (preambleLine) L.splice(bibAt, 0, preambleLine, '');

  L.push(body.replace(/^\n+/, ''));
  L.push('\\end{document}');
  return L.join('\n');
}
