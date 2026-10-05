/* Test fixtures.
 *
 * The real upstream class files are deliberately NOT committed. They are
 * third-party works under their own licences -- most under the LPPL, llncs
 * under CC BY 4.0 -- and vendoring them into an MIT-licensed repository would
 * misstate their licensing, and take on each licence's redistribution terms.
 *
 * So they are downloaded on demand into this directory, which is gitignored.
 * Tests still run against the genuine articles rather than hand-written
 * samples, which is what caught the llncs multi-line \ProvidesClass and
 * IEEEtran's capital-V version in the first place.
 *
 * Only the two tiny stubs written for this project (acmart-old.cls, main.tex)
 * are committed.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const FIX = __dirname + '/fixtures';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const CTAN = 'https://ctan.math.illinois.edu/macros/latex/contrib/';
const GH = 'https://raw.githubusercontent.com/';

/** Third-party sources, fetched not vendored. */
const REMOTE = {
  'IEEEtran.cls': CTAN + 'IEEEtran/IEEEtran.cls',
  'llncs.cls': CTAN + 'llncs/llncs.cls',
  'ACM-Reference-Format.bst':
    GH + 'borisveytsman/acmart/master/ACM-Reference-Format.bst',

  // Each of these exercises a header shape or a trap that a real file showed.
  'cas-dc.cls': CTAN + 'els-cas-templates/cas-dc.cls',          // \ProvidesClass{\RCSfile}
  'cas-common.sty': CTAN + 'els-cas-templates/cas-common.sty',  // no \Provides; LPPL text
  'mnras.cls': CTAN + 'mnras/mnras.cls',                        // [\@releasedate\ v\@version\ ...]
  'asmeconf.cls': CTAN + 'asmeconf/asmeconf.cls',               // version only in \versionno
  'jacow.cls': CTAN + 'jacow/jacow.cls',                        // v\fileversion fixes -> "v2.7fixes"
  'oup-authoring-template.cls':
    CTAN + 'oup-authoring-template/oup-authoring-template.cls', // \ProvidesClass{\classname}
  'ceurart.cls': GH + 'yamadharma/ceurart/master/tex/latex/ceurart/ceurart.cls', // expl3
  'cvpr.sty': GH + 'cvpr-org/author-kit/main/cvpr.sty',         // [2026 LaTeX class ...]
  'aastex631.cls': GH + 'AASJournals/AASTeX60/main/cls/aastex631.cls', // options after %%%
  'elsarticle-num.bst': CTAN + 'elsarticle/elsarticle-num.bst', // (Version 2.1), $Id date
  'splncs04.bst': CTAN + 'llncs/splncs04.bst',                  // "BibTeX version 0.99a"
  'aasjournalv7.bst': CTAN + 'aastex/aasjournalv7.bst',         // Revision 1.19; 2019 date below
  'mnras.bst': CTAN + 'mnras/mnras.bst',                        // changelog opens with 1.1b
};

/* Classes CTAN publishes only as .dtx. The built file Overleaf actually runs is
 * in TeX Live's package archive, so that is where the fixture comes from. */
const TEXLIVE = 'https://ctan.math.illinois.edu/systems/texlive/tlnet/archive/';
const REMOTE_TEXLIVE = {
  'elsarticle.cls': 'elsarticle', // \ProvidesClass{\@shortjid}[\RCSdate, \RCSversion: ...]
};

const MIN_BYTES = 1024;

/** Extract one built file from a TeX Live .tar.xz (Node has no xz; Python does). */
function extractFromTeXLive(name, dest) {
  const py = [
    'import io, os, sys, tarfile, urllib.request',
    `req = urllib.request.Request(${JSON.stringify(TEXLIVE + REMOTE_TEXLIVE[name] + '.tar.xz')},`,
    `  headers={"User-Agent": ${JSON.stringify(BROWSER_UA)}})`,
    'data = urllib.request.urlopen(req, timeout=120).read()',
    'with tarfile.open(fileobj=io.BytesIO(data), mode="r:xz") as t:',
    '    for m in t.getmembers():',
    `        if os.path.basename(m.name) == ${JSON.stringify(name)}:`,
    `            open(${JSON.stringify(dest)}, "wb").write(t.extractfile(m).read())`,
    '            break',
  ].join('\n');
  execFileSync('python', ['-c', py], { stdio: ['ignore', 'ignore', 'inherit'] });
}

