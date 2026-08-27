#!/usr/bin/env node
/* Tests for venue-shift: the acmart <-> elsarticle conversion.
 *
 * The properties that matter most are the safety ones -- the input is never
 * modified, and the body is carried across byte-for-byte apart from the single
 * \bibliographystyle substitution. Everything else is a mapping detail. */

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const FIX = join(HERE, 'fixtures');
const TMP = join(HERE, 'fixtures', '.venue-shift-tmp');

import { Report } from '../extension/lib/venues/ir.js';
import * as latex from '../extension/lib/venues/latex.js';
import * as acmart from '../extension/lib/venues/acmart.js';
import * as elsarticle from '../extension/lib/venues/elsarticle.js';
import * as ieeetran from '../extension/lib/venues/ieeetran.js';
import * as llncs from '../extension/lib/venues/llncs.js';

let pass = 0, fail = 0;
const failures = [];
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}\n         got:      ${a}\n         expected: ${e}`); }
}
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? '\n         ' + detail : ''}`); }
}
const group = (t) => console.log('\n' + t);

const convert = (from, to, text) => {
  const report = new Report();
  const ir = from.parse(text, report);
  return { out: to.emit(ir, report), ir, report };
};

/** The body, defined the same way for either template. */
function bodyOf(text) {
  const i = text.indexOf('\\section{Introduction}');
  const j = text.indexOf('\\bibliographystyle');
  return i >= 0 && j > i ? text.slice(i, j) : null;
}

const ACM = readFileSync(join(FIX, 'paper-acmart.tex'), 'utf8');
const ELS = readFileSync(join(FIX, 'paper-elsarticle.tex'), 'utf8');
const IEEE = readFileSync(join(FIX, 'paper-ieeetran.tex'), 'utf8');
const LLNCS = readFileSync(join(FIX, 'paper-llncs.tex'), 'utf8');

/* ------------------------------------------------------------------- latex */
group('latex.mjs — brace-aware reading');
check('nested braces in an argument',
  latex.findCommand('\\title{A {nested} title}', 'title').args[0], 'A {nested} title');
check('optional argument', latex.findCommand('\\title[Short]{Long}', 'title').optional, 'Short');
check('commented commands ignored',
  latex.findCommand('% \\title{No}\n\\title{Yes}', 'title').args[0], 'Yes');
check('three mandatory arguments',
  latex.findCommand('\\acmConference[X]{A}{B}{C}', 'acmConference', 3).args, ['A', 'B', 'C']);
check('environment with same-name nesting',
  latex.extractEnv('\\begin{a}1\\begin{a}2\\end{a}3\\end{a}', 'a').inner,
  '1\\begin{a}2\\end{a}3');
check('splitList with \\sep',
  latex.splitList('a \\sep b \\sep c', 'sep'), ['a', 'b', 'c']);
check('documentclass options',
  latex.documentClass('\\documentclass[sigconf,review]{acmart}').options, ['sigconf', 'review']);

/* ------------------------------------------------------- acmart -> elsevier */
group('acmart -> elsarticle');
const a2e = convert(acmart, elsarticle, ACM);

check('title carried', a2e.ir.title, 'Trust Calibration in Highly Automated Driving');
check('both authors found', a2e.ir.authors.map((x) => x.name), ['Mark Colley', 'Jane Doe']);
check('email carried', a2e.ir.authors[0].email, 'mark.colley@uni-ulm.de');
check('institution -> organization',
  a2e.ir.authors[0].affiliation.organization, 'Institute of Media Informatics, Ulm University');
check('country preserved', a2e.ir.authors[0].affiliation.country, 'Germany');
check('keywords parsed', a2e.ir.keywords,
  ['automated driving', 'trust', 'takeover request', 'user study']);

ok('emits elsarticle class', /\\documentclass\[[^\]]*\]\{elsarticle\}/.test(a2e.out));
ok('\\email became \\ead', a2e.out.includes('\\ead{mark.colley@uni-ulm.de}'));
ok('affiliation uses key=value form',
  a2e.out.includes('organization={Institute of Media Informatics, Ulm University}'));
