#!/usr/bin/env node
/* Exercises lib/unzip.js against a real .zip built to mirror an Overleaf
 * export: nested under the project name, mixed stored/deflate entries, a
 * binary file, and a subfolder. */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const LIB = path.join(__dirname, '..', 'extension', 'lib');
const FIX = path.join(__dirname, 'fixtures');

const sandbox = {
  TextDecoder, TextEncoder, crypto, console,
  Blob, Response, DecompressionStream,
  DataView, Uint8Array, ArrayBuffer, Error, Math, JSON, Map, Set, Promise, Object, Array, Number, String,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of ['util.js', 'unzip.js', 'latex.js']) {
  vm.runInContext(fs.readFileSync(path.join(LIB, f), 'utf8'), sandbox, { filename: f });
}
const { unzip, util, latex } = sandbox.OTU;

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

(async () => {
  console.log('unzip — real Overleaf-shaped project zip');

  const fixtures = require('./fixtures');
  const buf = fs.readFileSync(fixtures.buildProjectZip());
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

  let entries = await unzip.read(ab);
  check('entry count (directories excluded)', entries.length, 6);

  entries = util.normalizeZipPaths(entries);
  const names = entries.map((e) => e.name).sort();
  check('project-name prefix stripped', names, [
    'acmart.cls', 'figures/plot.png', 'llncs.cls', 'main.tex',
    'sections/intro.tex', 'stored.txt',
  ]);

  const byName = Object.fromEntries(entries.map((e) => [e.name, e]));

  // stored (method 0)
  check('stored entry decodes',
    util.bytesToText(byName['stored.txt'].bytes), 'stored uncompressed\n');

  // deflate (method 8) round-trips a 43 KB class file byte-for-byte
  const llncsOriginal = fs.readFileSync(fixtures.ensure('llncs.cls'), 'utf8');
  check('deflated 43 KB file round-trips exactly',
    util.bytesToText(byName['llncs.cls'].bytes) === llncsOriginal, true);

  // binary stays intact
  const png = byName['figures/plot.png'].bytes;
  check('binary length preserved', png.length, 256 * 40);
  check('binary first bytes intact', [png[0], png[1], png[255], png[256]], [0, 1, 255, 0]);

  // sizes reported from the central directory
  check('reported size matches content',
    byName['llncs.cls'].size, byName['llncs.cls'].bytes.length);

  console.log('\nunzip -> parse pipeline (what the extension actually does)');
  const cls = byName['acmart.cls'];
  const provides = latex.parseProvides(util.bytesToText(cls.bytes));
  check('class parsed straight out of the zip', provides && provides.name, 'acmart');
  check('version parsed straight out of the zip', provides && provides.version, '1.71');

  const dc = latex.parseDocumentClass(util.bytesToText(byName['main.tex'].bytes));
  check('documentclass from zip', dc && dc.name, 'acmart');

  console.log('\nunzip — error handling');
  let threw = null;
  try { await unzip.read(new Uint8Array(100).buffer); } catch (e) { threw = e.message; }
  ok('rejects non-zip input with a clear message',
    threw && /Not a ZIP file/.test(threw), 'got: ' + threw);

  console.log(`\n${'='.repeat(56)}`);
  console.log(`${pass} passed, ${fail} failed`);
  if (fail) { console.log('\nFailed:'); failures.forEach((f) => console.log('  - ' + f)); }
  process.exit(fail ? 1 : 0);
})();
