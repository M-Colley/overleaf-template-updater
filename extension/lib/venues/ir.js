/* The venue-neutral intermediate representation.
 *
 * Every venue profile parses INTO this and emits FROM it, so adding a venue
 * costs one parser and one emitter rather than a converter per pair.
 *
 * The body is carried verbatim and is never rewritten, with exactly one
 * exception: the argument of \bibliographystyle, because leaving
 * ACM-Reference-Format in an Elsevier submission simply fails to compile. That
 * substitution is reported like any other change.
 */

import { tidy, findCommand } from './latex.js';

export function makeIR(venue) {
  return {
    venue,
    classOptions: [],

    title: null,
    shortTitle: null,
    /**
     * A note on the title itself -- \thanks in IEEEtran and llncs, \tnotetext
     * in Elsevier and CEUR-WS, \funding in LIPIcs. Nearly always the funding
     * acknowledgement, which is exactly what must not vanish in conversion.
     */
    titleNote: null,

    /** @type {Array<{name, email, orcid, note, credit?, affiliation}>} */
    authors: [],

    abstract: null,
    keywords: [],

    // ACM CCS concepts. LIPIcs uses the same \ccsdesc taxonomy, without the XML.
    ccs: { xml: null, descs: [] },
    teaser: null,

    // Elsevier-specific
    highlights: [],
    graphicalAbstract: null,

    /** LIPIcs keeps acknowledgements in the front matter, not the body. */
    acknowledgements: null,

    /**
     * Venue/publication metadata; only some fields are meaningful per venue.
     * This identifies the SOURCE venue, so it is not carried to a different
     * one: a CHI paper's \acmConference is not the workshop it is going to.
     */
    meta: {
      journal: null,
      conference: null,      // full \acmConference argument set, raw
      conferenceText: null,  // a one-line event description (CEUR-WS \conference)
      copyright: null,
      copyrightYear: null,
      acmYear: null,
      doi: null,
      isbn: null,
    },

    packages: [],            // {names[], options, raw}
    preambleExtras: [],      // unrecognised preamble lines, preserved verbatim
    bib: { style: null, files: [] },
    body: '',
  };
}

export function makeAffiliation() {
  return {
    organization: null,   // acmart \institution / elsarticle organization=
    department: null,
    addressline: null,
    city: null,
    state: null,
    postcode: null,
    country: null,
    raw: null,            // whatever could not be split into fields
  };
}

/**
 * A structured account of the conversion, so the author can see what was
 * translated, what could not be, and what they must supply themselves.
 */
export class Report {
  constructor() {
    this.mapped = [];
    this.dropped = [];
    this.todo = [];
    this.warnings = [];
  }

  /** A concept that carried across cleanly. */
  map(what, detail) { this.mapped.push({ what, detail }); }

  /** A concept with no equivalent in the target. Always preserved as a comment. */
  drop(what, why) { this.dropped.push({ what, why }); }

  /** Something the target requires that only the author can supply. */
  need(what, why) { this.todo.push({ what, why }); }

  warn(message) { this.warnings.push(message); }

  get hasBlockers() { return this.todo.length > 0; }

  /** Rendered as a Markdown checklist alongside the converted file. */
  toMarkdown(from, to, outFile) {
    const L = [];
    L.push(`# Template migration: ${from} to ${to}`, '');
    L.push(`Converted front matter written to \`${outFile}\`. Your original file`);
    L.push('was not modified, and the body of the document was carried across', 'verbatim.', '');

    if (this.todo.length) {
      L.push(`## You must fill these in (${this.todo.length})`, '');
      L.push('The target template requires these and they cannot be derived from');
      L.push('the source. Each is marked `TODO` in the converted file.', '');
      for (const t of this.todo) L.push(`- [ ] **${t.what}** — ${t.why}`);
      L.push('');
    }

    if (this.dropped.length) {
      L.push(`## Dropped, and why (${this.dropped.length})`, '');
      L.push('These have no equivalent in the target. Nothing was deleted — each');
      L.push('is preserved as a comment in the converted file so you can recover it.', '');
      for (const d of this.dropped) L.push(`- **${d.what}** — ${d.why}`);
      L.push('');
    }

    if (this.warnings.length) {
      L.push(`## Worth checking (${this.warnings.length})`, '');
      for (const w of this.warnings) L.push(`- ${w}`);
      L.push('');
    }

    if (this.mapped.length) {
      L.push(`## Translated automatically (${this.mapped.length})`, '');
      for (const m of this.mapped) {
        L.push(`- ${m.what}${m.detail ? ` — ${m.detail}` : ''}`);
      }
      L.push('');
    }

    return L.join('\n');
  }
}