ok('keywords joined with \\sep',
  a2e.out.includes('automated driving \\sep trust \\sep takeover request \\sep user study'));
ok('frontmatter wrapper emitted',
  a2e.out.includes('\\begin{frontmatter}') && a2e.out.includes('\\end{frontmatter}'));
ok('highlights scaffolded', a2e.out.includes('\\begin{highlights}'));
ok('journal scaffolded as TODO', /\\journal\{TODO-venue-shift/.test(a2e.out));
ok('bibliographystyle swapped', a2e.out.includes('\\bibliographystyle{elsarticle-num}'));
ok('no ACM venue commands leak through',
  !/\\acm(Conference|ISBN|DOI)\b/.test(a2e.out.replace(/^%.*$/gm, '')));

// The bug this guards: booktabs is provided by acmart but NOT by elsarticle,
// so filtering packages on the source class silently breaks every \toprule.
ok('booktabs survives (target does not provide it)',
  a2e.out.includes('\\usepackage{booktabs}'),
  'dropping it would break \\toprule in the carried-over table');
ok('hyperref dropped (target does provide it)',
  !/^\\usepackage(\[[^\]]*\])?\{hyperref\}/m.test(a2e.out));
ok('pgfplots carried through', a2e.out.includes('\\usepackage{pgfplots}'));

ok('CCS concepts preserved as a recoverable comment',
  a2e.out.includes('% [venue-shift] ACM CCS concepts') && a2e.out.includes('% <ccs2012>'));
ok('author note preserved as a comment', a2e.out.includes('% Corresponding author.'));

check('body carried byte-for-byte', bodyOf(a2e.out), bodyOf(ACM));
ok('report names the journal and highlights as blockers',
  a2e.report.todo.length === 2, JSON.stringify(a2e.report.todo.map((t) => t.what)));

/* ------------------------------------------------------- elsevier -> acmart */
group('elsarticle -> acmart');
const e2a = convert(elsarticle, acmart, ELS);

check('title carried', e2a.ir.title, 'Trust Calibration in Highly Automated Driving');
check('authors found', e2a.ir.authors.map((x) => x.name), ['Mark Colley', 'Jane Doe']);
check('\\ead read as email', e2a.ir.authors[0].email, 'mark.colley@uni-ulm.de');
check('organization parsed',
  e2a.ir.authors[0].affiliation.organization, 'Institute of Media Informatics, Ulm University');
check('postcode parsed', e2a.ir.authors[0].affiliation.postcode, '89081');
check('\\sep keywords parsed', e2a.ir.keywords,
  ['automated driving', 'trust', 'takeover request', 'user study']);
check('highlights parsed', e2a.ir.highlights.length, 3);

ok('emits acmart class', /\\documentclass\[[^\]]*\]\{acmart\}/.test(e2a.out));
// The bug this guards: elsarticle's preprint,12pt are not acmart options and
// would make the class error out.
ok('elsarticle class options are not smuggled in',
  !/\\documentclass\[[^\]]*(preprint|12pt)/.test(e2a.out),
  e2a.out.split('\n')[0]);
ok('falls back to sigconf', /\\documentclass\[sigconf/.test(e2a.out));
ok('\\ead became \\email', e2a.out.includes('\\email{mark.colley@uni-ulm.de}'));
ok('organization -> \\institution',
  e2a.out.includes('\\institution{Institute of Media Informatics, Ulm University}'));
ok('keywords joined with commas',
  e2a.out.includes('\\keywords{automated driving, trust, takeover request, user study}'));
ok('CCS scaffolded with a pointer to ACM\'s tool',
  e2a.out.includes('dl.acm.org/ccs'));
ok('venue block scaffolded', /\\acmConference\[TODO-venue-shift/.test(e2a.out));
ok('highlights preserved as a comment',
  e2a.out.includes('% [venue-shift] Elsevier research highlights'));
ok('bibliographystyle swapped', e2a.out.includes('\\bibliographystyle{ACM-Reference-Format}'));
ok('booktabs dropped (acmart provides it)',
  !/^\\usepackage(\[[^\]]*\])?\{booktabs\}/m.test(e2a.out));

check('body carried byte-for-byte', bodyOf(e2a.out), bodyOf(ELS));
ok('CCS, conference, ISBN and DOI are all flagged',
  e2a.report.todo.length === 4, JSON.stringify(e2a.report.todo.map((t) => t.what)));

/* --------------------------------------------------------------- IEEEtran */
group('acmart -> ieeetran');
const a2i = convert(acmart, ieeetran, ACM);

ok('emits IEEEtran class with a format option',
  /\\documentclass\[conference[^\]]*\]\{IEEEtran\}/.test(a2i.out), a2i.out.split('\n')[0]);
