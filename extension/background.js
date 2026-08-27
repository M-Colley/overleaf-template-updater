/* Service worker: cross-origin fetches the content script cannot make itself,
 * the persistent upstream cache, and the pre-flight backup download.
 *
 * Classic (non-module) worker on purpose: importScripts lets it reuse the very
 * same lib/ files the content script uses, so the ZIP reader and the LaTeX
 * version parser have one implementation and one set of tests.
 *
 * The registry is data, and data must not be able to widen our reach, so every
 * outbound URL is checked against a fixed host allowlist here rather than
 * trusted because it appeared in templates.json. */

importScripts('lib/util.js', 'lib/unzip.js', 'lib/latex.js', 'lib/cache.js');

const ALLOWED_HOSTS = new Set([
  'ctan.org',
  'www.ctan.org',
  'mirror.ctan.org',
  'mirrors.ctan.org',
  // Named CTAN mirrors used as fallbacks when the ctan.org round-robin lands on
  // an unhealthy one.
  'ctan.math.illinois.edu',
  'ftp.fau.de',
  'raw.githubusercontent.com',
  'api.github.com',
  // ACM's own template distribution -- the only published source of a *built*
  // acmart.cls (CTAN and GitHub carry acmart.dtx sources only).
  'portalparts.acm.org',
]);

const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_ZIP_BYTES = 64 * 1024 * 1024; // the ACM template zip is ~15 MB

function assertAllowed(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Malformed URL: ${rawUrl}`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`Refusing non-HTTPS URL: ${rawUrl}`);
  }
  if (!ALLOWED_HOSTS.has(url.hostname)) {
    throw new Error(
      `Refusing to fetch from ${url.hostname}: not in the extension's allowlist.`
    );
  }
  return url.toString();
}

function looksLikeHtml(text) {
  return /^\s*<(!doctype|html)\b/i.test(text);
}

function validators(res) {
  return {
    etag: res.headers.get('etag'),
    lastModified: res.headers.get('last-modified'),
  };
}

function versionOf(text, versionFrom) {
  try {
    const v = OTU.latex.readVersion(text, versionFrom);
    return v && v.version ? v.version : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------ plain file sources */

/**
 * Reject a response that is the wrong file rather than merely a failed one.
 *
 * CTAN's ctan.org/tex-archive path is a round-robin redirector across community
 * mirrors, and they are not uniformly healthy: one was observed returning a 403
 * HTML page, and another served a valid-looking but truncated 4 KB "llncs.cls"
 * in place of the real 43 KB file. A wrong class file silently written into
 * someone's paper is the worst outcome this extension could produce, so the
 * content is checked before it is ever offered as an update.
 */
function assertUsable(text, url, expectName) {
  if (looksLikeHtml(text)) {
    throw new Error(`got an HTML page instead of a source file from ${url}`);
  }
  if (!expectName) return;

  const provides = OTU.latex.parseProvides(text);
  if (!provides) {
    throw new Error(
      `${url} returned a file with no \\ProvidesClass/\\ProvidesPackage line, ` +
      `so it cannot be confirmed as ${expectName}`
    );
  }
  if (provides.name.toLowerCase() !== expectName.toLowerCase()) {
    throw new Error(
      `${url} served "${provides.name}" but ${expectName} was expected ` +
      `(the mirror is serving the wrong file)`
    );
  }
}

async function fetchTextChecked(rawUrl, { expectedVersion, versionFrom, mirrors, expectName } = {}) {
  const url = assertAllowed(rawUrl);

  const entry = await OTU.cache.readMember(url, '');
  const why = OTU.cache.freshness(entry, { expectedVersion });
  if (why) return { text: entry.text, cached: why, version: entry.version };

  // Try the canonical URL, then each declared mirror, keeping the first
  // response that is actually the file we asked for.
  const candidates = [url, ...(mirrors || [])];
  const failures = [];

  for (const candidate of candidates) {
    let target;
    try {
      target = assertAllowed(candidate);
    } catch (err) {
      failures.push(err.message);
      continue;
    }

    try {
      const res = await fetch(target, {
        redirect: 'follow',
        // Validators belong to the canonical entry, so only revalidate against it.
        headers: target === url ? OTU.cache.conditionalHeaders(entry) : {},
      });

      if (res.status === 304 && entry) {
        await OTU.cache.writeMember(url, '', { ...entry, text: entry.text });
        return { text: entry.text, cached: 'revalidated', version: entry.version };
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const len = Number(res.headers.get('content-length') || 0);
      if (len > MAX_TEXT_BYTES) throw new Error(`oversized response (${len} bytes)`);

      const text = await res.text();
      if (text.length > MAX_TEXT_BYTES) throw new Error('oversized response');
      assertUsable(text, target, expectName);

      const version = versionOf(text, versionFrom);
      await OTU.cache.writeMember(url, '', { text, version, ...validators(res) });
      await OTU.cache.trim();
      return { text, cached: false, version, from: target };
    } catch (err) {
      failures.push(`${new URL(target).hostname}: ${err.message}`);
    }
  }

  throw new Error(
    `Could not fetch a usable copy from ${candidates.length} source(s). ` +
    failures.join('; ')
  );
}

/* --------------------------------------------------------------- zip source */

// Within one scan the archive is fetched once; across sessions the extracted
// members are what persist, so the 15 MB download is not repeated per project.
const zipCache = new Map(); // url -> Promise<Map<memberName, Uint8Array>>

async function downloadArchive(url, conditional) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: conditional || {},
  });
  if (res.status === 304) return { notModified: true, res };
  if (!res.ok) {
    // ACM's portal 403s requests without a browser User-Agent. Chrome sends a
    // real one for extension fetches, so a 403 here means something else.
    throw new Error(
      `HTTP ${res.status} fetching ${url}` +
      (res.status === 403 ? ' - the server rejected the request.' : '')
    );
  }
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_ZIP_BYTES) {
    throw new Error(`Refusing oversized archive (${buf.byteLength} bytes)`);
  }
  const entries = await OTU.unzip.read(buf);
  const map = new Map();
  for (const e of entries) map.set(e.name, e.bytes);
  return { notModified: false, res, map };
}