/** Comment out a block of LaTeX, tagged so it is greppable and recoverable. */
export function preserve(label, text) {
  const lines = String(text).split('\n');
  return [
    `% [venue-shift] ${label} — no equivalent in the target template.`,
    `% Preserved verbatim below so nothing is lost.`,
    ...lines.map((l) => '% ' + l),
  ].join('\n');
}

export const TODO = (what) => `TODO-venue-shift: ${what}`;

/* --------------------------------------------------- free-text affiliations */

const POSTCODE = /^\d{3,}(?:[\s-]\d+)?$/;

/**
 * Split a free-text affiliation -- "Institute of Media Informatics, Ulm
 * University, Ulm, Germany" -- into fields. llncs, LIPIcs and CEUR-WS all
 * write affiliations as plain text with no marked-up structure, so this is a
 * heuristic: the last part is the country, the one before it the city, and
 * everything ahead of that the organisation. A part that is only a postcode
 * (CEUR's own sample: "..., Moscow, 117198, Russian Federation") is taken as
 * one rather than as the city.
 */
export function affiliationFromText(text) {
  const affiliation = makeAffiliation();
  const clean = tidy(String(text || '')
    .replace(/\\\\/g, ', ')
    .replace(/\\(textit|textbf|emph)\s*\{([^}]*)\}/g, '$2'));

  const parts = clean.split(',').map((s) => tidy(s)).filter(Boolean);
  if (parts.length >= 3) {
    affiliation.country = parts.pop();
    if (parts.length >= 3 && POSTCODE.test(parts[parts.length - 1])) {
      affiliation.postcode = parts.pop();
    }
    affiliation.city = parts.pop();
    affiliation.organization = parts.join(', ');
  } else if (parts.length === 2) {
    affiliation.organization = parts[0];
    affiliation.country = parts[1];
  } else if (parts.length === 1) {
    affiliation.organization = parts[0];
  }
  if (!affiliation.organization) affiliation.raw = clean || null;
  return affiliation;
}

/** The inverse: one affiliation as a comma-separated line. */
export function affiliationText(f) {
  const parts = [f.organization || f.raw || TODO('institution')];
  if (f.department) parts.unshift(f.department);
  if (f.addressline) parts.push(f.addressline);
  if (f.city) parts.push([f.city, f.postcode].filter(Boolean).join(' '));
  else if (f.postcode) parts.push(f.postcode);
  if (f.state) parts.push(f.state);
  if (f.country) parts.push(f.country);
  return parts.filter(Boolean).join(', ');
}

/**
 * Number the distinct affiliations, so venues that link authors to them by
 * label (llncs \inst, Elsevier CAS and CEUR-WS [n]) write a shared one once.
 * @returns {{list: object[], labelOf: (author) => number}}
 */
export function numberAffiliations(authors) {
  const list = [];
  const index = new Map();
  for (const a of authors) {
    const key = affiliationText(a.affiliation);
    if (!index.has(key)) { list.push(a.affiliation); index.set(key, list.length); }
  }
  return { list, labelOf: (a) => index.get(affiliationText(a.affiliation)) };
}

/** "https://orcid.org/0000-0001-5207-5029" and "0000-0001-5207-5029" alike. */
export function orcidId(s) {
  const m = String(s || '').match(/\d{4}-\d{4}-\d{4}-\d{3}[\dX]/);
  return m ? m[0] : null;
}

/** "key=value, key={a, b}" option lists, as in Elsevier CAS and CEUR-WS \author[..]{..}[..]. */
export function keyValues(s) {
  const out = {};
  let depth = 0, cur = '';
  const flush = () => {
    const m = cur.match(/^\s*([A-Za-z]+)\s*=\s*([\s\S]*?)\s*$/);
    if (m) out[m[1].toLowerCase()] = m[2].replace(/^\{([\s\S]*)\}$/, '$1').trim();
    cur = '';
  };
  // CEUR's own sample opens the list with "[%" -- a comment, not a key.
  for (const c of String(s || '').replace(/(^|[^\\])%[^\n]*/g, '$1')) {
    if (c === '{') depth++;
    else if (c === '}') depth--;
    if (c === ',' && depth === 0) { flush(); continue; }
    cur += c;
  }
  flush();
  return out;
}

/* -------------------------------------- what the target has no place for */