ok('authors use IEEE author blocks',
  a2i.out.includes('\\IEEEauthorblockN{Mark Colley}') &&
  a2i.out.includes('\\IEEEauthorblockA{'));
ok('\\and separates authors', a2i.out.includes('\\and'));
ok('keywords use the IEEEkeywords environment',
  a2i.out.includes('\\begin{IEEEkeywords}'));
ok('bibliographystyle swapped', a2i.out.includes('\\bibliographystyle{IEEEtran}'));

// IEEEtran deliberately provides almost nothing, so a package the SOURCE class
// supplied implicitly has to be added or the body breaks.
ok('graphicx added — body uses \\includegraphics, IEEEtran does not provide it',
  /\\usepackage\{[^}]*graphicx/.test(a2i.out),
  'the acmart source never declared it because acmart loads it');
ok('booktabs kept — body uses \\toprule', a2i.out.includes('booktabs'));
ok('the addition is reported, not silent',
  a2i.report.mapped.some((m) => /Added .*graphicx/.test(m.what)));
check('body carried byte-for-byte', bodyOf(a2i.out), bodyOf(ACM));

group('ieeetran -> acmart');
const i2a = convert(ieeetran, acmart, IEEE);

check('title read, \\thanks lifted out', i2a.ir.title,
  'Trust Calibration in Highly Automated Driving {\\footnotesize A driving simulator study}');
check('funding note captured as a title note', i2a.ir.titleNote,
  'This work was funded by the German Research Foundation.');
check('both authors found', i2a.ir.authors.map((x) => x.name), ['Mark Colley', 'Jane Doe']);
check('email recovered from an "Email:" line', i2a.ir.authors[0].email,
  'mark.colley@uni-ulm.de');

// The free-text \IEEEauthorblockA has no marked-up fields, so this is a
// heuristic split -- these assertions pin the heuristic's behaviour.
check('organisation lines joined',
  i2a.ir.authors[0].affiliation.organization,
  'Institute of Media Informatics, Ulm University');
check('city split off', i2a.ir.authors[0].affiliation.city, 'Ulm');
check('country split off', i2a.ir.authors[0].affiliation.country, 'Germany');
check('US address: state and ZIP separated',
  [i2a.ir.authors[1].affiliation.city,
   i2a.ir.authors[1].affiliation.state,
   i2a.ir.authors[1].affiliation.postcode],
  ['Boston', 'Massachusetts', '02115']);
ok('heuristic splitting is flagged for review',
  i2a.report.warnings.some((w) => /free text/.test(w)));

check('IEEEkeywords parsed', i2a.ir.keywords,
  ['automated driving', 'trust', 'takeover request', 'user study']);
ok('emits acmart affiliation fields',
  i2a.out.includes('\\institution{Institute of Media Informatics, Ulm University}'));
ok('missing country flagged rather than invented',
  /\\country\{TODO-venue-shift/.test(i2a.out),
  'the US address had no country line');
ok('CCS scaffolded', i2a.out.includes('dl.acm.org/ccs'));
ok('\\IEEEpeerreviewmaketitle removed from the body',
  !i2a.out.includes('IEEEpeerreviewmaketitle'));
check('body carried byte-for-byte', bodyOf(i2a.out), bodyOf(IEEE));

group('ieeetran -> elsarticle');
const i2e = convert(ieeetran, elsarticle, IEEE);
ok('emits elsarticle', /\\documentclass\[[^\]]*\]\{elsarticle\}/.test(i2e.out));
ok('IEEE class options not smuggled in',
  !/\\documentclass\[[^\]]*conference/.test(i2e.out), i2e.out.split('\n')[0]);
