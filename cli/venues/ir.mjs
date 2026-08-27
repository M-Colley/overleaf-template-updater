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

export function makeIR(venue) {
  return {
    venue,
    classOptions: [],

    title: null,
    shortTitle: null,

    /** @type {Array<{name, email, orcid, note, affiliation}>} */
    authors: [],

    abstract: null,
    keywords: [],

    // ACM-specific
    ccs: { xml: null, descs: [] },
    teaser: null,

    // Elsevier-specific
    highlights: [],
    graphicalAbstract: null,

    /** Venue/publication metadata; only some fields are meaningful per venue. */
    meta: {
      journal: null,
      conference: null,      // full \acmConference argument set, raw
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
