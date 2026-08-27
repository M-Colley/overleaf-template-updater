/* Overleaf project client.
 *
 * Overleaf publishes no REST API for project contents (www.overleaf.com/devs
 * only documents the one-way "Open in Overleaf" /docs endpoint), so this speaks
 * the same internal endpoints the established open-source clients use --
 * pyoverleaf and overleaf-sync. Running as a content script on the project page
 * means the session cookie and CSRF token are already there; we never handle
 * the user's password.
 *
 * Endpoints used:
 *   GET    /project/:id/download/zip          -> whole project, one request
 *   GET    /socket.io/1/?projectId=:id&t=ms   -> socket handshake, returns sid
 *   WSS    /socket.io/1/websocket/:sid?projectId=:id
 *                                             -> pushes joinProjectResponse,
 *                                                the only source of folder IDs
 *   POST   /project/:id/upload?folder_id=:fid -> create or overwrite a file
 *   DELETE /project/:id/:type/:entityId       -> remove doc|file|folder
 *
 * These are internal and unversioned. Every call goes through checkOk(), which
 * fails loudly rather than letting a changed response shape turn into a silent
 * no-op on someone's paper. */
var OTU = (typeof OTU !== 'undefined' && OTU) || {};

OTU.overleaf = (function () {
  'use strict';

  const HOST = location.host;

  function projectId() {
    const m = location.pathname.match(/\/project\/([0-9a-f]{24})/i);
    return m ? m[1] : null;
  }

  function csrfToken() {
    const meta = document.querySelector('meta[name="ol-csrfToken"]');
    if (meta && meta.content) return meta.content;
    // Older layouts exposed it on a hidden input.
    const input = document.querySelector('input[name="_csrf"]');
    if (input && input.value) return input.value;
    throw new Error(
      'Could not find the Overleaf CSRF token on this page. ' +
      'Reload the project page and try again.'
    );
  }

  function baseHeaders() {
    return {
      Accept: 'application/json',
      'Cache-Control': 'no-cache',
      'x-csrf-token': csrfToken(),
    };
  }

  async function checkOk(res, what) {
    if (res.ok) return res;
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch { /* ignore */ }
    throw new Error(`${what} failed: HTTP ${res.status} ${res.statusText}. ${detail}`);
  }

  /* ---------------------------------------------------------------- reading */

  /** The entire project as zip bytes. One request, no socket, no entity API. */
  async function downloadProjectZip(id = projectId()) {
    const res = await fetch(`/project/${id}/download/zip`, {
      credentials: 'include',
      headers: { 'Cache-Control': 'no-cache' },
    });
    await checkOk(res, 'Downloading project zip');
    return res.arrayBuffer();
  }

  /**
   * The project's folder/doc/file tree, including the entity IDs that uploads
   * and deletes require. Overleaf only exposes these over the realtime socket.
   */
  function getFileTree(id = projectId(), { timeoutMs = 20000 } = {}) {
    return new Promise((resolve, reject) => {
      let ws = null;
      let settled = false;

      const done = (err, val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { if (ws && ws.readyState <= 1) ws.close(); } catch { /* ignore */ }
        err ? reject(err) : resolve(val);
      };

      const timer = setTimeout(
        () => done(new Error('Timed out waiting for the Overleaf project socket.')),
        timeoutMs
      );

      fetch(`/socket.io/1/?projectId=${id}&t=${Date.now()}`, { credentials: 'include' })
        .then((r) => checkOk(r, 'Socket handshake'))
        .then((r) => r.text())
        .then((text) => {
          const sid = text.split(':')[0];
          if (!sid) throw new Error('Socket handshake returned no session id.');

          ws = new WebSocket(`wss://${HOST}/socket.io/1/websocket/${sid}?projectId=${id}`);
          ws.onerror = () => done(new Error('Project socket connection failed.'));
          ws.onclose = () =>
            done(new Error('Project socket closed before the file tree arrived.'));

          ws.onmessage = (ev) => {
            const line = typeof ev.data === 'string' ? ev.data : '';
            if (line.startsWith('7:')) {
              return done(new Error('Overleaf refused the socket connection (not authorised).'));
            }
            if (!line.startsWith('5:')) return; // 1:: connect, 2:: heartbeat, etc.

            let msg;
            try {
              msg = JSON.parse(line.slice(2).replace(/^:+/, ''));
            } catch {
              return; // not the frame we want
            }
            if (msg.name !== 'joinProjectResponse') return;

            const payload = msg.args && msg.args[0];
            const roots = payload && payload.project && payload.project.rootFolder;
            if (!Array.isArray(roots) || roots.length !== 1) {
              return done(new Error('Unexpected joinProjectResponse shape from Overleaf.'));
            }
            done(null, roots[0]);
          };
        })
        .catch(done);
    });
  }

  /**
   * Flatten the tree into path -> entity records.
   * @returns {Map<string, {id:string, name:string, type:'doc'|'file', folderId:string, path:string}>}
   */
  function flattenTree(root) {
    const byPath = new Map();
    const folders = new Map(); // path -> folder id

    (function walk(folder, prefix) {
      folders.set(prefix, folder._id);
      for (const d of folder.docs || []) {
        const p = prefix ? `${prefix}/${d.name}` : d.name;
        byPath.set(p, { id: d._id, name: d.name, type: 'doc', folderId: folder._id, path: p });
      }
      for (const f of folder.fileRefs || []) {
        const p = prefix ? `${prefix}/${f.name}` : f.name;
        byPath.set(p, { id: f._id, name: f.name, type: 'file', folderId: folder._id, path: p });
      }
      for (const sub of folder.folders || []) {
        walk(sub, prefix ? `${prefix}/${sub.name}` : sub.name);
      }
    })(root, '');

    return { byPath, folders, rootFolderId: root._id };
  }

  /* ---------------------------------------------------------------- writing */

  /**
   * Create or overwrite a file. Overleaf replaces a same-named entity in the
   * same folder in place, so the project's version history keeps the old
   * content and the change is revertible from Overleaf's own History view.
   */
  async function uploadFile(folderId, name, bytes, id = projectId()) {
    const form = new FormData();
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    form.append('relativePath', 'null');
    form.append('name', name);
    form.append('type', 'application/octet-stream');
    form.append('qqfile', blob, name);

    const res = await fetch(
      `/project/${id}/upload?folder_id=${encodeURIComponent(folderId)}`,
      { method: 'POST', credentials: 'include', headers: baseHeaders(), body: form }
    );
    await checkOk(res, `Uploading ${name}`);

    const json = await res.json().catch(() => ({}));
    if (json.success === false) {
      throw new Error(`Overleaf rejected the upload of ${name}: ${json.error || 'unknown reason'}`);
    }
    return json; // { success, entity_id, entity_type }
  }

  /** Delete a doc, file, or folder by entity id. */
  async function deleteEntity(type, entityId, id = projectId()) {
    if (!['doc', 'file', 'folder'].includes(type)) {
      throw new Error(`Refusing to delete unknown entity type "${type}"`);
    }
    const res = await fetch(`/project/${id}/${type}/${encodeURIComponent(entityId)}`, {
      method: 'DELETE',
      credentials: 'include',
      headers: { ...baseHeaders(), 'Content-Type': 'application/json' },
      body: '{}',
    });
    await checkOk(res, `Deleting ${type} ${entityId}`);
    return true;
  }

  return {
    projectId, csrfToken, downloadProjectZip, getFileTree, flattenTree,
    uploadFile, deleteEntity,
  };
})();
