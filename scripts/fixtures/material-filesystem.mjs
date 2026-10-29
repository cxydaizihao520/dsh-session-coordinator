import { open, readFile, realpath, stat } from 'node:fs/promises'

/** Test adapter at the native scoped filesystem boundary, backed by actual scratch files. */
export const materialFilesystem = {
  processPathFromHostPath: path => path,
  resolve: realpath,
  processPath: target => target,
  async stat(target) { const info = await stat(target); return { type: info.isFile() ? 'file' : 'directory', size: info.size, version: `${info.mtimeMs}:${info.ctimeMs}:${info.size}` } },
  async readBytes(target, signal, maxBytes) { const bytes = await readFile(target, { signal }); if (bytes.byteLength > maxBytes) throw new Error('read limit exceeded'); return bytes },
  async readByteRange(target, { offset, length }, signal) {
    signal?.throwIfAborted()
    const handle = await open(target, 'r')
    try { const buffer = Buffer.alloc(length); const read = await handle.read(buffer, 0, length, offset); return buffer.subarray(0, read.bytesRead) }
    finally { await handle.close() }
  },
}
