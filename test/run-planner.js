#!/usr/bin/env node
/* End-to-end integration test for the scan pipeline.
 *
 * Runs the real planner over a synthetic Overleaf project zip, with the browser
 * surfaces stubbed: chrome.runtime.sendMessage is routed to the real
 * background.js handlers, so the zip-source path, the host allowlist, the CTAN
 * lookup and the version comparison are all genuinely exercised.
 *
 * Network is used (CTAN + ACM). Pass --offline to skip.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const FIX = path.join(__dirname, 'fixtures');
const OFFLINE = process.argv.includes('--offline');

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

/* ------------------------------------------------ background worker sandbox */

/* ACM's portal sits behind a WAF that fingerprints the TLS handshake, not just
 * the User-Agent: curl and Chrome are let through, Node/undici is 403'd even
 * with an identical Chrome UA. (Verified: UA-only curl -> 206; Node fetch with
 * the same UA, Accept and Range headers -> 403.) Chrome extensions use Chrome's
 * own stack, so the extension itself is unaffected -- but this harness has to
 * borrow curl to stand in for the browser. The archive is cached under
 * test/fixtures so repeat runs are offline and fast. */
const ACM_HOST = 'portalparts.acm.org';
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function curlToCache(url) {
  const { execFileSync } = require('child_process');
  const cache = path.join(FIX, 'cache-' + url.split('/').pop());
  if (!fs.existsSync(cache) || fs.statSync(cache).size < 1024) {
    console.log(`  (downloading ${url.split('/').pop()} via curl -> ${path.basename(cache)})`);
    execFileSync('curl', ['-sL', '--max-time', '180', '-H', `User-Agent: ${BROWSER_UA}`,
      '-o', cache, url], { stdio: 'inherit' });
  }
  return fs.readFileSync(cache);
}

function browserLikeFetch(url, init) {
  if (new URL(url).hostname === ACM_HOST) {
    const buf = curlToCache(String(url));
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: (h) => (h.toLowerCase() === 'content-length' ? String(buf.length) : null) },
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      text: async () => buf.toString('utf8'),
      json: async () => JSON.parse(buf.toString('utf8')),
    });
  }
  return fetch(url, init);
}

/** In-memory stand-in for chrome.storage.local, which backs the cache. */
function makeStorage() {
  const data = new Map();
  return {
    _data: data,
    async get(keys) {
      if (keys === null || keys === undefined) return Object.fromEntries(data);
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of list) if (data.has(k)) out[k] = data.get(k);
      return out;
    },
    async set(obj) { for (const [k, v] of Object.entries(obj)) data.set(k, v); },
    async remove(keys) {
      for (const k of (Array.isArray(keys) ? keys : [keys])) data.delete(k);
    },
  };
}

// Counts every real network call so "the cache saved a download" is measured,
// not assumed.
const netLog = [];
function countingFetch(url, init) {
  netLog.push({ url: String(url), conditional: !!(init && init.headers &&
    (init.headers['If-None-Match'] || init.headers['If-Modified-Since'])) });
  return browserLikeFetch(url, init);
}

function makeWorker(storage) {
  const sandbox = {
    TextDecoder, TextEncoder, crypto, console, URL,
    fetch: countingFetch,
    Blob, Response, DecompressionStream,
    setTimeout, clearTimeout, Date, Math, JSON, Map, Set, Promise,
    importScripts(...files) {
      for (const f of files) {
        vm.runInContext(fs.readFileSync(path.join(EXT, f), 'utf8'), sandbox, { filename: f });
      }
    },
    chrome: {
      runtime: { onMessage: { addListener(fn) { sandbox.__listener = fn; } } },
      downloads: { download: async () => 1 },
      storage: { local: storage },
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(EXT, 'background.js'), 'utf8'), sandbox,
    { filename: 'background.js' });
  return sandbox;
}

/* ------------------------------------------------- content script sandbox */

