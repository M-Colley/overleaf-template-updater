/* IEEEtran profile — IEEE conferences and transactions.
 *
 * Front-matter shape, from IEEE's own bare_conf.tex:
 *
 *   \documentclass[conference]{IEEEtran}
 *   \begin{document}
 *   \title{Title\\ second line}
 *   \author{\IEEEauthorblockN{Name}
 *   \IEEEauthorblockA{School of ...\\
 *   Georgia Institute of Technology\\
 *   Atlanta, Georgia 30332--0250\\
 *   Email: someone@example.org}
 *   \and
 *   \IEEEauthorblockN{Second Name} \IEEEauthorblockA{...}}
 *   \maketitle
 *   \begin{abstract}..\end{abstract}
 *   \begin{IEEEkeywords} a, b, c \end{IEEEkeywords}
 *
 * The hard part is \IEEEauthorblockA: unlike acmart's \institution/\city/
 * \country or elsarticle's key={value} pairs, it is free text separated by \\,
 * with no marked-up structure at all. Splitting it into fields is necessarily a
 * heuristic, so every affiliation parsed this way is flagged for review rather
 * than presented as reliable.
 */

import {
  findCommand, findCommands, extractEnv,
  documentClass, packages, tidy, splitList,
} from './latex.js';
import { makeIR, makeAffiliation, preserve, TODO } from './ir.js';
import { reconcile } from './packages.js';

export const id = 'ieeetran';
export const name = 'IEEE Transactions / Conference (IEEEtran)';
export const detect = (cls) => cls.toLowerCase() === 'ieeetran';

/* IEEEtran deliberately loads almost nothing -- it expects the author to load
 * their own packages. geometry is the exception worth refusing: IEEEtran sets
 * IEEE's exact margins and geometry silently overrides them, which is a desk
 * reject. */
const CLASS_PROVIDES = new Set(['geometry']);

const FORMATS = new Set(['conference', 'journal', 'technote', 'peerreview',
  'peerreviewca', 'draftcls', 'draftclsnofoot', 'comsoc', 'compsoc', 'transmag']);
const MODIFIERS = new Set(['onecolumn', 'twocolumn', 'a4paper', 'letterpaper',
  '9pt', '10pt', '11pt', '12pt', 'draft', 'final', 'romanappendices',
  'captionsoff', 'nofonttune']);

/* ------------------------------------------------------------------- parse */

const EMAIL_LINE = /^(?:e-?mail|email)\s*[:.]?\s*(.+)$/i;
const CONTACT_LINE = /^(?:telephone|phone|tel|fax)\s*[:.]/i;

/**
 * Best-effort split of an \IEEEauthorblockA free-text block into fields.
 * Returns the affiliation plus an email if one was recognisable.
 */
function parseAuthorBlock(raw) {
  const affiliation = makeAffiliation();
  let email = null;

  const lines = raw
    .split(/\\\\/)
    .map((l) => tidy(l.replace(/\\(textit|textbf|emph)\s*\{([^}]*)\}/g, '$2')))
    .filter(Boolean);

  const leftover = [];
  for (const line of lines) {
    const m = EMAIL_LINE.exec(line);
    if (m) {
      const candidate = tidy(m[1]);
      // "Email: http://..." happens in IEEE's own sample; only take addresses.
      if (candidate.includes('@')) email = candidate;
      else leftover.push(line);
      continue;
    }
    if (line.includes('@') && !line.includes(' ')) { email = line; continue; }
    if (CONTACT_LINE.test(line)) { leftover.push(line); continue; }
    leftover.push(line);
  }

  // The last comma-bearing line is conventionally "City, State ZIP" or
  // "City, Country"; everything before it is the organisation.
  let placeIndex = -1;
  for (let i = leftover.length - 1; i >= 0; i--) {
    if (leftover[i].includes(',') && !CONTACT_LINE.test(leftover[i])) { placeIndex = i; break; }
  }

  if (placeIndex >= 0) {
    const parts = leftover[placeIndex].split(',').map((s) => tidy(s));
    affiliation.city = parts[0] || null;
    const tail = parts.slice(1).join(', ').trim();
    if (tail) {
      // "Georgia 30332-0250" -> state + postcode; "Country" -> country.
      const zip = tail.match(/^(.*?)[\s,]+([0-9][0-9-–—]{2,})$/);
      if (zip) { affiliation.state = tidy(zip[1]) || null; affiliation.postcode = tidy(zip[2]); }
      else affiliation.country = tail;
    }
    const org = leftover.slice(0, placeIndex).filter((l) => !CONTACT_LINE.test(l));
    if (org.length) affiliation.organization = org.join(', ');
  } else {
    const org = leftover.filter((l) => !CONTACT_LINE.test(l));
    if (org.length) affiliation.organization = org.join(', ');
  }

  if (!affiliation.organization) affiliation.raw = tidy(raw);
  return { affiliation, email };
}