ok('affiliation becomes key=value',
  i2e.out.includes('organization={Institute of Media Informatics, Ulm University}'));
ok('email becomes \\ead', i2e.out.includes('\\ead{mark.colley@uni-ulm.de}'));
check('body carried byte-for-byte', bodyOf(i2e.out), bodyOf(IEEE));

/* ------------------------------------------------------------------ llncs */
group('llncs -> acmart');
const l2a = convert(llncs, acmart, LLNCS);

check('title read, \\thanks lifted out', l2a.ir.title,
  'Trust Calibration in Highly Automated Driving');
check('funding note captured', l2a.ir.titleNote,
  'Supported by the German Research Foundation.');
check('\\titlerunning becomes the short title', l2a.ir.shortTitle,
  'Trust Calibration in Automated Driving');
check('all three authors found from one \\author',
  l2a.ir.authors.map((x) => x.name), ['Mark Colley', 'Jane Doe', 'Alex Roe']);

// llncs links authors to institutions positionally with \inst{n}. Alex Roe is
// \inst{1}, the same institution as Mark Colley.
check('\\inst{1} resolved to the first institution',
  l2a.ir.authors[2].affiliation.organization,
  'Institute of Media Informatics, Ulm University');
check('\\inst{2} resolved to the second',
  l2a.ir.authors[1].affiliation.organization,
  'Department of Computer Science, Example University');
check('institution split into city and country',
  [l2a.ir.authors[0].affiliation.city, l2a.ir.authors[0].affiliation.country],
  ['Ulm', 'Germany']);

// The bug this guards: \email lives in the \institute block, not beside the
// author, so a shared institution would otherwise hand Alex Roe someone else's
// address.
check('the institution email goes to the first author only',
  l2a.ir.authors.map((x) => x.email),
  ['mark.colley@uni-ulm.de', 'jane.doe@example.edu', null]);
ok('and the omission is explained', l2a.report.warnings.some((w) =>
  /shares an institution/.test(w)));

check('ORCID carried', l2a.ir.authors[0].orcid, '0000-0001-5207-5029');
// \keywords lives INSIDE the abstract in llncs.
check('keywords lifted out of the abstract', l2a.ir.keywords,
  ['automated driving', 'trust', 'takeover request', 'user study']);
ok('and removed from the abstract text', !/keywords/.test(l2a.ir.abstract));
ok('abstract itself survived', /within-subjects study/.test(l2a.ir.abstract));

ok('emits acmart', /\\documentclass\[[^\]]*\]\{acmart\}/.test(l2a.out));
ok('short title becomes \\title[...]',
  l2a.out.includes('\\title[Trust Calibration in Automated Driving]'));
check('body carried byte-for-byte', bodyOf(l2a.out), bodyOf(LLNCS));

group('acmart -> llncs');
const a2l = convert(acmart, llncs, ACM);

ok('emits llncs', /\\documentclass\[[^\]]*\]\{llncs\}/.test(a2l.out));
ok('authors carry \\inst indices',
  /Mark Colley\\inst\{1\}/.test(a2l.out) && /Jane Doe\\inst\{2\}/.test(a2l.out),
  a2l.out.match(/\\author\{[\s\S]*?\}/)?.[0]);
ok('ORCID emitted as \\orcidID (llncs has one)',
  a2l.out.includes('\\orcidID{0000-0001-5207-5029}'));
ok('institutions emitted as one \\and-separated block',
  /\\institute\{[\s\S]*\\and[\s\S]*\}/.test(a2l.out));
