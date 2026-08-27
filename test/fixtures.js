/* Test fixtures.
 *
 * The real upstream class files are deliberately NOT committed. They are
 * third-party works under their own licences -- IEEEtran and acmart under the
 * LPPL, llncs under Springer's own terms -- and vendoring them into an
 * MIT-licensed repository would misstate their licensing and, for llncs,
 * redistribute a file whose terms restrict exactly that.
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

/** Third-party sources, fetched not vendored. */
const REMOTE = {
  'IEEEtran.cls':
    'https://ctan.math.illinois.edu/macros/latex/contrib/IEEEtran/IEEEtran.cls',
  'llncs.cls':
    'https://ctan.math.illinois.edu/macros/latex/contrib/llncs/llncs.cls',
  'ACM-Reference-Format.bst':
    'https://raw.githubusercontent.com/borisveytsman/acmart/master/ACM-Reference-Format.bst',
};

const MIN_BYTES = 1024;

function download(name) {
  const url = REMOTE[name];
  const dest = path.join(FIX, name);
  process.stdout.write(`  (fetching fixture ${name} …)\n`);
  execFileSync('curl', [
    '-sL', '--fail', '--max-time', '120',
    '-H', `User-Agent: ${BROWSER_UA}`,
    '-o', dest, url,
  ], { stdio: ['ignore', 'ignore', 'inherit'] });

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
  if (!REMOTE[name]) {
    if (exists) return dest;
    throw new Error(`Missing committed fixture: ${name}`);
  }
  if (exists && fs.statSync(dest).size >= MIN_BYTES) return dest;

  fs.mkdirSync(FIX, { recursive: true });
  download(name);
  return dest;
}

function ensureAll() {
  for (const name of Object.keys(REMOTE)) ensure(name);
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

module.exports = {
  FIX, REMOTE, BROWSER_UA,
  ensure, ensureAll, read, buildProjectZip, buildAcmProjectZip,
};
