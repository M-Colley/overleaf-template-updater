/* llncs profile — Springer Lecture Notes in Computer Science.
 *
 * Front-matter shape (Springer ships no sample .tex on CTAN — the bundle is
 * llncs.cls, its documentation PDF and splncs04.bst — so this comes from the
 * class's own definitions):
 *
 *   \documentclass[runningheads]{llncs}
 *   \begin{document}
 *   \title{Contribution Title\thanks{Supported by ...}}
 *   \titlerunning{Abbreviated title}
 *   \author{First Author\inst{1}\orcidID{0000-...} \and
 *           Second Author\inst{2}\orcidID{1111-...}}
 *   \authorrunning{F. Author et al.}
 *   \institute{Princeton University, Princeton NJ 08544, USA \and
 *              Springer, Heidelberg, Germany\\ \email{lncs@springer.com}}
 *   \maketitle
 *   \begin{abstract}
 *   ...
 *   \keywords{First keyword \and Second keyword}
 *   \end{abstract}
 *
 * Two things make llncs structurally unlike most other venues:
 *
 *   1. All authors live in ONE \author{}, all institutions in ONE \institute{},
 *      each split by \and, and they are linked POSITIONALLY by \inst{n}. So a
 *      shared affiliation is written once and referenced twice — which means
 *      emitting llncs has to deduplicate affiliations and renumber, and parsing
 *      it has to resolve the indices back out.
 *   2. \keywords lives INSIDE the abstract environment, so it must be lifted out
 *      of the abstract text rather than found beside it.
 */

import {
  findCommand, findCommands, extractEnv, documentClass, packages,
  tidy, splitList, splitOnCommand, stripCommand,
} from './latex.js';
import {
  makeIR, makeAffiliation, preserveRest, retargetBibStyle, TODO, abbreviateName,
  affiliationFromText, affiliationText, numberAffiliations,
} from './ir.js';
import { reconcile } from './packages.js';

export const id = 'llncs';
export const name = 'Springer Lecture Notes in Computer Science (llncs)';
export const detect = (cls) => cls === 'llncs';

/* llncs is a lean class: it sets Springer's page geometry and little else. */
const CLASS_PROVIDES = new Set(['geometry']);

const FORMATS = new Set(['runningheads', 'orivec', 'envcountsame', 'envcountchap',
  'envcountreset', 'oribibl', 'a4paper', 'letterpaper', 'final', 'draft',
  '10pt', '11pt', '12pt', 'fleqn', 'leqno']);

/* ------------------------------------------------------------------- parse */

/** "Princeton University, Princeton NJ 08544, USA" -> fields, best effort. */
function parseInstitute(raw) {
  const email = findCommand(raw, 'email', 1);
  let text = raw;
  if (email) text = stripCommand(text, 'email', 1);
  text = stripCommand(text, 'url', 1);
  return { affiliation: affiliationFromText(text), email: email ? tidy(email.args[0]) : null };
}