export function parse(text, report) {
  const ir = makeIR(id);

  const cls = documentClass(text);
  ir.classOptions = cls ? cls.options : [];

  const bd = text.match(/\\begin\s*\{document\}/);
  const preamble = bd ? text.slice(0, bd.index) : text;
  const afterBegin = bd ? text.slice(bd.index + bd[0].length) : '';

  for (const p of packages(preamble)) ir.packages.push(p);

  // Title. IEEE titles routinely carry a \thanks{} for funding notes and a
  // \\-separated second line.
  const title = findCommand(afterBegin, 'title', 1);
  if (title) {
    let t = title.args[0];
    const thanks = findCommand(t, 'thanks', 1);
    if (thanks) {
      ir.titleNote = tidy(thanks.args[0]);
      t = t.slice(0, thanks.start) + t.slice(thanks.end);
    }
    ir.title = tidy(t.replace(/\\\\/g, ' ').replace(/\s+/g, ' '));
  }

  // Authors: one \IEEEauthorblockN per author, each optionally followed by an
  // \IEEEauthorblockA. \and separates them but is not always present.
  const author = findCommand(afterBegin, 'author', 1);
  if (author) {
    const inner = author.args[0];
    const names = findCommands(inner, 'IEEEauthorblockN', 1);
    let heuristic = 0;

    for (let i = 0; i < names.length; i++) {
      const from = names[i].end;
      const to = i + 1 < names.length ? names[i + 1].start : inner.length;
      const region = inner.slice(from, to);
      const block = findCommand(region, 'IEEEauthorblockA', 1);

      let affiliation = makeAffiliation();
      let email = null;
      if (block) {
        const parsed = parseAuthorBlock(block.args[0]);
        affiliation = parsed.affiliation;
        email = parsed.email;
        heuristic++;
      }

      ir.authors.push({
        name: tidy(names[i].args[0].replace(/\\\\/g, ' ')),
        email, orcid: null, note: null, affiliation,
      });
    }

    if (!names.length) {
      // A journal-style \author{A, B and C} with no blocks.
      const plain = tidy(inner.replace(/\\IEEEmembership\s*\{[^}]*\}/g, ''));
      if (plain) {
        for (const n of plain.split(/,| and /).map(tidy).filter(Boolean)) {
          ir.authors.push({ name: n, email: null, orcid: null, note: null,
            affiliation: makeAffiliation() });
        }
        report.warn('Authors came from a journal-style \\author list, so no ' +
          'affiliations could be recovered. You will need to add them.');
      }
    }

    if (heuristic) {
      report.warn(`${heuristic} affiliation${heuristic === 1 ? '' : 's'} were ` +
        'split out of IEEE author blocks, which are free text with no marked-up ' +
        'fields. Check the institution, city and country came out right.');
    }
  }

  const abs = extractEnv(afterBegin, 'abstract');
  if (abs) ir.abstract = abs.inner.trim();

  const kw = extractEnv(afterBegin, 'IEEEkeywords');
  if (kw) ir.keywords = splitList(kw.inner, ',');

  const mt = afterBegin.search(/\\maketitle/);
  let body = mt >= 0 ? afterBegin.slice(mt + '\\maketitle'.length) : afterBegin;
  body = body.replace(/\\end\s*\{document\}\s*$/, '');
  // These sit between \maketitle and the first section and are IEEE-only.
  body = body.replace(/\\IEEEpeerreviewmaketitle\s*/g, '');

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

  const known = ir.classOptions.filter((o) => FORMATS.has(o) || MODIFIERS.has(o));
  const foreign = ir.classOptions.filter((o) => !known.includes(o));
  const opts = known.some((o) => FORMATS.has(o)) ? known : ['conference', ...known];
  if (foreign.length) {
    report.drop(`Class options \`${foreign.join(', ')}\``,
      `not IEEEtran options; using \`${opts.join(',')}\``);
  }
  L.push(`\\documentclass[${opts.join(',')}]{IEEEtran}`, '');

  const { lines } = reconcile(ir, CLASS_PROVIDES, report);
  if (lines.length) L.push(...lines, '');

  L.push('\\begin{document}', '');
  L.push(`\\title{${ir.title || TODO('title')}${
    ir.titleNote ? `\\thanks{${ir.titleNote}}` : ''}}`, '');

  if (ir.authors.length) {
    L.push('\\author{');
    ir.authors.forEach((a, i) => {
      if (i) L.push('\\and');
      L.push(`\\IEEEauthorblockN{${a.name}}`);

      const f = a.affiliation;
      const parts = [];
      if (f.department) parts.push(`\\textit{${f.department}}`);
      if (f.organization || f.raw) parts.push(`\\textit{${f.organization || f.raw}}`);
      const place = [f.city, f.state, f.country].filter(Boolean).join(', ');
      if (place) parts.push(place);
      if (a.email) parts.push(a.email);
      if (!parts.length) parts.push(TODO('affiliation'));

      L.push(`\\IEEEauthorblockA{${parts.join('\\\\\n')}}`);

      if (a.orcid) {
        report.drop(`ORCID for ${a.name}`,
          'IEEEtran has no ORCID command; IEEE collects it in the submission system');
      }
      if (a.note) {
        report.drop(`Author note for ${a.name}`,
          'IEEEtran has no per-author note; consider \\thanks on the title');
      }
    });
    L.push('}', '');
  }

  L.push('\\maketitle', '');

  if (ir.abstract) L.push('\\begin{abstract}', ir.abstract, '\\end{abstract}', '');

  if (ir.keywords.length) {
    L.push('\\begin{IEEEkeywords}', ir.keywords.join(', '), '\\end{IEEEkeywords}', '');
    report.map('Keywords', 'emitted as an IEEEkeywords environment');
  }

  // Constructs IEEE has no concept of.
  if (ir.ccs.xml || ir.ccs.descs.length) {
    const block = [ir.ccs.xml ? `\\begin{CCSXML}\n${ir.ccs.xml}\n\\end{CCSXML}` : '',
      ...ir.ccs.descs.map((d) => `\\ccsdesc[${d.weight || 500}]{${d.value}}`)]
      .filter(Boolean).join('\n');
    L.push(preserve('ACM CCS concepts', block), '');
    report.drop('CCS concepts', 'an ACM classification with no IEEE equivalent');
  }
  if (ir.highlights.length) {
    L.push(preserve('Elsevier research highlights',
      ir.highlights.map((h) => `\\item ${h}`).join('\n')), '');
    report.drop('Research highlights', 'IEEE templates have no highlights section');
  }
  if (ir.graphicalAbstract) {
    L.push(preserve('Elsevier graphical abstract', ir.graphicalAbstract), '');
    report.drop('Graphical abstract', 'IEEE templates have no graphical abstract');
  }
  if (ir.teaser) {
    L.push(preserve('ACM teaser figure', ir.teaser), '');
    report.drop('Teaser figure', 'no IEEEtran equivalent; reinsert as a normal figure');
  }

  let body = ir.body;
  if (ir.bib.style && ir.bib.style !== 'IEEEtran') {
    body = body.replace(/(\\bibliographystyle\s*\{)[^}]*(\})/, '$1IEEEtran$2');
    report.map('Bibliography style', `${ir.bib.style} → IEEEtran`);
  }

  L.push(body.replace(/^\n+/, ''));
  L.push('\\end{document}');
  return L.join('\n');
}
