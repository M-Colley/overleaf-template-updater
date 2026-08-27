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
 * Two things make llncs structurally unlike the other three venues:
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
import { makeIR, makeAffiliation, preserve, TODO } from './ir.js';
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
  const affiliation = makeAffiliation();

  const email = findCommand(raw, 'email', 1);
  let text = raw;
  if (email) text = stripCommand(text, 'email', 1);
  text = stripCommand(text, 'url', 1);
  text = tidy(text.replace(/\\\\/g, ', ').replace(/\\(textit|textbf|emph)\s*\{([^}]*)\}/g, '$2'));

  const parts = text.split(',').map((s) => tidy(s)).filter(Boolean);
  if (parts.length >= 3) {
    affiliation.country = parts[parts.length - 1];
    affiliation.city = parts[parts.length - 2];
    affiliation.organization = parts.slice(0, -2).join(', ');
  } else if (parts.length === 2) {
    affiliation.organization = parts[0];
    affiliation.country = parts[1];
  } else if (parts.length === 1) {
    affiliation.organization = parts[0];
  }
  if (!affiliation.organization) affiliation.raw = text || null;

  return { affiliation, email: email ? tidy(email.args[0]) : null };
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

      const indices = inst
        ? splitList(inst.args[0], ',').map((n) => parseInt(n, 10)).filter(Number.isFinite)
        : [];

      let plain = stripCommand(chunk, 'orcidID', 1);
      plain = stripCommand(plain, 'inst', 1);
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
        note: null,
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

/**
 * One institution, in llncs's comma-separated house style. The address is
 * keyed on its own — emails are attached afterwards, because two authors at
 * one institution are one \institute entry even when only one of them lists
 * an address, and keying on the pair would emit the institution twice.
 */
function instituteAddress(f) {
  const parts = [f.organization || f.raw || TODO('institution')];
  if (f.department) parts.unshift(f.department);
  if (f.addressline) parts.push(f.addressline);
  if (f.city) parts.push([f.city, f.postcode].filter(Boolean).join(' '));
  if (f.state) parts.push(f.state);
  if (f.country) parts.push(f.country);
  return parts.filter(Boolean).join(', ');
}

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

  const { lines } = reconcile(ir, CLASS_PROVIDES, report);
  if (lines.length) L.push(...lines, '');

  L.push('\\begin{document}', '');
  L.push(`\\title{${ir.title || TODO('title')}${
    ir.titleNote ? `\\thanks{${ir.titleNote}}` : ''}}`);
  if (ir.shortTitle) L.push(`\\titlerunning{${ir.shortTitle}}`);
  L.push('');

  // llncs references affiliations by index, so identical ones are written once
  // and shared. Deduplicate on the address, gathering each institution's email
  // addresses as we go, then renumber.
  const addresses = [];
  const indexFor = new Map();
  const emailsFor = new Map();
  for (const a of ir.authors) {
    const addr = instituteAddress(a.affiliation);
    if (!indexFor.has(addr)) {
      addresses.push(addr);
      indexFor.set(addr, addresses.length);
      emailsFor.set(addr, []);
    }
    if (a.email && !emailsFor.get(addr).includes(a.email)) {
      emailsFor.get(addr).push(a.email);
    }
  }
  const instLines = addresses.map((addr) => {
    const mails = emailsFor.get(addr);
    return mails.length ? `${addr}\\\\\n\\email{${mails.join(', ')}}` : addr;
  });

  if (ir.authors.length) {
    const parts = ir.authors.map((a) => {
      const idx = indexFor.get(instituteAddress(a.affiliation));
      return `${a.name}\\inst{${idx}}` + (a.orcid ? `\\orcidID{${a.orcid}}` : '');
    });
    L.push('\\author{' + parts.join(' \\and\n        ') + '}');

    // Springer wants an abbreviated running author list once there are several.
    if (ir.authors.length > 3) {
      const first = ir.authors[0].name.split(/\s+/);
      const initials = first.slice(0, -1).map((w) => w[0] + '.').join(' ');
      L.push(`\\authorrunning{${initials} ${first[first.length - 1]} et al.}`);
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
  if (ir.ccs.xml || ir.ccs.descs.length) {
    const block = [ir.ccs.xml ? `\\begin{CCSXML}\n${ir.ccs.xml}\n\\end{CCSXML}` : '',
      ...ir.ccs.descs.map((d) => `\\ccsdesc[${d.weight || 500}]{${d.value}}`)]
      .filter(Boolean).join('\n');
    L.push(preserve('ACM CCS concepts', block), '');
    report.drop('CCS concepts', 'an ACM classification with no Springer equivalent');
  }
  if (ir.highlights.length) {
    L.push(preserve('Elsevier research highlights',
      ir.highlights.map((h) => `\\item ${h}`).join('\n')), '');
    report.drop('Research highlights', 'llncs has no highlights section');
  }
  if (ir.graphicalAbstract) {
    L.push(preserve('Elsevier graphical abstract', ir.graphicalAbstract), '');
    report.drop('Graphical abstract', 'llncs has no graphical abstract');
  }
  if (ir.teaser) {
    L.push(preserve('ACM teaser figure', ir.teaser), '');
    report.drop('Teaser figure', 'no llncs equivalent; reinsert as a normal figure');
  }

  let body = ir.body;
  if (ir.bib.style && ir.bib.style !== 'splncs04') {
    body = body.replace(/(\\bibliographystyle\s*\{)[^}]*(\})/, '$1splncs04$2');
    report.map('Bibliography style', `${ir.bib.style} → splncs04`);
  }

  L.push(body.replace(/^\n+/, ''));
  L.push('\\end{document}');
  return L.join('\n');
}