/**
 * Resolve a member name against the archive. Vendors rename their top-level
 * directory between releases, so fall back to matching on basename.
 */
function pickMember(map, member) {
  if (map.has(member)) return map.get(member);
  const wanted = member.split('/').pop().toLowerCase();
  const candidates = [...map.keys()].filter(
    (n) => n.split('/').pop().toLowerCase() === wanted
  );
  candidates.sort((a, b) => a.split('/').length - b.split('/').length);
  return candidates.length ? map.get(candidates[0]) : null;
}

/**
 * Extract one member from a remote archive, using and filling the cache.
 * `alsoCache` names the archive's other tracked members so a single download
 * populates the cache for every file the registry sources from it.
 */
async function fetchZipMember(rawUrl, member, { expectedVersion, versionFrom, alsoCache, expectName } = {}) {
  const url = assertAllowed(rawUrl);

  const entry = await OTU.cache.readMember(url, member);
  const why = OTU.cache.freshness(entry, { expectedVersion });
  if (why) return { text: entry.text, cached: why, version: entry.version };

  const archive = await OTU.cache.readArchive(url);
  // Only revalidate when a 304 would actually be usable, i.e. we still hold the
  // member the caller asked for.
  const conditional = entry && archive ? OTU.cache.conditionalHeaders(archive) : {};

  if (!zipCache.has(url)) {
    zipCache.set(url, downloadArchive(url, conditional));
    zipCache.get(url).catch(() => zipCache.delete(url));
  }
  const result = await zipCache.get(url);

  if (result.notModified) {
    await OTU.cache.writeArchive(url, { ...archive });
    await OTU.cache.writeMember(url, member, { ...entry, text: entry.text });
    return { text: entry.text, cached: 'revalidated', version: entry.version };
  }

  const bytes = pickMember(result.map, member);
  if (!bytes) {
    throw new Error(
      `"${member}" is not in the archive. It contains: ` +
      [...result.map.keys()].slice(0, 12).join(', ') +
      (result.map.size > 12 ? ', ...' : '')
    );
  }

  const text = OTU.util.bytesToText(bytes);
  assertUsable(text, url + '#' + member, expectName);
  const version = versionOf(text, versionFrom);
  const v = validators(result.res);

  await OTU.cache.writeArchive(url, { ...v, members: alsoCache || [member] });
  await OTU.cache.writeMember(url, member, { text, version, ...v });

  // One download, every tracked member cached.
  for (const other of alsoCache || []) {
    if (other === member) continue;
    const b = pickMember(result.map, other);
    if (!b) continue;
    const t = OTU.util.bytesToText(b);
    await OTU.cache.writeMember(url, other, { text: t, version: versionOf(t), ...v });
  }
  await OTU.cache.trim();

  return { text, cached: false, version };
}

