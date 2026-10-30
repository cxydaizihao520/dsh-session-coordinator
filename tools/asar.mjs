#!/usr/bin/env node
/**
 * DSH 取证工具：读 macOS 桌面端的 app.asar（不是目录，是一个归档）。
 *
 * 为什么需要它：核实宿主行为时只能读打包产物，而 asar 的目录表在文件头里，
 * 一旦换版本、旧索引就会把「另一个 build 的偏移」套到新文件上——结果不是报错，
 * 而是静默抽出别的包的内容（本项目 2026-10-24 踩过）。所以这里把索引和
 * 「文件大小 + mtime + 运行时版本」绑在一起，对不上就重建，绝不静默复用。
 *
 * 用法：
 *   node tools/asar.mjs doctor                  # 版本 + 文件数 + 索引状态
 *   node tools/asar.mjs index [--force]         # 重建索引
 *   node tools/asar.mjs cat <path>              # 打印一个文件
 *   node tools/asar.mjs extract <path...> --out <dir>
 *   node tools/asar.mjs grep <regex> [pathRegex] # 按行扫，默认只看 .js/.mjs/.ts
 *
 * 默认归档路径可用 DSH_ASAR 覆盖。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ARCHIVE = process.env.DSH_ASAR ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'
const CACHE = path.join(ROOT, 'tools', '.cache', 'asar-index.json')

/** 归档头：16 字节里取头长度与 JSON 长度；数据起点 = 8 + 头长度。 */
function readHeader(archive) {
  const fd = fs.openSync(archive, 'r')
  const head = Buffer.alloc(16)
  fs.readSync(fd, head, 0, 16, 0)
  const headerSize = head.readUInt32LE(4)
  const jsonLength = head.readUInt32LE(12)
  const json = Buffer.alloc(jsonLength)
  fs.readSync(fd, json, 0, jsonLength, 16)
  return { fd, base: 8 + headerSize, tree: JSON.parse(json.toString('utf8')) }
}

/** 深度优先铺平成 path → {offset,size}。 */
function flatten(tree) {
  const flat = new Map()
  const walk = (node, prefix) => {
    for (const [name, value] of Object.entries(node.files ?? {})) {
      const p = `${prefix}/${name}`
      if (value.files) walk(value, p)
      else flat.set(p, value)
    }
  }
  walk(tree, '')
  return flat
}

function archiveFingerprint() {
  const st = fs.statSync(ARCHIVE)
  return { asarPath: ARCHIVE, asarSize: st.size, asarMtimeMs: Math.trunc(st.mtimeMs) }
}

function readAt(fd, base, entry) {
  const offset = Number(entry.offset)
  const size = Number(entry.size)
  if (!Number.isFinite(offset) || !Number.isFinite(size)) return undefined
  const buf = Buffer.alloc(size)
  fs.readSync(fd, buf, 0, size, base + offset)
  return buf
}

/** 打开归档并把索引对齐到当前文件；对不上就重建（带提示，不静默）。 */
function openIndexed({ force = false } = {}) {
  const { fd, base, tree } = readHeader(ARCHIVE)
  const flat = flatten(tree)
  const fp = archiveFingerprint()
  const head = flat.get('/dsh/package.json')
  const runtimeVersion = head === undefined
    ? 'unknown'
    : (JSON.parse(readAt(fd, base, head).toString('utf8')).version ?? 'unknown')

  let cached
  try { cached = JSON.parse(fs.readFileSync(CACHE, 'utf8')) } catch { cached = undefined }
  const fresh = cached !== undefined
    && cached.asarPath === fp.asarPath
    && cached.asarSize === fp.asarSize
    && cached.asarMtimeMs === fp.asarMtimeMs
    && cached.runtimeVersion === runtimeVersion
    && Array.isArray(cached.files)

  if (force || !fresh) {
    if (cached !== undefined && !fresh) {
      console.warn('[asar] 旧索引与当前归档不一致（版本/大小/mtime 变化），已重建；不要复用旧索引的偏移。')
    }
    fs.mkdirSync(path.dirname(CACHE), { recursive: true })
    fs.writeFileSync(CACHE, JSON.stringify({
      ...fp,
      runtimeVersion,
      builtAt: new Date().toISOString(),
      files: [...flat.entries()].map(([p, e]) => [p, Number(e.offset), Number(e.size)]),
    }))
  }
  return { fd, base, flat, runtimeVersion, reused: fresh && !force }
}

const cmd = process.argv[2]
const args = process.argv.slice(3)

if (cmd === 'doctor') {
  const { flat, runtimeVersion, reused } = openIndexed()
  console.log(`archive:   ${ARCHIVE}`)
  console.log(`runtime:   ${runtimeVersion}`)
  console.log(`files:     ${flat.size}`)
  console.log(`index:     ${reused ? 'cached (fingerprint matches)' : 'rebuilt'}`)
  console.log(`cache:     ${CACHE}`)
} else if (cmd === 'index') {
  const { flat, runtimeVersion } = openIndexed({ force: true })
  console.log(`rebuilt index for ${runtimeVersion}: ${flat.size} files`)
} else if (cmd === 'cat') {
  const target = args[0]
  if (target === undefined) throw new Error('usage: asar.mjs cat <path>')
  const { fd, base, flat } = openIndexed()
  const entry = flat.get(target)
  if (entry === undefined) throw new Error(`not found: ${target}`)
  process.stdout.write(readAt(fd, base, entry))
} else if (cmd === 'extract') {
  const outIndex = args.indexOf('--out')
  const outDir = outIndex === -1 ? undefined : args[outIndex + 1]
  const paths = args.filter((a, i) => i !== outIndex && i !== outIndex + 1)
  if (outDir === undefined || paths.length === 0) throw new Error('usage: asar.mjs extract <path...> --out <dir>')
  const { fd, base, flat } = openIndexed()
  for (const p of paths) {
    const entry = flat.get(p)
    if (entry === undefined) { console.log('MISSING', p); continue }
    const out = path.join(outDir, p.replace(/^\//, ''))
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, readAt(fd, base, entry))
    console.log('OK', out)
  }
} else if (cmd === 'grep') {
  const pattern = args[0]
  if (pattern === undefined) throw new Error('usage: asar.mjs grep <regex> [pathRegex]')
  const scope = new RegExp(args[1] ?? '.')
  const re = new RegExp(pattern)
  const { fd, base, flat } = openIndexed()
  let hits = 0
  for (const [p, entry] of flat) {
    if (!/\.(?:js|mjs|cjs|ts)$/.test(p) || !scope.test(p)) continue
    if (Number(entry.size) > 900_000) continue
    const text = readAt(fd, base, entry)?.toString('utf8')
    if (text === undefined) continue
    text.split('\n').forEach((line, i) => {
      if (!re.test(line)) return
      hits += 1
      if (hits <= 100) console.log(`${p}:${i + 1}: ${line.trim().slice(0, 200)}`)
    })
  }
  console.log(`--- total hits: ${hits}`)
} else {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?/, '').replace(/^ ?\* ?/gm, ''))
  process.exit(cmd === undefined || cmd === '--help' || cmd === '-h' ? 0 : 1)
}
