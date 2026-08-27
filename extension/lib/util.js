/* Overleaf Template Updater - shared namespace + small helpers.
 * Content scripts declared in manifest.json share one global scope, so every
 * lib file hangs itself off this single `OTU` object rather than using ESM. */
var OTU = (typeof OTU !== 'undefined' && OTU) || {};

OTU.util = (function () {
  'use strict';

  const td = new TextDecoder('utf-8', { fatal: false });
  const te = new TextEncoder();

  /** Decode bytes as UTF-8 text. LaTeX sources are occasionally latin-1; the
   *  non-fatal decoder yields U+FFFD for those bytes rather than throwing, which
   *  is fine because we only ever *read* such files (never rewrite them). */
  function bytesToText(bytes) {
    return td.decode(bytes);
  }

  function textToBytes(text) {
    return te.encode(text);
  }

  async function sha256Hex(bytes) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /** Basename of a zip/project path: "chapters/intro.tex" -> "intro.tex" */
  function basename(path) {
    const i = path.lastIndexOf('/');
    return i === -1 ? path : path.slice(i + 1);
  }

  /** Directory part, '' for root-level files. */
  function dirname(path) {
    const i = path.lastIndexOf('/');
    return i === -1 ? '' : path.slice(0, i);
  }

  function extname(path) {
    const base = basename(path);
    const i = base.lastIndexOf('.');
    return i <= 0 ? '' : base.slice(i).toLowerCase();
  }

  /** Overleaf's project zip nests everything under the project name for some
   *  exports and not others. Normalise to project-relative paths. */
  function normalizeZipPaths(entries) {
    const names = entries.map((e) => e.name);
    const roots = new Set(names.map((n) => n.split('/')[0]));
    const everythingNested =
      roots.size === 1 && names.every((n) => n.includes('/'));
    if (!everythingNested) return entries;
    const prefix = [...roots][0] + '/';
    return entries.map((e) => ({ ...e, name: e.name.slice(prefix.length) }));
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function timestampSlug() {
    const d = new Date();
    const p = (x) => String(x).padStart(2, '0');
    return (
      d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
      '-' + p(d.getHours()) + p(d.getMinutes())
    );
  }

  /** Ask the background service worker to do a cross-origin fetch.
   *  Content scripts are bound by the page's CORS rules; the worker is not. */
  function bg(type, payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type, ...payload }, (res) => {
        const err = chrome.runtime.lastError;
        if (err) return reject(new Error(err.message));
        if (!res) return reject(new Error('No response from background worker'));
        if (res.ok === false) return reject(new Error(res.error || 'Background request failed'));
        resolve(res);
      });
    });
  }

  return {
    bytesToText, textToBytes, sha256Hex, basename, dirname, extname,
    normalizeZipPaths, escapeHtml, fmtBytes, timestampSlug, bg,
  };
})();
