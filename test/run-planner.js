#!/usr/bin/env node
/* End-to-end integration test for the scan pipeline.
 *
 * Runs the real planner over a synthetic Overleaf project zip, with the browser
 * surfaces stubbed: chrome.runtime.sendMessage is routed to the real
 * background.js handlers, so the zip-source path, the host allowlist, the CTAN
 * lookup and the version comparison are all genuinely exercised.
 *
 * Network is used (CTAN + ACM). Pass --offline to skip.
 *
 * Pass --snapshot to also record what every registry source returned -- size,
 * the version read out of the file, CTAN's declared version -- into
 * test/preview/options-snapshot.json, which the options-page screenshot
 * renders instead of invented numbers.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const FIX = path.join(__dirname, 'fixtures');
const OFFLINE = process.argv.includes('--offline');
const SNAPSHOT = process.argv.includes('--snapshot');

let pass = 0, fail = 0;
const failures = [];
const skips = [];
function skipped(name, why) {
  skips.push(name);
  console.log(`  SKIP ${name}\n         ${why}`);
}
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

/* ACM's portal sits behind Cloudflare, which fingerprints the client, not just
 * the User-Agent. In August 2026 curl was let through while Node/undici was
 * 403'd even with an identical Chrome UA. By October 2026 curl was challenged
 * too -- 403 with `cf-mitigated: challenge`, a JavaScript challenge only a
 * browser can pass -- while Chrome's own fetch, from the same machine and
 * without cookies, still got 206 and the real archive. The extension uses
 * Chrome's stack and is unaffected; this harness can only borrow curl.
 *
 * So a challenge is reported, not hidden: the checks that need the archive
 * are SKIPPED with the reason, never counted as passes, and anything else ACM
 * answers -- a 404 for a moved archive, say -- still fails. The archive is
 * cached under test/fixtures once a download succeeds. */
const ACM_HOST = 'portalparts.acm.org';
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** True for a file that is plainly a ZIP archive rather than an error page. */
function isZip(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(4);
    fs.readSync(fd, head, 0, 4, 0);
    fs.closeSync(fd);
    return head.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  } catch {
    return false;
  }
}

/* The only thing fetched from ACM is its template archive, so only a 2xx
 * response that is a real ZIP is cached: an error page cached once would
 * otherwise be served as the archive on every later run. The real status goes
 * back to the worker, so its own error handling is what gets exercised. */
function curlToCache(url) {
  const { execFileSync } = require('child_process');
  const cache = path.join(FIX, 'cache-' + url.split('/').pop());
  if (isZip(cache)) return { status: 200, buf: fs.readFileSync(cache) };
  fs.rmSync(cache, { force: true });

  console.log(`  (downloading ${url.split('/').pop()} via curl -> ${path.basename(cache)})`);
  const part = cache + '.part';
  const out = execFileSync('curl', ['-sL', '--max-time', '180', '-H', `User-Agent: ${BROWSER_UA}`,
    '-D', '-', '-o', part, '-w', '%{http_code}', url], { encoding: 'utf8' });
  const status = Number(out.slice(-3));
  if (status >= 200 && status < 300 && isZip(part)) {
    fs.renameSync(part, cache);
    return { status, buf: fs.readFileSync(cache) };
  }
  fs.rmSync(part, { force: true });
  return { status, challenged: /^cf-mitigated:\s*challenge\s*$/im.test(out), buf: Buffer.alloc(0) };
}

