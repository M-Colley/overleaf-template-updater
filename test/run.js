#!/usr/bin/env node
/* Test harness for the extension's pure logic (parsing, version compare, diff).
 *
 * The lib/ files are classic content scripts sharing one global `OTU` object,
 * so we evaluate them in a single vm context rather than importing them.
 * Fixtures are the real upstream files, not hand-written samples -- the llncs
 * multi-line \ProvidesClass and the IEEEtran "V1.8b" capital-V both came from
 * assumptions that only broke against the genuine articles. */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const LIB = path.join(ROOT, 'extension', 'lib');
const FIX = path.join(__dirname, 'fixtures');

const sandbox = {
  TextDecoder, TextEncoder, crypto,
  console,
  Blob: global.Blob,
  Response: global.Response,
  DecompressionStream: global.DecompressionStream,
  chrome: undefined,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

for (const f of ['util.js', 'latex.js', 'version.js', 'diff.js']) {
  vm.runInContext(fs.readFileSync(path.join(LIB, f), 'utf8'), sandbox, { filename: f });
}
const { latex, version, diff, util } = sandbox.OTU;

/* ------------------------------------------------------------------ runner */
let pass = 0, fail = 0;
const failures = [];

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}\n         got:      ${a}\n         expected: ${e}`); }
}
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? '\n         ' + detail : ''}`); }
}
const fixtures = require('./fixtures');
const read = (f) => fixtures.read(f);
const group = (t) => console.log('\n' + t);

/* ------------------------------------------- \ProvidesClass against reality */
group('parseProvides — real upstream class files');

const ieee = latex.parseProvides(read('IEEEtran.cls'));
check('IEEEtran name', ieee && ieee.name, 'IEEEtran');
check('IEEEtran version (capital V, letter suffix)', ieee && ieee.version, '1.8b');
check('IEEEtran date', ieee && ieee.date, '2015-08-26');

// llncs.cls line 22 is:  \ProvidesClass{llncs}[2025/02/25 v2.26
// with no closing ] on that line. A line-anchored regex silently misses it.
const llncs = latex.parseProvides(read('llncs.cls'));
check('llncs name (option group spans lines)', llncs && llncs.name, 'llncs');
check('llncs version', llncs && llncs.version, '2.26');
check('llncs date', llncs && llncs.date, '2025-02-25');

const acm = latex.parseProvides(read('acmart-old.cls'));
check('acmart name', acm && acm.name, 'acmart');
check('acmart version', acm && acm.version, '1.71');

/* ------------------------------------- macro-indirected headers, for real */
// Every expected value below is the version CTAN (or the publisher) declares
// for that package -- read here out of the genuine file.
group('parseProvides — declarations that point at macros (real files)');

const els = latex.parseProvides(read('elsarticle.cls'));
check('elsarticle: \\ProvidesClass{\\@shortjid} resolves to its name', els && els.name, 'elsarticle');
check('elsarticle: [\\RCSdate, \\RCSversion: ...] resolves to a version', els && els.version, '3.5');
check('elsarticle: and a date', els && els.date, '2026-01-09');

const cas = latex.parseProvides(read('cas-dc.cls'));
check('cas-dc: \\ProvidesClass{\\RCSfile} resolves', cas && cas.name, 'cas-dc');
check('cas-dc: version', cas && cas.version, '2.4');

const mnras = latex.parseProvides(read('mnras.cls'));
check('mnras: [\\@releasedate\\ v\\@version\\ ...]', mnras && [mnras.version, mnras.date],
  ['3.2', '2023-07-20']);

const oup = latex.parseProvides(read('oup-authoring-template.cls'));
check('OUP: \\ProvidesClass{\\classname} resolves', oup && oup.name, 'oup-authoring-template');
check('OUP: [\\lastmodifieddate\\space\\versionnumber]', oup && [oup.version, oup.date],
  ['1.5', '2026-07-14']);

// The declaration names only the date; the number lives in \versionno.
const asme = latex.parseProvides(read('asmeconf.cls'));
check('asmeconf: version found in \\versionno when the header omits it',
  asme && [asme.version, asme.date], ['1.46', '2026-01-10']);