/**
 * Front-matter concepts a target has no slot for, preserved as tagged comments
 * and reported -- so a concept cannot fall through an emitter that forgot
 * about it. That is not hypothetical: a title's funding \thanks was silently
 * lost in four of the six original conversion directions.
 *
 * @param {object} ir
 * @param {Report} report
 * @param {string} target      how the target is named in messages, e.g. 'IEEE'
 * @param {Set<string>} handles concepts the caller emits itself
 * @returns {string[]} comment blocks, each followed by a blank line
 */
export function preserveRest(ir, report, target, handles) {
  const L = [];
  const keep = (label, text) => L.push(preserve(label, text), '');

  if (!handles.has('titleNote') && ir.titleNote) {
    keep('Title note', ir.titleNote);
    report.drop('Title note', `${target} has no title footnote; a funding note ` +
      'belongs in the acknowledgements');
  }
  if (!handles.has('ccs') && (ir.ccs.xml || ir.ccs.descs.length)) {
    keep('ACM CCS concepts', [
      ir.ccs.xml ? `\\begin{CCSXML}\n${ir.ccs.xml}\n\\end{CCSXML}` : '',
      ...ir.ccs.descs.map((d) => `\\ccsdesc[${d.weight || 500}]{${d.value}}`),
    ].filter(Boolean).join('\n'));
    report.drop('CCS concepts', `an ACM classification with no ${target} equivalent`);
  }
  if (!handles.has('highlights') && ir.highlights.length) {
    keep('Elsevier research highlights', ir.highlights.map((h) => `\\item ${h}`).join('\n'));
    report.drop('Research highlights', `${target} has no highlights section`);
  }
  if (!handles.has('graphicalAbstract') && ir.graphicalAbstract) {
    keep('Elsevier graphical abstract', ir.graphicalAbstract);
    report.drop('Graphical abstract', `${target} has no graphical abstract`);
  }
  if (!handles.has('teaser') && ir.teaser) {
    keep('ACM teaser figure', ir.teaser);
    report.drop('Teaser figure', `no ${target} equivalent; reinsert it as a normal figure`);
  }
  if (!handles.has('credit')) {
    for (const a of ir.authors) {
      if (!a.credit) continue;
      keep(`CRediT statement for ${a.name}`, a.credit);
      report.drop(`CRediT statement for ${a.name}`, `${target} has no per-author ` +
        'contribution field; journals that require one ask for it in the text');
    }
  }
  if (!handles.has('acknowledgements') && ir.acknowledgements) {
    keep('Acknowledgements (from the front matter)', ir.acknowledgements);
    report.drop('Acknowledgements', 'LIPIcs keeps them in the front matter; move ' +
      'them into an acknowledgements section in the body');
  }
  return L;
}

/**
 * Point the document at the target's bibliography style.
 *
 * Usually that means swapping the argument of the body's \bibliographystyle --
 * the one edit the body ever receives. But LIPIcs declares its style in the
 * PREAMBLE, so a body converted from LIPIcs has none, and swapping alone would
 * leave the target with no style at all: a BibTeX error. Then the line is
 * returned for the emitter to put in its own preamble instead.
 *
 * @param {string} style     the style to switch to
 * @param {string[]} [keep]  styles the target already accepts as they are
 * @returns {{body: string, preambleLine: ?string}}
 */
export function retargetBibStyle(ir, report, style, keep = [style]) {
  const current = ir.bib.style;
  const ok = current && keep.includes(current);
  const cmd = findCommand(ir.body, 'bibliographystyle', 1);

  if (cmd) {
    if (ok || !current) return { body: ir.body, preambleLine: null };
    const raw = ir.body.slice(cmd.start, cmd.end).replace(/\{[^}]*\}$/, `{${style}}`);
    report.map('Bibliography style', `${current} → ${style}`);
    return { body: ir.body.slice(0, cmd.start) + raw + ir.body.slice(cmd.end), preambleLine: null };
  }
  if (!current && !ir.bib.files.length) return { body: ir.body, preambleLine: null };

  if (current && !ok) report.map('Bibliography style', `${current} → ${style}`);
  return { body: ir.body, preambleLine: `\\bibliographystyle{${ok ? current : style}}` };
}

/** "Mark Colley" -> "M. Colley"; a braced surname ("Jane {Open Access}") stays whole. */
export function abbreviateName(name) {
  const words = String(name).match(/\{[^}]*\}|\S+/g) || [];
  if (words.length < 2) return String(name);
  const last = words.pop();
  return [...words.map((w) => w.replace(/[{}]/g, '')[0] + '.'), last].join(' ');
}