function browserLikeFetch(url, init) {
  if (new URL(url).hostname === ACM_HOST) {
    const { status, buf } = curlToCache(String(url));
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
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

  // Decided once, up front, so every check that needs ACM's archive is either
  // run or reported as skipped -- never quietly passed.
  let acmRefused = null;
  if (!OFFLINE) {
    const acmUrl = Object.values(registry.sources || {})
      .map((s) => s.url).find((u) => u && new URL(u).hostname === ACM_HOST);
    const probe = curlToCache(acmUrl);
    if (probe.challenged) {
      acmRefused = `ACM's Cloudflare answered curl with a bot challenge (HTTP ${probe.status}); ` +
        'Chrome, which the extension uses, is let through';
    }
  }

  let plan = null; // the cache section below compares against this first scan
  if (OFFLINE) {
    console.log('\n(--offline: skipping the network-backed scan)');
  } else if (acmRefused) {
    console.log('\nfull scan (live CTAN + live ACM template zip)');
    skipped('end-to-end scan of an acmart project', acmRefused);
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
    check('upstream version parsed', cls.upstream && cls.upstream.version, '2.20');
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

  if (!OFFLINE && acmRefused) {
    console.log('\ncache: one archive download serves every tracked file');
    skipped('the archive cache (download once, reuse, clear)', acmRefused);
  } else if (!OFFLINE) {
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
    check('still resolved the upstream file', cls2.upstream && cls2.upstream.version, '2.20');
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

  /* -------------------------------------------- every source, for real */
  // The registry is only as good as its sources. Each one is fetched through
  // the worker's real code path -- mirror fallback, HTML rejection, expectName,
  // the .bst completeness check -- and, where a file's version is meant to
  // track its CTAN package, the version the extension reads out of the file is
  // checked against CTAN's own package index.
  if (!OFFLINE) {
    console.log('\nevery registry source, through the real worker');
    const call = (msg) => new Promise((res) => worker.__listener(msg, {}, res));
    const sourceFailures = [];
    const versionDrift = [];
    const fromAcm = [];
    const snapshot = { capturedAt: new Date().toISOString(), ctan: {}, files: {} };
    let fetched = 0;

    for (const t of registry.templates) {
      const declared = t.upstream && t.upstream.version && t.upstream.version.kind === 'ctan'
        ? await call({ type: 'ctanPackage', pkg: t.upstream.version.pkg }) : null;
      if (declared && declared.ok) {
        snapshot.ctan[t.upstream.version.pkg] = { version: declared.version || null };
      }

      for (const f of t.files) {
        if (f.action !== 'replace') continue;
        const shared = f.source.ref ? registry.sources[f.source.ref] : null;
        const url = shared ? shared.url : f.source.url;
        if (acmRefused && new URL(url).hostname === ACM_HOST) { fromAcm.push(f.name); continue; }
        const res = shared
          ? await call({ type: 'fetchZipMember', url: shared.url, member: f.source.member,
              versionFrom: f.versionFrom, expectName: f.expectName })
          : await call({ type: 'fetchText', url: f.source.url, mirrors: f.source.mirrors,
              versionFrom: f.versionFrom, expectName: f.expectName });
        if (!res.ok) { sourceFailures.push(`${f.name}: ${res.error}`); continue; }
        fetched++;
        snapshot.files[f.name] = { bytes: res.text.length, version: res.version || null };

        const want = declared && declared.ok && declared.version && declared.version.number;
        if (f.versionTracksPackage && want &&
            content.OTU.version.compare(res.version, want) !== 0) {
          versionDrift.push(`${f.name}: file says v${res.version}, CTAN says v${want}`);
        }
      }
    }
    ok(`all ${fetched} replaceable files fetched and verified`, sourceFailures.length === 0,
      sourceFailures.join('\n         '));
    ok('every class that tracks its CTAN package reads as CTAN\'s version',
      versionDrift.length === 0, versionDrift.join('\n         '));
    if (fromAcm.length) skipped(`${fromAcm.length} files from ACM's archive (${fromAcm.join(', ')})`, acmRefused);

    // Only a complete, verified run is worth rendering.
    if (SNAPSHOT && sourceFailures.length === 0 && fromAcm.length === 0) {
      const out = path.join(__dirname, 'preview', 'options-snapshot.json');
      fs.writeFileSync(out, JSON.stringify(snapshot, null, 2) + '\n');
      console.log(`  wrote ${path.relative(ROOT, out)}`);
    } else if (SNAPSHOT) {
      console.log('  snapshot NOT written: not every source was fetched and verified');
    }
  }

  /* ---------------------------------------- the newer detection paths */
  const fx = require('./fixtures');
  const zipOf = (name, entries) => {
    const buf = fs.readFileSync(fx.buildZip(name, entries));
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  };
  const scanOf = async (zip) => makeContent(worker, zip).OTU.planner.scan(() => {});
  const itemOf = (plan, name) => plan.items.find((i) => i.name === name);

  console.log('\nACL: a .sty template on \\documentclass{article}');
  const aclZip = zipOf('project-acl.zip', {
    'main.tex': '\\documentclass[11pt]{article}\n\\usepackage[review]{acl}\n' +
      '\\begin{document}\nx\n\\end{document}\n',
    'acl.sty': '% This is the LaTex style file for *ACL.\n% (a stale copy)\n',
  });
  const aclInv = await makeContent(worker, aclZip).OTU.planner.buildInventory();
  const aclDet = content.OTU.planner.detectTemplates(aclInv, registry);
  check('detected acl and nothing else', aclDet.hits.map((h) => h.template.id), ['acl']);
  ok('detected by its \\usepackage, not only the bundled file', aclDet.hits[0].byPackage === true);

  if (!OFFLINE) {
    const acl = await scanOf(aclZip);
    const sty = itemOf(acl, 'acl.sty');
    check('unversioned acl.sty is "unknown", never claimed current or outdated', sty.status, 'unknown');
    ok('and says why: there is no version to compare',
      /no version marker/.test(sty.statusReason), sty.statusReason);
    ok('offered, with its diff, but not pre-selected',
      sty.applicable === true && sty.selected === false && !!sty.newText);
  }

  console.log('\nElsevier CAS: a macro-declared class, end to end');
  const casZip = zipOf('project-cas.zip', {
    'main.tex': '\\documentclass[a4paper,fleqn]{cas-dc}\n\\begin{document}\nx\n\\end{document}\n',
    // The genuine header shape, at an older version.
    'cas-dc.cls': '\\def\\RCSfile{cas-dc}%\n\\def\\RCSversion{2.3}%\n\\def\\RCSdate{2021/05/25}%\n' +
      '\\ProvidesClass{\\RCSfile}[\\RCSdate, \\RCSversion: Formatting class\n' +
      '   for CAS double column articles]\n',
  });
  if (!OFFLINE) {
    const casPlan = await scanOf(casZip);
    const dc = itemOf(casPlan, 'cas-dc.cls');
    check('local version read through \\RCSversion', dc.local.version, '2.3');
    // Without macro expansion the upstream file's name is "\RCSfile", and
    // expectName would refuse the genuine cas-dc.cls as the wrong file.
    ok('upstream cas-dc.cls passed expectName', !!dc.newText,
      casPlan.warnings.join(' | '));
    check('and is outdated against it', [dc.upstream.version, dc.status], ['2.4', 'outdated']);
    ok('pre-selected', dc.selected === true);
  }

  console.log('\nelsarticle: the report-only class now has a readable version');
  const elsZip = zipOf('project-els.zip', {
    'main.tex': '\\documentclass[preprint,12pt]{elsarticle}\n\\begin{document}\n' +
      '\\bibliographystyle{elsarticle-num}\n\\end{document}\n',
    'elsarticle.cls': ' \\def\\RCSfile{elsarticle}%\n \\def\\RCSversion{3.1}%\n' +
      ' \\def\\RCSdate{2018/01/19}%\n \\def\\@shortjid{elsarticle}\n' +
      '\\ProvidesClass{\\@shortjid}[\\RCSdate, \\RCSversion: \\@journal]\n',
    'elsarticle-num.bst': '%%\n%% This is file `elsarticle-num.bst\' (Version 1.9),\n%%\n',
  });
  if (!OFFLINE) {
    const elsPlan = await scanOf(elsZip);
    const cls = itemOf(elsPlan, 'elsarticle.cls');
    // Before macro expansion this was always "unknown": [\RCSdate, \RCSversion: ...]
    check('bundled elsarticle.cls reads as v3.1 and is outdated',
      [cls.local.version, cls.status], ['3.1', 'outdated']);
    ok('offered as an unbundle, never a replace',
      cls.action === 'report-only' && cls.recommendation === 'unbundle' && cls.applicable);
    const nb = itemOf(elsPlan, 'elsarticle-num.bst');
    check('elsarticle-num.bst is replaceable and outdated',
      [nb.local.version, nb.upstream.version, nb.status], ['1.9', '2.1', 'outdated']);
    ok('alternative styles the project does not carry are not listed',
      !itemOf(elsPlan, 'elsarticle-harv.bst') && !itemOf(elsPlan, 'elsarticle-num-names.bst'));
  }

  console.log('\nAASTeX 6.3.1: superseded by a differently named class');
  const aasZip = zipOf('project-aas.zip', {
    'main.tex': '\\documentclass[twocolumn]{aastex631}\n\\begin{document}\nx\n\\end{document}\n',
    'aastex631.cls': fx.read('aastex631.cls'),
  });
  if (!OFFLINE) {
    const aasPlan = await scanOf(aasZip);
    const old = itemOf(aasPlan, 'aastex631.cls');
    check('aastex631.cls reported outdated against AASTeX 7',
      [old.local.version, old.status], ['6.3.1d', 'outdated']);
    ok('but never offered for writing: there is no newer aastex631.cls',
      old.applicable === false && old.selected === false);
    ok('the reason names the successor', /aastex701/.test(old.reason || ''));
    ok('the other superseded classes are not listed',
      !itemOf(aasPlan, 'aastex632.cls') && !itemOf(aasPlan, 'aastex63.cls'));
    ok('the current class is listed as available',
      itemOf(aasPlan, 'aastex701.cls') && itemOf(aasPlan, 'aastex701.cls').status === 'absent');
  }

  console.log('\nallowlist enforcement (registry data cannot widen network reach)');
  const denied = await new Promise((res) =>
    worker.__listener({ type: 'fetchText', url: 'https://evil.example.com/acmart.cls' }, {}, res));
  check('off-allowlist host refused', denied.ok, false);
  ok('refusal names the host', /evil\.example\.com/.test(denied.error), denied.error);

  const http = await new Promise((res) =>
    worker.__listener({ type: 'fetchText', url: 'http://ctan.org/x.cls' }, {}, res));
  check('plain HTTP refused even on an allowed host', http.ok, false);

  // A .bst has no \Provides line for expectName to check. A mirror's truncated
  // copy -- the failure actually observed with llncs.cls -- must still be caught.
  console.log('\na truncated BibTeX style is refused');
  const bstText = require('./fixtures').read('ACM-Reference-Format.bst');
  const refuses = (text, url) => {
    try { worker.assertUsable(text, url); return false; } catch { return true; }
  };
  ok('the complete style passes',
    !refuses(bstText, 'https://ctan.org/x/ACM-Reference-Format.bst'));
  ok('its first 4 KB is refused',
    refuses(bstText.slice(0, 4096), 'https://ctan.org/x/ACM-Reference-Format.bst'));
  ok('also when it came out of an archive',
    refuses(bstText.slice(0, 4096), 'https://portalparts.acm.org/a.zip#a/ACM-Reference-Format.bst'));
  ok('the check is specific to .bst files',
    !refuses('% unversioned style\n', 'https://raw.githubusercontent.com/x/acl.sty'));

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

  // The Convert-venue tab dynamically imports the venue profiles from an
  // extension URL. That only works if every module in the graph is listed in
  // web_accessible_resources, and a missing one fails at click time, not load
  // time -- so it is worth asserting statically.
  console.log('\nconvert tab wiring');
  const mf = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
  const war = mf.web_accessible_resources[0].resources;

  const venueDir = path.join(EXT, 'lib', 'venues');
  const venueFiles = fs.readdirSync(venueDir).filter((f) => f.endsWith('.js'));
  const unexposed = venueFiles.filter((f) => !war.includes(`lib/venues/${f}`));
  ok('every venue module is web-accessible', unexposed.length === 0,
    'missing from web_accessible_resources: ' + unexposed.join(', '));

  ok('convert.js is a content script',
    mf.content_scripts[0].js.includes('content/convert.js'));

  const convertSrc = fs.readFileSync(path.join(EXT, 'content', 'convert.js'), 'utf8');
  const imported = convertSrc.match(/getURL\('([^']+)'\)/);
  ok('convert.js imports a module that is actually exposed',
    imported && war.includes(imported[1]), imported && imported[1]);

  // .mjs is not reliably served as JavaScript; .js is. A module served with the
  // wrong MIME type is refused by the browser, which is how this first broke.
  ok('venue modules use .js, not .mjs',
    !venueFiles.some((f) => f.endsWith('.mjs')) &&
    !fs.readdirSync(venueDir).some((f) => f.endsWith('.mjs')));
  ok('a scoped package.json marks them as ES modules for Node',
    JSON.parse(fs.readFileSync(path.join(venueDir, 'package.json'), 'utf8')).type === 'module');

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
  console.log(`${pass} passed, ${fail} failed` + (skips.length ? `, ${skips.length} skipped` : ''));
  if (fail) { console.log('\nFailed:'); failures.forEach((f) => console.log('  - ' + f)); }
  if (skips.length) {
    console.log('\nSkipped:');
    skips.forEach((s) => console.log('  - ' + s));
    // Surfaced in the Actions run summary, so a skip cannot pass unnoticed.
    if (process.env.GITHUB_ACTIONS === 'true') {
      console.log(`::warning title=ACM checks skipped::${skips.length} check groups skipped: ${acmRefused}`);
    }
  }
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\nharness error:', err);
  process.exit(1);
});