// TeX swallows the space after a control word, so [\filedate\space v\fileversion
// fixes ...] really reads "v2.7fixes" -- and a version regex on that finds "2".
const jacow = latex.parseProvides(read('jacow.cls'));
check('jacow: v\\fileversion followed by a word is not truncated', jacow && jacow.version, '2.7');

const ceur = latex.parseProvides(read('ceurart.cls'));
check('ceurart: expl3 \\ProvidesExplClass{name}{date}{version}{desc}',
  ceur && [ceur.name, ceur.version, ceur.date], ['ceurart', '0.6.2', '2025-10-06']);

const aas = latex.parseProvides(read('aastex631.cls'));
check('aastex631: option group on the line after a %%% comment',
  aas && [aas.version, aas.date], ['6.3.1d', '2020-12-20']);

const cvpr = latex.parseProvides(read('cvpr.sty'));
check('cvpr: an edition year alone is read as the date', cvpr && [cvpr.version, cvpr.date],
  [null, '2026']);
check('an older edition year compares as outdated',
  version.assess({ version: null, date: '2024' }, { version: null, date: '2026' }).status, 'outdated');

group('readVersion — a file with no \\Provides line, only macros');
const common = latex.readVersion(read('cas-common.sty'), 'provides');
check('cas-common.sty: version from \\def\\RCSversion', common.version, '2.4');
check('cas-common.sty: date from \\def\\RCSdate (not the LPPL\'s 1999/12/01)', common.date, '2024-05-04');
check('cas-common.sty: read via macros', common.source, 'macros');

group('macro expansion — edge cases');
check('parameterised definitions are code, not data',
  latex.parseProvides('\\def\\v#1{9.9}\\def\\w{1.2}\\ProvidesClass{x}[2020/01/01 v\\w]').version, '1.2');
check('\\newcommand{\\x}{..} form',
  latex.parseProvides('\\newcommand{\\ver}{3.1}\\ProvidesPackage{x}[2020/01/01 v\\ver]').version, '3.1');
check('the definition in force at the declaration wins',
  latex.parseProvides('\\def\\ver{1.0}\\ProvidesClass{x}[v\\ver]\\def\\ver{9.0}').version, '1.0');
ok('a self-referential definition does not hang',
  latex.parseProvides('\\def\\a{\\a\\a}\\ProvidesClass{x}[2020/01/01 \\a]') !== undefined);
check('an unresolvable name is reported as written, not guessed',
  latex.parseProvides('\\ProvidesClass{\\nowhere}[2020/01/01 v1.0]').name, '\\nowhere');
check('a version macro defined AFTER the declaration is ignored',
  latex.parseProvides('\\ProvidesClass{x}[2020/01/01]\\def\\fileversion{9.9}').version, null);

/* --------------------------------------------- comment-scan false readings */
group('comment-scan — version-shaped text that is not the file\'s version');
check('LPPL "version 1.3c of this license" is not a version',
  latex.parseCommentVersion(
    '%% It may be distributed under the conditions of the LaTeX Project Public\n' +
    '%% License, either version 1.3c of this license or (at your option) any\n' +
    '%% later version.\n%% and version 1.3c or later is part of all distributions of LaTeX\n' +
    '%% version 1999/12/01 or later.\n'),
  null);
// The shipped registry read splncs04.bst as v0.99a, BibTeX's own version.
check('splncs04.bst: "For use with BibTeX version 0.99a" is not its version',
  latex.parseCommentVersion(read('splncs04.bst')), null);
const elsBst = latex.readVersion(read('elsarticle-num.bst'), 'comment-scan');
check('elsarticle-num.bst: (Version 2.1)', elsBst.version, '2.1');
check('elsarticle-num.bst: dated by its $Id keyword', elsBst.date, '2026-01-09');
const aasBst = latex.readVersion(read('aasjournalv7.bst'), 'comment-scan');
check('aasjournalv7.bst: "Revision 1.19" is its version', aasBst.version, '1.19');
check('aasjournalv7.bst: the 2019 date of an older revision is not taken', aasBst.date, null);
check('IEEEtran.bst-style "Version 1.14 (2015/08/26)" still reads both',
  [latex.parseCommentVersion('%% Version 1.14 (2015/08/26)\n').version,
   latex.parseCommentVersion('%% Version 1.14 (2015/08/26)\n').date], ['1.14', '2015-08-26']);

