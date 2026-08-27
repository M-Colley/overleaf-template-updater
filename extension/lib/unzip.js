/* Minimal ZIP reader.
 *
 * We read the whole Overleaf project via GET /project/:id/download/zip, which
 * is one request and needs no undocumented entity API. Rather than pull in a
 * zip library, this parses the central directory directly and inflates entries
 * with the platform's DecompressionStream('deflate-raw').
 *
 * Supported: stored (method 0) and deflate (method 8) -- the only two methods
 * Overleaf's exporter emits. ZIP64 is detected and reported rather than
 * silently mis-parsed. */
var OTU = (typeof OTU !== 'undefined' && OTU) || {};

OTU.unzip = (function () {
  'use strict';

  const SIG_EOCD = 0x06054b50;
  const SIG_CDIR = 0x02014b50;
  const SIG_LOCAL = 0x04034b50;
  const SIG_EOCD64_LOCATOR = 0x07064b50;

  function findEocd(view, len) {
    // The EOCD is 22 bytes plus an optional comment of up to 65535 bytes.
    const minStart = Math.max(0, len - 22 - 0xffff);
    for (let i = len - 22; i >= minStart; i--) {
      if (view.getUint32(i, true) === SIG_EOCD) return i;
    }
    return -1;
  }

  async function inflateRaw(bytes) {
    const stream = new Blob([bytes]).stream()
      .pipeThrough(new DecompressionStream('deflate-raw'));
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  /**
   * @param {ArrayBuffer} buffer  raw .zip bytes
   * @returns {Promise<Array<{name:string, bytes:Uint8Array, size:number}>>}
   */
  async function read(buffer) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    const len = bytes.length;

    const eocd = findEocd(view, len);
    if (eocd < 0) throw new Error('Not a ZIP file (no end-of-central-directory record found)');

    // Reject ZIP64 loudly instead of reading garbage offsets.
    if (eocd >= 20 && view.getUint32(eocd - 20, true) === SIG_EOCD64_LOCATOR) {
      throw new Error('ZIP64 archives are not supported (project too large to read this way)');
    }

    const entryCount = view.getUint16(eocd + 10, true);
    let ptr = view.getUint32(eocd + 16, true); // central directory offset

    const decoder = new TextDecoder('utf-8');
    const out = [];

    for (let n = 0; n < entryCount; n++) {
      if (view.getUint32(ptr, true) !== SIG_CDIR) {
        throw new Error('Corrupt ZIP: bad central directory signature at entry ' + n);
      }
      const method = view.getUint16(ptr + 10, true);
      const compressedSize = view.getUint32(ptr + 20, true);
      const uncompressedSize = view.getUint32(ptr + 24, true);
      const nameLen = view.getUint16(ptr + 28, true);
      const extraLen = view.getUint16(ptr + 30, true);
      const commentLen = view.getUint16(ptr + 32, true);
      const localOffset = view.getUint32(ptr + 42, true);
      const name = decoder.decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));

      ptr += 46 + nameLen + extraLen + commentLen;

      if (name.endsWith('/')) continue; // directory entry

      // The local header repeats name/extra lengths, and they can differ from
      // the central directory's, so we must re-read them here.
      if (view.getUint32(localOffset, true) !== SIG_LOCAL) {
        throw new Error('Corrupt ZIP: bad local header for ' + name);
      }
      const lNameLen = view.getUint16(localOffset + 26, true);
      const lExtraLen = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + lNameLen + lExtraLen;
      const raw = bytes.subarray(dataStart, dataStart + compressedSize);

      let content;
      if (method === 0) {
        content = raw.slice();
      } else if (method === 8) {
        content = await inflateRaw(raw);
      } else {
        throw new Error('Unsupported ZIP compression method ' + method + ' for ' + name);
      }

      out.push({ name, bytes: content, size: uncompressedSize || content.length });
    }

    return out;
  }

  return { read };
})();