ok('emails sit inside the institute block',
  /\\institute\{[\s\S]*\\email\{mark\.colley@uni-ulm\.de\}/.test(a2l.out));
ok('keywords go inside the abstract, \\and-separated',
  /\\begin\{abstract\}[\s\S]*\\keywords\{automated driving \\and trust/.test(a2l.out));
ok('bibliographystyle swapped', a2l.out.includes('\\bibliographystyle{splncs04}'));
ok('CCS concepts preserved as a comment',
  a2l.out.includes('% [venue-shift] ACM CCS concepts'));
ok('booktabs kept — llncs does not provide it', a2l.out.includes('booktabs'));
check('body carried byte-for-byte', bodyOf(a2l.out), bodyOf(ACM));

group('llncs -> ieeetran');
const l2i = convert(llncs, ieeetran, LLNCS);
ok('emits IEEEtran', /\\documentclass\[[^\]]*\]\{IEEEtran\}/.test(l2i.out));
ok('llncs class options not smuggled in',
  !/\\documentclass\[[^\]]*runningheads/.test(l2i.out), l2i.out.split('\n')[0]);
ok('authors become IEEE blocks', l2i.out.includes('\\IEEEauthorblockN{Mark Colley}'));
ok('graphicx added — llncs did declare it, so it carries', l2i.out.includes('graphicx'));
check('body carried byte-for-byte', bodyOf(l2i.out), bodyOf(LLNCS));

group('llncs shared-affiliation dedup');
// Three authors, two institutions: the emitted llncs must write two entries.
const backToLlncs = convert(acmart, llncs, l2a.out);
const instBlock = backToLlncs.out.match(/\\institute\{[\s\S]*?\n\n/);
ok('two institutions for three authors',
  (l2a.ir.authors.length === 3) &&
  ((instBlock?.[0].match(/\\and/g) || []).length === 1),
  instBlock && instBlock[0].slice(0, 200));

/* ---------------------------------------------------------------- round trip */
group('round trip acmart -> elsarticle -> acmart');
const rt = convert(elsarticle, acmart, a2e.out);
check('title survives', rt.ir.title, 'Trust Calibration in Highly Automated Driving');
check('authors survive', rt.ir.authors.map((x) => x.name), ['Mark Colley', 'Jane Doe']);
check('keywords survive', rt.ir.keywords,
  ['automated driving', 'trust', 'takeover request', 'user study']);
check('affiliation survives',
  rt.ir.authors[0].affiliation.organization, 'Institute of Media Informatics, Ulm University');
check('body survives both hops', bodyOf(rt.out), bodyOf(ACM));

/* ---------------------------------------------------------------- CLI safety */
group('CLI — never touches the input');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const inFile = join(TMP, 'paper.tex');
writeFileSync(inFile, ACM, 'utf8');
const before = readFileSync(inFile, 'utf8');

execFileSync('node', [join(ROOT, 'cli', 'venue-shift.mjs'), inFile, '--to', 'elsarticle'],
  { stdio: 'ignore' });

check('input file is byte-identical afterwards', readFileSync(inFile, 'utf8'), before);
ok('converted file written beside it', existsSync(join(TMP, 'paper-elsarticle.tex')));
ok('migration checklist written', existsSync(join(TMP, 'paper-elsarticle-MIGRATION.md')));

const md = readFileSync(join(TMP, 'paper-elsarticle-MIGRATION.md'), 'utf8');
ok('checklist lists the blockers', md.includes('You must fill these in'));
ok('checklist explains the drops', md.includes('Dropped, and why'));

let refused = false;
try {
  execFileSync('node', [join(ROOT, 'cli', 'venue-shift.mjs'), inFile,
    '--to', 'elsarticle', '-o', inFile], { stdio: 'pipe' });
} catch { refused = true; }
ok('refuses to overwrite the input file', refused);

let clash = false;
try {
  execFileSync('node', [join(ROOT, 'cli', 'venue-shift.mjs'), inFile, '--to', 'elsarticle'],
    { stdio: 'pipe' });
} catch { clash = true; }
ok('refuses to clobber an existing output without --force', clash);

rmSync(TMP, { recursive: true, force: true });

/* ------------------------------------------------------------------ summary */
console.log(`\n${'='.repeat(56)}`);
console.log(`${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFailed:'); failures.forEach((f) => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