// Why mnras.bst is registered as versionFrom "none": the scan would report its
// 1995 first release. This pins the hazard so the registry choice stays honest.
check('mnras.bst: a comment scan finds the 1995 changelog entry (hence "none")',
  latex.readVersion(read('mnras.bst'), 'comment-scan').version, '1.1b');
check('versionFrom "none" reads nothing, by design',
  latex.readVersion(read('mnras.bst'), 'none'), { version: null, date: null, source: 'none' });

group('parseUsePackages — .sty templates on \\documentclass{article}');
check('options, lists, and commented lines',
  latex.parseUsePackages(
    '\\documentclass[11pt]{article}\n\\usepackage[review]{acl}\n' +
    '% \\usepackage{cvpr}\n\\usepackage{times,latexsym}\n\\RequirePackage{tmlr}\n'),
  ['acl', 'times', 'latexsym', 'tmlr']);

group('parseProvides — commented-out declarations are ignored');
check('leading % skipped',
  latex.parseProvides('% \\ProvidesClass{fake}[2020/01/01 v9.9]\n\\ProvidesClass{real}[2021/02/02 v1.0]').name,
  'real');
check('escaped \\% is not a comment',
  latex.parseProvides('100\\% \\ProvidesClass{real}[2021/02/02 v1.0]').name,
  'real');

/* ------------------------------------------------------------ documentclass */
group('parseDocumentClass');
const dc = latex.parseDocumentClass(read('main.tex'));
check('class name (commented line skipped)', dc && dc.name, 'acmart');
check('options parsed', dc && dc.options, ['sigconf', 'review', 'anonymous']);

/* ---------------------------------------------------------------- bst header */
group('parseBstHeader — ACM-Reference-Format.bst');
const bst = latex.parseBstHeader(read('ACM-Reference-Format.bst'));
check('bst version', bst && bst.version, '2.2');
check('paired acmart release recorded', bst && bst.related && bst.related.acmart, '2.19');

/* ------------------------------------------------------- version comparison */
group('version.compare — the two traps');
check('2.20 > 2.9 (component-wise, not decimal)', version.compare('2.20', '2.9'), 1);
check('2.9 < 2.20', version.compare('2.9', '2.20'), -1);
check('1.8b > 1.8 (letter suffix)', version.compare('1.8b', '1.8'), 1);
check('1.8b < 1.8c', version.compare('1.8b', '1.8c'), -1);
check('equal', version.compare('2.20', 'v2.20'), 0);
check('incomparable -> null', version.compare('2.20', 'unreleased'), null);
check('padding: 2.1 == 2.1.0', version.compare('2.1', '2.1.0'), 0);

group('version.assess');
check('old acmart vs current is outdated',
  version.assess({ version: '1.71', date: '2020-04-30' }, { version: '2.20', date: '2026-08-16' }).status,
  'outdated');
check('same version is current',
  version.assess({ version: '2.26' }, { version: '2.26' }).status, 'current');
check('falls back to date when versions unparseable',
  version.assess({ version: null, date: '2020-01-01' }, { version: null, date: '2026-01-01' }).status,
  'outdated');
check('no data at all -> unknown',
  version.assess({ version: null, date: null }, { version: null, date: null }).status, 'unknown');
check('missing local -> unknown', version.assess(null, { version: '1.0' }).status, 'unknown');

/* ------------------------------------------------------------ readVersion */
group('readVersion dispatch');
check('provides strategy', latex.readVersion(read('llncs.cls'), 'provides').version, '2.26');
check('bst-header strategy', latex.readVersion(read('ACM-Reference-Format.bst'), 'bst-header').version, '2.2');
check('falls through to bst header when no \\ProvidesClass',
  latex.readVersion(read('ACM-Reference-Format.bst'), 'provides').source, 'bst-header');