function download(name) {
  const dest = path.join(FIX, name);
  process.stdout.write(`  (fetching fixture ${name} …)\n`);
  if (REMOTE_TEXLIVE[name]) {
    extractFromTeXLive(name, dest);
  } else {
    execFileSync('curl', [
      '-sL', '--fail', '--max-time', '120',
      '-H', `User-Agent: ${BROWSER_UA}`,
      '-o', dest, REMOTE[name],
    ], { stdio: ['ignore', 'ignore', 'inherit'] });
  }
  const url = REMOTE[name] || TEXLIVE + REMOTE_TEXLIVE[name] + '.tar.xz';

  if (!fs.existsSync(dest) || fs.statSync(dest).size < MIN_BYTES) {
    throw new Error(
      `Could not fetch fixture "${name}" from ${url}.\n` +
      `These files are downloaded rather than committed for licensing reasons, ` +
      `so the test suite needs network access on first run.`
    );
  }
}

/** Make sure a fixture is present, downloading it if it is a remote one. */
function ensure(name) {
  const dest = path.join(FIX, name);
  const exists = fs.existsSync(dest);

  // Committed stubs are legitimately tiny (acmart-old.cls is 115 bytes); the
  // size floor is only there to reject a truncated or errored download.
  if (!REMOTE[name] && !REMOTE_TEXLIVE[name]) {
    if (exists) return dest;
    throw new Error(`Missing committed fixture: ${name}`);
  }
  if (exists && fs.statSync(dest).size >= MIN_BYTES) return dest;

  fs.mkdirSync(FIX, { recursive: true });
  download(name);
  return dest;
}

function ensureAll() {
  for (const name of [...Object.keys(REMOTE), ...Object.keys(REMOTE_TEXLIVE)]) ensure(name);
}

function read(name) {
  return fs.readFileSync(ensure(name), 'utf8');
}

/**
 * Build the Overleaf-shaped project zip used by the unzip tests: nested under a
 * project name, mixed stored/deflate entries, a binary file and a subfolder.
 * Generated rather than committed so the test asserts against a zip produced by
 * an independent implementation (Python's zipfile), not one we wrote ourselves.
 */
function buildProjectZip() {
  const out = path.join(FIX, 'project.zip');
  ensure('llncs.cls');
  const py = [
    'import zipfile',
    `z=zipfile.ZipFile(r"${out}","w")`,
    'z.writestr("MyPaper/main.tex", open(r"' + path.join(FIX, 'main.tex') + '").read(), zipfile.ZIP_DEFLATED)',
    'z.writestr("MyPaper/acmart.cls", open(r"' + path.join(FIX, 'acmart-old.cls') + '").read(), zipfile.ZIP_DEFLATED)',
    'z.writestr("MyPaper/llncs.cls", open(r"' + path.join(FIX, 'llncs.cls') + '").read(), zipfile.ZIP_DEFLATED)',
    'z.writestr("MyPaper/stored.txt", "stored uncompressed\\n", zipfile.ZIP_STORED)',
    'z.writestr("MyPaper/figures/plot.png", bytes(range(256))*40, zipfile.ZIP_STORED)',
    'z.writestr("MyPaper/sections/intro.tex", "intro\\n", zipfile.ZIP_DEFLATED)',
    'z.close()',
  ].join('\n');
  execFileSync('python', ['-c', py]);
  return out;
}

/** The synthetic acmart project used by the planner integration test. */
function buildAcmProjectZip() {
  const out = path.join(FIX, 'project-acm.zip');
  const py = [
    'import zipfile',
    `z=zipfile.ZipFile(r"${out}","w",zipfile.ZIP_DEFLATED)`,
    'z.writestr("MyPaper/main.tex", open(r"' + path.join(FIX, 'main.tex') + '").read())',
    'z.writestr("MyPaper/acmart.cls", open(r"' + path.join(FIX, 'acmart-old.cls') + '").read())',
    'z.writestr("MyPaper/references.bib", "@article{x, title={T}}\\n")',
    'z.writestr("MyPaper/sections/intro.tex", "intro\\n")',
    'z.close()',
  ].join('\n');
  execFileSync('python', ['-c', py]);
  return out;
}

/**
 * An Overleaf-shaped project zip from in-memory files, written by Python's
 * zipfile so the reader is tested against an independent implementation.
 * @param {string} name        zip file name under fixtures/
 * @param {Object<string,string>} entries  path -> text content
 */
function buildZip(name, entries) {
  const out = path.join(FIX, name);
  const spec = path.join(FIX, name + '.json');
  fs.writeFileSync(spec, JSON.stringify(entries), 'utf8');
  const py = [
    'import json, zipfile',
    `entries = json.load(open(r"${spec}", encoding="utf-8"))`,
    `z = zipfile.ZipFile(r"${out}", "w", zipfile.ZIP_DEFLATED)`,
    'for p, text in entries.items():',
    '    z.writestr("MyPaper/" + p, text.encode("utf-8"))',
    'z.close()',
  ].join('\n');
  execFileSync('python', ['-c', py]);
  fs.unlinkSync(spec);
  return out;
}

module.exports = {
  FIX, REMOTE, REMOTE_TEXLIVE, BROWSER_UA,
  ensure, ensureAll, read, buildProjectZip, buildAcmProjectZip, buildZip,
};
