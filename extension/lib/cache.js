/* Persistent, cross-project cache for upstream template files.
 *
 * Two things make this worth having:
 *   - MV3 service workers are killed after ~30s idle, so an in-memory cache is
 *     gone by the time you open your next project.
 *   - The acmart source is a 15 MB archive. Re-downloading it per project is
 *     the single most cumbersome thing about the extension.
 *
 * We cache the *extracted members* (acmart.cls is 122 KB, not 15 MB), so the
 * whole cache is well under a megabyte and lives comfortably in
 * chrome.storage.local. Freshness is decided in this order:
 *
 *   1. a version tag -- if CTAN says acmart is v2.20 and the cached file
 *      reports v2.20, it is current by definition and needs no network at all
 *   2. a short TTL, for sources with no published version (IEEEtran)
 *   3. a conditional GET -- both CTAN and ACM send ETag and Last-Modified, and
 *      ACM answers If-Modified-Since with a 0-byte 304, so revalidating even
 *      the big archive is nearly free
 *
 * The upshot: the second project you open costs zero bytes. */
var OTU = (typeof OTU !== 'undefined' && OTU) || {};

OTU.cache = (function () {
  'use strict';

  const PREFIX = 'otu:cache:v1:';
  const ARCHIVE_PREFIX = 'otu:archive:v1:';
  const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
  const MAX_ENTRY_BYTES = 2 * 1024 * 1024;
  const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

  const memberKey = (url, member) => PREFIX + url + '#' + (member || '');
  const archiveKey = (url) => ARCHIVE_PREFIX + url;

  async function get(key) {
    const res = await chrome.storage.local.get(key);
    return res[key] || null;
  }

  async function put(key, value) {
    if (value.text && value.text.length > MAX_ENTRY_BYTES) return false;
    try {
      await chrome.storage.local.set({ [key]: value });
      return true;
    } catch (err) {
      // Quota exceeded, most likely. Drop the cache and carry on uncached
      // rather than failing the user's update.
      console.warn('[Template Updater] cache write failed:', err.message);
      await clear();
      return false;
    }
  }

  /**
   * Is this entry usable without touching the network?
   * @returns {'version'|'ttl'|null} why it is fresh, or null
   */
  function freshness(entry, { expectedVersion, ttlMs = DEFAULT_TTL_MS } = {}) {
    if (!entry) return null;
    if (expectedVersion && entry.version && entry.version === expectedVersion) {
      return 'version';
    }
    if (Date.now() - (entry.fetchedAt || 0) < ttlMs) return 'ttl';
    return null;
  }

  function readMember(url, member) { return get(memberKey(url, member)); }

  function writeMember(url, member, { text, version, etag, lastModified }) {
    return put(memberKey(url, member), {
      text, version: version || null,
      etag: etag || null, lastModified: lastModified || null,
      fetchedAt: Date.now(), bytes: text.length,
    });
  }

  function readArchive(url) { return get(archiveKey(url)); }

  function writeArchive(url, { etag, lastModified, members }) {
    return put(archiveKey(url), {
      etag: etag || null, lastModified: lastModified || null,
      fetchedAt: Date.now(), members: members || [],
    });
  }

  /** Validators to send on a conditional GET. */
  function conditionalHeaders(entry) {
    const h = {};
    if (!entry) return h;
    if (entry.etag) h['If-None-Match'] = entry.etag;
    if (entry.lastModified) h['If-Modified-Since'] = entry.lastModified;
    return h;
  }

  async function stats() {
    const all = await chrome.storage.local.get(null);
    const entries = [];
    let total = 0;
    for (const [k, v] of Object.entries(all)) {
      if (!k.startsWith(PREFIX)) continue;
      const bytes = (v && v.bytes) || 0;
      total += bytes;
      const [url, member] = k.slice(PREFIX.length).split('#');
      entries.push({
        name: (member || url).split('/').pop() || url,
        member, url, bytes,
        version: v && v.version,
        fetchedAt: v && v.fetchedAt,
      });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return { entries, totalBytes: total, count: entries.length };
  }

  async function clear() {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter(
      (k) => k.startsWith(PREFIX) || k.startsWith(ARCHIVE_PREFIX)
    );
    if (keys.length) await chrome.storage.local.remove(keys);
    return keys.length;
  }

  /** Evict the oldest entries if the cache has grown past its budget. */
  async function trim() {
    const { entries, totalBytes } = await stats();
    if (totalBytes <= MAX_TOTAL_BYTES) return 0;
    entries.sort((a, b) => (a.fetchedAt || 0) - (b.fetchedAt || 0));
    let freed = 0;
    const doomed = [];
    for (const e of entries) {
      if (totalBytes - freed <= MAX_TOTAL_BYTES) break;
      doomed.push(memberKey(e.url, e.member));
      freed += e.bytes;
    }
    if (doomed.length) await chrome.storage.local.remove(doomed);
    return doomed.length;
  }

  return {
    freshness, readMember, writeMember, readArchive, writeArchive,
    conditionalHeaders, stats, clear, trim,
    DEFAULT_TTL_MS,
  };
})();