check('empty file -> none', latex.readVersion('nothing here', 'provides').source, 'none');

/* --------------------------------------------------------------------- diff */
group('diff on a large real file (IEEEtran.cls, ~7000 lines)');
const orig = read('IEEEtran.cls');
const edited = orig
  .replace('\\ProvidesClass{IEEEtran}[2015/08/26 V1.8b', '\\ProvidesClass{IEEEtran}[2026/01/01 V1.9a')
  .replace(/\n/, '\n% a new comment line injected near the top\n');

const t0 = Date.now();
const d = diff.compare(orig, edited);
const ms = Date.now() - t0;
ok(`completes on 282 KB in ${ms} ms (< 2000)`, ms < 2000, `took ${ms} ms`);
ok('detects the added line', d.added >= 1, `added=${d.added}`);
ok('detects the changed line', d.removed >= 1, `removed=${d.removed}`);
ok('produces at least one hunk', d.hunks.length >= 1, `hunks=${d.hunks.length}`);

check('identical files report identical', diff.compare(orig, orig).identical, true);

const dd = diff.compare('a\nb\nc\n', 'a\nB\nc\n');
check('tiny diff added', dd.added, 1);
check('tiny diff removed', dd.removed, 1);

group('diff bails out rather than hanging on wholly different files');
const big1 = Array.from({ length: 6000 }, (_, i) => 'alpha line ' + i).join('\n');
const big2 = Array.from({ length: 6000 }, (_, i) => 'beta line ' + (i * 7)).join('\n');
const t1 = Date.now();
const dbig = diff.compare(big1, big2);
const ms2 = Date.now() - t1;
ok(`degrades to a summary in ${ms2} ms (< 5000)`, ms2 < 5000, `took ${ms2} ms`);
ok('flagged summaryOnly', dbig.summaryOnly === true, JSON.stringify(dbig).slice(0, 120));

/* --------------------------------------------------------------------- util */
group('util path helpers');
check('basename', util.basename('a/b/c.cls'), 'c.cls');
check('extname lowercased', util.extname('a/B.CLS'), '.cls');
check('dirname at root', util.dirname('c.cls'), '');
check('zip prefix stripped when everything is nested',
  util.normalizeZipPaths([{ name: 'Proj/main.tex' }, { name: 'Proj/acmart.cls' }]).map((e) => e.name),
  ['main.tex', 'acmart.cls']);
check('zip prefix kept when files sit at root',
  util.normalizeZipPaths([{ name: 'main.tex' }, { name: 'sub/a.tex' }]).map((e) => e.name),
  ['main.tex', 'sub/a.tex']);
check('escapeHtml', util.escapeHtml('<b>&"</b>'), '&lt;b&gt;&amp;&quot;&lt;/b&gt;');

/* ---------------------------------------------- biblatex files from ACM zip */
group('parseProvides — \\ProvidesFile with hyphenated dates (acm .bbx/.cbx)');
const bbx = latex.parseProvides(
  '\\ProvidesFile{acmauthoryear.bbx}[2022-02-14 v0.1 biblatex bibliography style]\n');
check('ProvidesFile kind', bbx && bbx.kind, 'file');
check('bbx name', bbx && bbx.name, 'acmauthoryear.bbx');
check('bbx version', bbx && bbx.version, '0.1');
check('hyphenated date normalised', bbx && bbx.date, '2022-02-14');

const cbx = latex.parseProvides('\\ProvidesFile{acmnumeric.cbx}[2017-09-27 v0.1]\n');
check('cbx version with no description', cbx && cbx.version, '0.1');

check('file with no version at all -> none',
  latex.readVersion('% Teach biblatex about numpages\n\\DeclareDatamodelFields{numpages}', 'comment-scan').source,
  'none');

/* -------------------------------------------------------- registry integrity */
group('registry integrity');
const registry = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'extension', 'registry', 'templates.json'), 'utf8'));