export function parse(text, report) {
  const ir = makeIR(id);

  const cls = documentClass(text);
  ir.classOptions = cls ? cls.options : [];

  const bd = text.match(/\\begin\s*\{document\}/);
  const preamble = bd ? text.slice(0, bd.index) : text;
  const afterBegin = bd ? text.slice(bd.index + bd[0].length) : '';

  for (const p of packages(preamble)) ir.packages.push(p);

  // Title, with \thanks lifted out.
  const title = findCommand(afterBegin, 'title', 1);
  if (title) {
    let t = title.args[0];
    const thanks = findCommand(t, 'thanks', 1);
    if (thanks) {
      ir.titleNote = tidy(thanks.args[0]);
      t = t.slice(0, thanks.start) + t.slice(thanks.end);
    }
    ir.title = tidy(t);
  }
  const runningTitle = findCommand(afterBegin, 'titlerunning', 1);
  if (runningTitle) ir.shortTitle = tidy(runningTitle.args[0]);

  // Institutions first, so authors can resolve their \inst indices into them.
  const instituteCmd = findCommand(afterBegin, 'institute', 1);
  const institutes = instituteCmd
    ? splitOnCommand(instituteCmd.args[0], 'and').map(parseInstitute)
    : [];

  const claimedEmail = new Set();
  const authorCmd = findCommand(afterBegin, 'author', 1);
  if (authorCmd) {
    for (const chunk of splitOnCommand(authorCmd.args[0], 'and')) {
      const orcid = findCommand(chunk, 'orcidID', 1);
      const inst = findCommand(chunk, 'inst', 1);
      // Springer's documented per-author footnote: Name\inst{1}\fnmsep\thanks{..}
      const thanks = findCommand(chunk, 'thanks', 1);

      const indices = inst
        ? splitList(inst.args[0], ',').map((n) => parseInt(n, 10)).filter(Number.isFinite)
        : [];

      let plain = stripCommand(chunk, 'orcidID', 1);
      plain = stripCommand(plain, 'inst', 1);
      plain = stripCommand(plain, 'thanks', 1);
      plain = stripCommand(plain, 'fnmsep', 0);
      const nameText = tidy(plain.replace(/\\\\/g, ' '));
      if (!nameText) continue;

      // \inst is 1-based; an author with several gets the first, and the rest
      // are reported rather than silently dropped.
      const index = indices.length ? indices[0] - 1 : 0;
      const primary = institutes[index];
      if (indices.length > 1) {
        report.warn(`${nameText} lists ${indices.length} affiliations ` +
          `(\\inst{${indices.join(',')}}). Only the first is carried across; ` +
          `the others are in the preserved \\institute block.`);
      }

      // In llncs the \email sits inside the \institute block, not beside the
      // author, so two people at one institution share one address in the
      // source. Giving it to both would attribute someone else's email to the
      // second author, so only the first to claim an institution gets it.
      let email = null;
      if (primary && primary.email && !claimedEmail.has(index)) {
        email = primary.email;
        claimedEmail.add(index);
      } else if (primary && primary.email) {
        report.warn(`${nameText} shares an institution with an earlier author, ` +
          `and llncs attaches the email address to the institution rather than ` +
          `the person — so no address could be carried across for them.`);
      }

      ir.authors.push({
        name: nameText,
        email,
        orcid: orcid ? tidy(orcid.args[0]) : null,
        note: thanks ? tidy(thanks.args[0]) : null,
        affiliation: primary ? primary.affiliation : makeAffiliation(),
      });
    }
  }

  // Abstract, and the \keywords that conventionally lives inside it.
  const abs = extractEnv(afterBegin, 'abstract');
  if (abs) {
    let inner = abs.inner;
    const kw = findCommand(inner, 'keywords', 1);
    if (kw) {
      ir.keywords = splitOnCommand(kw.args[0], 'and')
        .map((k) => tidy(k).replace(/[.\u00b7]+$/, ''))
        .filter(Boolean);
      inner = inner.slice(0, kw.start) + inner.slice(kw.end);
    }
    ir.abstract = inner.trim();
  }
  // Some authors put \keywords after \end{abstract} instead.
  if (!ir.keywords.length) {
    const kw = findCommand(afterBegin, 'keywords', 1);
    if (kw) ir.keywords = splitOnCommand(kw.args[0], 'and').map(tidy).filter(Boolean);
  }

  const mt = afterBegin.search(/\\maketitle/);
  let body = mt >= 0 ? afterBegin.slice(mt + '\\maketitle'.length) : afterBegin;
  body = body.replace(/\\end\s*\{document\}\s*$/, '');
  // The abstract sits after \maketitle in llncs, so remove it from the body.
  if (abs && abs.start > mt) {
    const rel = body.indexOf('\\begin{abstract}');
    if (rel >= 0) {
      const end = body.indexOf('\\end{abstract}', rel);
      if (end >= 0) body = body.slice(0, rel) + body.slice(end + '\\end{abstract}'.length);
    }
  }

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

  const known = ir.classOptions.filter((o) => FORMATS.has(o));
  const foreign = ir.classOptions.filter((o) => !known.includes(o));
  const opts = known.length ? known : ['runningheads'];
  if (foreign.length) {
    report.drop(`Class options \`${foreign.join(', ')}\``,
      `not llncs options; using \`${opts.join(',')}\``);
  }
  L.push(`\\documentclass[${opts.join(',')}]{llncs}`, '');

  // splncs04 is numeric; natbib without `numbers` would stop on it.
  const { lines } = reconcile(ir, CLASS_PROVIDES, report, { venue: id, options: { natbib: 'numbers' } });
  if (lines.length) L.push(...lines, '');
  const bibAt = L.length;

  L.push('\\begin{document}', '');
  L.push(`\\title{${ir.title || TODO('title')}${
    ir.titleNote ? `\\thanks{${ir.titleNote}}` : ''}}`);
  if (ir.shortTitle) L.push(`\\titlerunning{${ir.shortTitle}}`);
  L.push('');

  // llncs references affiliations by index, so identical ones are written once
  // and shared. The address is keyed on its own and emails are attached
  // afterwards: two authors at one institution are one \institute entry even
  // when only one of them lists an address, and keying on the pair would emit
  // the institution twice.
  const { list, labelOf } = numberAffiliations(ir.authors);
  const emailsFor = list.map(() => []);
  for (const a of ir.authors) {
    const mails = emailsFor[labelOf(a) - 1];
    if (a.email && !mails.includes(a.email)) mails.push(a.email);
  }
  const instLines = list.map((f, i) => {
    const addr = affiliationText(f);
    return emailsFor[i].length ? `${addr}\\\\\n\\email{${emailsFor[i].join(', ')}}` : addr;
  });

  if (ir.authors.length) {
    const parts = ir.authors.map((a) =>
      `${a.name}\\inst{${labelOf(a)}}` +
      (a.orcid ? `\\orcidID{${a.orcid}}` : '') +
      (a.note ? `\\fnmsep\\thanks{${a.note}}` : ''));
    L.push('\\author{' + parts.join(' \\and\n        ') + '}');
    if (ir.authors.some((a) => a.note)) {
      report.map('Author notes', 'carried as \\fnmsep\\thanks, as Springer documents');
    }

    // Springer wants an abbreviated running author list once there are several.
    if (ir.authors.length > 3) {
      L.push(`\\authorrunning{${abbreviateName(ir.authors[0].name)} et al.}`);
    }
    L.push('');
    L.push('\\institute{' + instLines.join(' \\and\n           ') + '}', '');

    if (instLines.some((l) => l.includes('TODO-venue-shift'))) {
      report.need('An institution', 'llncs requires an \\institute entry per affiliation');
    }
  }

  L.push('\\maketitle', '');

  // \keywords belongs inside the abstract in llncs.
  if (ir.abstract || ir.keywords.length) {
    L.push('\\begin{abstract}');
    if (ir.abstract) L.push(ir.abstract);
    if (ir.keywords.length) {
      L.push('', `\\keywords{${ir.keywords.join(' \\and ')}}`);
      report.map('Keywords', 'moved inside the abstract and \\and-separated, as llncs expects');
    }
    L.push('\\end{abstract}', '');
  }

  // Constructs llncs has no concept of.
  L.push(...preserveRest(ir, report, 'Springer', new Set(['titleNote'])));

  const { body, preambleLine } = retargetBibStyle(ir, report, 'splncs04');
  if (preambleLine) L.splice(bibAt, 0, preambleLine, '');

  L.push(body.replace(/^\n+/, ''));
  L.push('\\end{document}');
  return L.join('\n');
}