/* -------------------------------------------------------------------- CTAN */

const ctanCache = new Map(); // pkg -> { at, data }
const CTAN_TTL_MS = 60 * 60 * 1000;

async function ctanPackage(pkg) {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(pkg)) {
    throw new Error(`Invalid CTAN package name: ${pkg}`);
  }
  const hit = ctanCache.get(pkg);
  if (hit && Date.now() - hit.at < CTAN_TTL_MS) return hit.data;

  const url = `https://ctan.org/json/2.0/pkg/${encodeURIComponent(pkg)}`;
  const res = await fetch(assertAllowed(url), { cache: 'no-cache' });
  if (!res.ok) throw new Error(`CTAN lookup for "${pkg}" returned HTTP ${res.status}`);

  const json = await res.json();
  const data = {
    version: json.version || null,
    name: json.name || pkg,
    caption: json.caption || null,
  };
  ctanCache.set(pkg, { at: Date.now(), data });
  return data;
}

/* ------------------------------------------------------------------ backup */

/**
 * Overleaf is not only www.overleaf.com: there are regional hosts such as
 * de.overleaf.com, and universities run self-hosted Server Pro instances on
 * their own domains. The backup must therefore be taken from the origin the
 * user is actually on -- hardcoding www would silently back up the wrong
 * server. The origin is taken from the calling tab, not from any message
 * payload, so a page cannot point the download somewhere else.
 */
async function backupProject(projectId, filename, sender) {
  if (!/^[0-9a-f]{24}$/i.test(projectId)) {
    throw new Error('Invalid project id');
  }
  const senderOrigin = sender && sender.origin
    ? sender.origin
    : sender && sender.url ? new URL(sender.url).origin : null;
  if (!senderOrigin || !senderOrigin.startsWith('https://')) {
    throw new Error('Refusing to download: caller has no secure origin.');
  }
  return chrome.downloads.download({
    url: `${senderOrigin}/project/${projectId}/download/zip`,
    filename,
    saveAs: false,
  });
}

/* ----------------------------------------------------------- self-hosting */

/**
 * Enable the extension on a self-hosted Overleaf the user has just granted.
 * The permission itself is requested from the popup (a user gesture); this only
 * registers the content scripts for an origin we already hold permission for.
 */
async function registerSite(origin) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    throw new Error('Invalid origin');
  }
  if (url.protocol !== 'https:') throw new Error('Only https origins are supported');

  const pattern = url.origin + '/*';
  const held = await chrome.permissions.contains({ origins: [pattern] });
  if (!held) throw new Error('Permission for this site has not been granted.');

  const manifest = chrome.runtime.getManifest();
  const spec = manifest.content_scripts[0];
  const id = 'otu-' + url.hostname;

  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] })
    .catch(() => []);
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [id] });

  await chrome.scripting.registerContentScripts([{
    id,
    matches: [pattern],
    js: spec.js,
    css: spec.css,
    runAt: 'document_idle',
    persistAcrossSessions: true,
  }]);
  return { registered: pattern };
}

/* --------------------------------------------------------------- dispatch */

const handlers = {
  fetchText: ({ url, expectedVersion, versionFrom, mirrors, expectName }) =>
    fetchTextChecked(url, { expectedVersion, versionFrom, mirrors, expectName }),
  fetchZipMember: ({ url, member, expectedVersion, versionFrom, alsoCache, expectName }) =>
    fetchZipMember(url, member, { expectedVersion, versionFrom, alsoCache, expectName }),
  ctanPackage: ({ pkg }) => ctanPackage(pkg),
  backupProject: ({ projectId, filename }, sender) =>
    backupProject(projectId, filename, sender).then((downloadId) => ({ downloadId })),
  registerSite: ({ origin }) => registerSite(origin),
  cacheStats: () => OTU.cache.stats(),
  cacheClear: () => OTU.cache.clear().then((removed) => ({ removed })),
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg && msg.type];
  if (!handler) {
    sendResponse({ ok: false, error: `Unknown request type: ${msg && msg.type}` });
    return false;
  }
  Promise.resolve()
    .then(() => handler(msg, sender))
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((err) => sendResponse({ ok: false, error: err.message }));
  return true; // keep the channel open for the async response
});