const VALID_ACTIONS = new Set(['replace', 'report-only']);
const VALID_STRATEGIES = new Set(['provides', 'bst-header', 'comment-scan', 'none']);
// The README's promise: only template machinery is ever written, never a .tex.
const WRITABLE = new Set(['.cls', '.sty', '.bst', '.bbx', '.cbx', '.dbx']);
const ALLOWED_HOSTS = new Set([
  'ctan.org', 'www.ctan.org', 'mirror.ctan.org', 'mirrors.ctan.org',
  'ctan.math.illinois.edu', 'ftp.fau.de',
  'raw.githubusercontent.com', 'api.github.com', 'portalparts.acm.org',
]);

const problems = [];
const seenIds = new Set();
const claimedBy = new Map();
for (const t of registry.templates) {
  if (!t.id || !t.name || !t.detect) problems.push(`${t.id}: missing core fields`);
  if (seenIds.has(t.id)) problems.push(`${t.id}: duplicate template id`);
  seenIds.add(t.id);
  const d = t.detect || {};
  if (![d.documentclass, d.packages, d.files].some((x) => Array.isArray(x) && x.length)) {
    problems.push(`${t.id}: nothing to detect it by`);
  }
  for (const f of t.files) {
    if (!VALID_ACTIONS.has(f.action)) problems.push(`${t.id}/${f.name}: bad action "${f.action}"`);
    if (!VALID_STRATEGIES.has(f.versionFrom)) problems.push(`${t.id}/${f.name}: bad versionFrom "${f.versionFrom}"`);
    if (f.action === 'replace' && !WRITABLE.has(util.extname(f.name))) {
      problems.push(`${t.id}/${f.name}: replace on a file that is not template machinery`);
    }
    // Two templates claiming one file would make "which upstream?" ambiguous.
    const key = f.name.toLowerCase();
    if (claimedBy.has(key)) problems.push(`${f.name}: claimed by both ${claimedBy.get(key)} and ${t.id}`);
    claimedBy.set(key, t.id);

    if (f.action === 'replace') {
      if (!f.source) { problems.push(`${t.id}/${f.name}: action=replace with no source`); continue; }
      const resolved = f.source.ref ? registry.sources[f.source.ref] : f.source;
      if (!resolved) { problems.push(`${t.id}/${f.name}: unresolvable source ref "${f.source.ref}"`); continue; }
      const url = resolved.url;
      if (!url || !url.startsWith('https://')) problems.push(`${t.id}/${f.name}: source url not https`);
      else if (!ALLOWED_HOSTS.has(new URL(url).hostname)) {
        problems.push(`${t.id}/${f.name}: host ${new URL(url).hostname} is not in background.js's allowlist`);
      }
      if (resolved.kind === 'zip' && !(f.source.member || resolved.member)) {
        problems.push(`${t.id}/${f.name}: zip source with no member path`);
      }
    }
    if (f.action === 'report-only' && !f.reason) {
      problems.push(`${t.id}/${f.name}: report-only must explain why in "reason"`);
    }
  }
}
ok('every registry entry is well-formed', problems.length === 0, problems.join('\n         '));
ok('registry is pure ASCII (survives programmatic rewrites)',
  !/[^\x00-\x7F]/.test(fs.readFileSync(
    path.join(ROOT, 'extension', 'registry', 'templates.json'), 'utf8')));

// The allowlist lives in background.js, not the registry, so a registry edit
// cannot widen the extension's network reach. Assert they stay in agreement.
const bgSrc = fs.readFileSync(path.join(ROOT, 'extension', 'background.js'), 'utf8');
const declared = [...bgSrc.matchAll(/^\s*'([a-z0-9.-]+\.[a-z]{2,})',/gm)].map((m) => m[1]);
ok('background.js allowlist matches the test\'s expectation',
  [...ALLOWED_HOSTS].every((h) => declared.includes(h)),
  `background.js declares: ${declared.join(', ')}`);

/* ------------------------------------------------------------------ summary */
console.log(`\n${'='.repeat(56)}`);
console.log(`${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nFailed:');
  failures.forEach((f) => console.log('  - ' + f));
}
process.exit(fail ? 1 : 0);