function makeContent(worker, projectZipBytes) {
  const sandbox = {
    TextDecoder, TextEncoder, crypto, console, URL,
    Blob, Response, DecompressionStream,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    Date, Math, JSON, Map, Set, Promise, Error,
    location: { host: 'www.overleaf.com', pathname: '/project/0123456789abcdef01234567' },
    document: { querySelector: () => ({ content: 'test-csrf' }) },
    chrome: {
      runtime: {
        getURL: (p) => 'file://' + path.join(EXT, p).replace(/\\/g, '/'),
        lastError: null,
        // Route content-script messages into the real background handlers.
        sendMessage(msg, cb) {
          worker.__listener(msg, {}, (res) => cb(res));
        },
      },
      storage: { sync: { get: async () => ({}), set: async () => {} } },
    },
    // The planner fetches the registry via chrome.runtime.getURL + fetch.
    async fetch(url) {
      if (String(url).startsWith('file://')) {
        const p = String(url).replace('file://', '');
        return { ok: true, json: async () => JSON.parse(fs.readFileSync(p, 'utf8')) };
      }
      throw new Error('content script should not fetch ' + url);
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  for (const f of ['lib/util.js', 'lib/unzip.js', 'lib/latex.js', 'lib/version.js',
                   'lib/diff.js', 'lib/overleaf.js', 'lib/planner.js']) {
    vm.runInContext(fs.readFileSync(path.join(EXT, f), 'utf8'), sandbox, { filename: f });
  }

  // Stand in for the live Overleaf project download.
  sandbox.OTU.overleaf.downloadProjectZip = async () => projectZipBytes;
  return sandbox;
}

/* ---------------------------------------------------------------- fixtures */

function buildProjectZip() {
  const buf = fs.readFileSync(require('./fixtures').buildAcmProjectZip());
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/* -------------------------------------------------------------------- run */

(async () => {
  console.log('planner — end-to-end scan of a synthetic acmart project\n');

  const storage = makeStorage();
  const worker = makeWorker(storage);
  ok('background.js registered a message listener', typeof worker.__listener === 'function');

  const projectZip = buildProjectZip();
  const content = makeContent(worker, projectZip);
  const { planner } = content.OTU;

  console.log('\ninventory + detection');
  const inv = await planner.buildInventory();
  check('files found in project zip', inv.length, 4);
  check('paths normalised', inv.map((f) => f.path).sort(),
    ['acmart.cls', 'main.tex', 'references.bib', 'sections/intro.tex']);

  const registry = await planner.loadRegistry();
  const det = planner.detectTemplates(inv, registry);
  check('detected exactly one template', det.hits.length, 1);
  check('detected acmart', det.hits[0].template.id, 'acmart');
  check('detected via \\documentclass', det.hits[0].byClass, true);
  check('and via the bundled .cls', det.hits[0].byFile, true);

  let plan = null; // the cache section below compares against this first scan
  if (OFFLINE) {
    console.log('\n(--offline: skipping the network-backed scan)');
  } else {
    console.log('\nfull scan (live CTAN + live ACM template zip)');
    const steps = [];
    plan = await planner.scan((m) => steps.push(m));

    ok('progress was reported', steps.length > 0, steps.join(' | '));
    check('plan covers every acmart file in the registry', plan.items.length, 7);

    const cls = plan.items.find((i) => i.name === 'acmart.cls');
    ok('acmart.cls found in project', cls.present === true);
    check('local version read from the project copy', cls.local.version, '1.71');
    ok('upstream acmart.cls was downloaded from the ACM zip',
      typeof cls.newText === 'string' && cls.newText.length > 100000,
      `newText length = ${cls.newText && cls.newText.length}`);
    ok('upstream is a real class file',
      /ProvidesClass\{acmart\}/.test(cls.newText || ''));
    check('upstream version parsed', cls.upstream.version, '2.20');
    check('status is outdated', cls.status, 'outdated');
    ok('marked applicable', cls.applicable === true);
    ok('pre-selected for the user', cls.selected === true);
    ok('download size surfaced to the UI', !!cls.sizeNote, String(cls.sizeNote));

    const absent = plan.items.filter((i) => !i.present);
    ok('files not in the project are reported absent, not fetched',
      absent.length === 6 && absent.every((i) => i.newText === null),
      `absent=${absent.length}, fetched=${absent.filter((i) => i.newText).length}`);

    const bib = plan.items.find((i) => i.name === 'ACM-Reference-Format.bst');
    check('missing .bst reported as absent', bib.status, 'absent');

    console.log('\ndiff preview of the real upgrade');
    const d = content.OTU.diff.compare(cls.localText, cls.newText);
    ok('diff computed for the v1.71 -> v2.20 upgrade',
      d.ok && (d.added > 0 || d.summaryOnly), JSON.stringify({ added: d.added, removed: d.removed, summaryOnly: !!d.summaryOnly }));

    console.log('\nsafety properties');
    ok('no .tex file is ever in the plan',
      plan.items.every((i) => !i.name.endsWith('.tex')));
    ok('nothing is selected that is not applicable',
      plan.items.every((i) => !i.selected || i.applicable));
    ok('unclaimed template assets are reported, not touched',
      Array.isArray(plan.unclaimed));
  }

  if (!OFFLINE) {
    console.log('\ncache: one archive download serves every tracked file');
    const acmHits = () => netLog.filter((n) => n.url.includes(ACM_HOST)).length;
    const afterFirst = acmHits();
    ok('the first scan downloaded the archive exactly once', afterFirst === 1,
      `archive fetches = ${afterFirst}`);

    const cached = await new Promise((res) =>
      worker.__listener({ type: 'cacheStats' }, {}, res));
    ok('all seven acmart members cached from that one download',
      cached.count >= 7, `cached ${cached.count}: ${cached.entries.map((e) => e.name).join(', ')}`);
    ok('cache stays small (extracted files, not the 15 MB archive)',
      cached.totalBytes < 1024 * 1024,
      `${(cached.totalBytes / 1024).toFixed(0)} KB`);
    const clsEntry = cached.entries.find((e) => e.name === 'acmart.cls');
    check('cached acmart.cls carries its version tag', clsEntry && clsEntry.version, '2.20');

    console.log('\ncache: a second project costs no download');
    // A brand-new content sandbox is exactly what opening another project does.
    const second = makeContent(worker, buildProjectZip());
    const plan2 = await second.OTU.planner.scan(() => {});

    check('no further archive fetches', acmHits(), afterFirst);
    const cls2 = plan2.items.find((i) => i.name === 'acmart.cls');
    check('still resolved the upstream file', cls2.upstream.version, '2.20');
    check('and it came from the cache', cls2.fromCache, 'version');
    ok('served identical bytes',
      cls2.newText === plan.items.find((i) => i.name === 'acmart.cls').newText);
    check('verdict unchanged', cls2.status, 'outdated');

    console.log('\ncache: clearing forces a refetch');
    const cleared = await new Promise((res) =>
      worker.__listener({ type: 'cacheClear' }, {}, res));
    ok('cleared entries', cleared.removed > 0, `removed ${cleared.removed}`);
    const empty = await new Promise((res) =>
      worker.__listener({ type: 'cacheStats' }, {}, res));
    check('cache is empty afterwards', empty.count, 0);
  }

  console.log('\nallowlist enforcement (registry data cannot widen network reach)');
  const denied = await new Promise((res) =>
    worker.__listener({ type: 'fetchText', url: 'https://evil.example.com/acmart.cls' }, {}, res));
  check('off-allowlist host refused', denied.ok, false);
  ok('refusal names the host', /evil\.example\.com/.test(denied.error), denied.error);

  const http = await new Promise((res) =>
    worker.__listener({ type: 'fetchText', url: 'http://ctan.org/x.cls' }, {}, res));
  check('plain HTTP refused even on an allowed host', http.ok, false);

  const bogus = await new Promise((res) =>
    worker.__listener({ type: 'backupProject', projectId: '../../etc', filename: 'x.zip' }, {}, res));
  check('malformed project id refused', bogus.ok, false);

  // Overleaf also lives on regional hosts (de.overleaf.com) and self-hosted
  // Server Pro domains, so the backup must follow the calling tab's origin.
  console.log('\nbackup follows the calling tab\'s origin, not a hardcoded host');
  const downloads = [];
  worker.chrome.downloads.download = async (opts) => { downloads.push(opts); return 1; };

  const good = await new Promise((res) =>
    worker.__listener(
      { type: 'backupProject', projectId: '61a8757b541901373460174a', filename: 'b.zip' },
      { origin: 'https://de.overleaf.com', url: 'https://de.overleaf.com/project/61a8757b541901373460174a' },
      res));
  check('accepted for a regional host', good.ok, true);
  check('downloaded from that same origin', downloads[0] && downloads[0].url,
    'https://de.overleaf.com/project/61a8757b541901373460174a/download/zip');

  const noOrigin = await new Promise((res) =>
    worker.__listener(
      { type: 'backupProject', projectId: '61a8757b541901373460174a', filename: 'b.zip' },
      {}, res));
  check('refused when the caller has no origin', noOrigin.ok, false);

  const insecure = await new Promise((res) =>
    worker.__listener(
      { type: 'backupProject', projectId: '61a8757b541901373460174a', filename: 'b.zip' },
      { origin: 'http://evil.example.com' }, res));
  check('refused for a non-https caller', insecure.ok, false);

  // The options page's "Network scope" section is a trust claim, so it must be
  // rendered from the enforced allowlist rather than restating it. A hardcoded
  // copy silently went stale the moment CTAN mirror fallbacks were added.
  console.log('\nthe options page cannot misstate the allowlist');
  const exposed = await new Promise((res) =>
    worker.__listener({ type: 'allowedHosts' }, {}, res));
  ok('allowedHosts returns the enforced list',
    Array.isArray(exposed.hosts) && exposed.hosts.length >= 5,
    JSON.stringify(exposed.hosts));

  // Every host the registry actually points at must be on the allowlist.
  // Adding CTAN mirror fallbacks without allowlisting them would fail here.
  const registryHosts = new Set();
  for (const t of registry.templates) {
    for (const f of t.files) {
      const shared = f.source && f.source.ref ? registry.sources[f.source.ref] : null;
      const url = (f.source && f.source.url) || (shared && shared.url);
      if (url) registryHosts.add(new URL(url).hostname);
      for (const m of (f.source && f.source.mirrors) || []) {
        registryHosts.add(new URL(m).hostname);
      }
    }
  }
  const unlisted = [...registryHosts].filter((h) => !exposed.hosts.includes(h));
  ok('every host the registry points at is on the allowlist',
    unlisted.length === 0, 'not allowlisted: ' + unlisted.join(', '));

  const optionsHtml = fs.readFileSync(path.join(EXT, 'options', 'options.html'), 'utf8');
  ok('options.html hardcodes no hostnames of its own',
    !/ctan\.org|githubusercontent|portalparts/.test(optionsHtml),
    'a hardcoded list would drift from background.js');

  console.log('\nmanifest covers the hosts Overleaf actually uses');
  const manifest = JSON.parse(
    fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
  const patterns = manifest.content_scripts[0].matches;
  const matches = (host) => patterns.some((p) => {
    const h = p.replace(/^https:\/\//, '').replace(/\/\*$/, '');
    return h.startsWith('*.')
      ? host.endsWith(h.slice(1)) && host !== h.slice(2)
      : host === h;
  });
  ok('www.overleaf.com matches', matches('www.overleaf.com'));
  ok('de.overleaf.com matches (the regional host that broke it)', matches('de.overleaf.com'),
    patterns.join(', '));
  ok('bare overleaf.com matches', matches('overleaf.com'));
  ok('an unrelated host does not match', !matches('overleaf.com.evil.net'));
  ok('host_permissions cover the same origins',
    ['https://www.overleaf.com/*', 'https://overleaf.com/*', 'https://*.overleaf.com/*']
      .every((p) => manifest.host_permissions.includes(p)));
  ok('scripting permission present for self-hosted registration',
    manifest.permissions.includes('scripting'));
  ok('popup is wired to the toolbar action',
    manifest.action && manifest.action.default_popup === 'popup/popup.html');

  console.log(`\n${'='.repeat(56)}`);
  console.log(`${pass} passed, ${fail} failed`);
  if (fail) { console.log('\nFailed:'); failures.forEach((f) => console.log('  - ' + f)); }
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\nharness error:', err);
  process.exit(1);
});
