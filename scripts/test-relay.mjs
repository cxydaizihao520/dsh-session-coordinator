#!/usr/bin/env node
/**
 * T1（issue #3）：跨会话投递的来源标识。
 *
 * 走仓库既有的"纯函数 + 合成事件日志"缝隙（见 scripts/test-bridge-core.mjs）：
 * Node 类型剥离直接 import src/core.ts，不构建、不起宿主。
 *
 * 覆盖三件事：
 *   1. 正文首行头部（有/无标签、标签需净化）
 *   2. 消息信封（自定义来源类型、发送方、消息 id、可选回复给）
 *   3. 读取路径必须把这类消息当作用户消息（否则 read/wait 看不到它）
 */
import assert from 'node:assert/strict'
import { SOURCE_KIND, foldMessages, formatSourceLine, sourceIdentityMessage } from '../src/core.ts'

let passed = 0
let failed = 0

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log('PASS ' + name)
  } catch (error) {
    failed += 1
    console.error('FAIL ' + name)
    console.error('     ' + (error instanceof Error ? error.message : String(error)))
  }
}

const identity = { senderSessionId: 'session-aaaa', messageId: 'msg-1111' }

// --- 1. 头部 -----------------------------------------------------------------

await test('header: 无标签时包含发送方 id 与回信提示', () => {
  const header = formatSourceLine(identity)
  assert.match(header, /session-aaaa/)
  assert.match(header, /回信请发给它/)
})

await test('header: 有标签时同时出现标题与 id', () => {
  const header = formatSourceLine({ ...identity, senderLabel: '会话协调开发' })
  assert.match(header, /会话协调开发/)
  assert.match(header, /session-aaaa/)
})

await test('header: 任务给回信地址，已收到的回信不再要求回给来源', () => {
  const task = sourceIdentityMessage('任务正文', identity)
  const reply = sourceIdentityMessage('结果正文', { ...identity, replyTo: 'root-task', rootMessageId: 'root-task', hopCount: 2 })
  assert.match(task.content[0].text.split('\n')[0], /回信请发给它$/)
  assert.equal(reply.content[0].text.split('\n')[0], '来自会话 session-aaaa · 回信')
  assert.doesNotMatch(reply.content[0].text.split('\n')[0], /请发给它/)
  assert.match(reply.content[0].text.split('\n')[1], /replyTo=root-task/)
  assert.equal(reply.content[0].text.split('\n').slice(2).join('\n'), '结果正文')
})

await test('header: 标签里的换行与超长内容被净化', () => {
  const header = formatSourceLine({ ...identity, senderLabel: 'a\nb\tc' })
  assert.ok(!header.includes('\n'), 'header must stay single-line')
  assert.match(header, /a b c/)

  const long = formatSourceLine({ ...identity, senderLabel: 'x'.repeat(80) })
  assert.ok(long.length < 120, 'long label must be truncated')
  assert.match(long, /…/)
})

// --- 2. 信封 -----------------------------------------------------------------

await test('relay message: 首行头部 + 原文逐字保留', () => {
  const text = '接口字段用 caseSerial\n时间窗口是 [startTime, endTime)  🚀'
  const msg = sourceIdentityMessage(text, identity)
  const content = msg.content[0].text
  const [first, identityLine, ...rest] = content.split('\n')
  assert.ok(identityLine.includes('replyTo=msg-1111'))
  assert.equal(first, formatSourceLine(identity), 'first line is the header')
  assert.equal(rest.join('\n'), text, 'body must be byte-identical')
})

await test('relay message: 自定义来源带发送方与消息 id', () => {
  const msg = sourceIdentityMessage('hi', identity)
  assert.equal(msg.role, 'user')
  assert.equal(msg.id, 'msg-1111', 'message id is the identity id')
  assert.equal(msg.source.kind, 'session-message')
  assert.equal(msg.source.senderSessionId, 'session-aaaa')
  assert.equal(msg.source.messageId, 'msg-1111')
  assert.ok(!('replyTo' in msg.source), 'replyTo omitted when absent')
})

await test('relay message: 带回复给时写入 replyTo', () => {
  const msg = sourceIdentityMessage('hi', { ...identity, replyTo: 'msg-0000' })
  assert.equal(msg.source.replyTo, 'msg-0000')
})

// --- 3. 读取路径 -------------------------------------------------------------

const relayEvent = (seq, text) => ({
  seq,
  time: seq,
  type: 'user/message',
  data: {
    id: 'msg-1111',
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'session-message', senderSessionId: 'session-aaaa', messageId: 'msg-1111' },
  },
})

const plainEvent = (seq, text) => ({
  seq,
  time: seq,
  type: 'user/message',
  data: { content: [{ type: 'text', text }], source: { kind: 'user' } },
})

const systemEvent = (seq, text) => ({
  seq,
  time: seq,
  type: 'user/message',
  data: { content: [{ type: 'text', text }], source: { kind: 'tool' } },
})

await test('foldMessages: 跨会话消息可被读到', () => {
  const rows = foldMessages([relayEvent(1, '来自 A 的任务'), plainEvent(2, '用户自己说的'), systemEvent(3, '工具注入')])
  assert.equal(rows.length, 2, 'tool-sourced rows stay hidden')
  assert.equal(rows[0].role, 'user')
  assert.match(rows[0].text, /来自 A 的任务/)
})


await test('header: 来源 id 含换行/空值时仍是单行且不留双空格', () => {
  const withNewline = formatSourceLine({ ...identity, senderSessionId: 'session-aa\naa' })
  assert.equal(withNewline, '来自会话 session-aa aa · 回信请发给它')

  const blank = formatSourceLine({ senderSessionId: '   ', messageId: 'msg-x' })
  assert.match(blank, /未知会话/)
  assert.ok(!blank.includes('  '), 'no double space')
})

await test('source kind: 常量与信封一致', () => {
  assert.equal(SOURCE_KIND, 'session-message')
  assert.equal(sourceIdentityMessage('hi', identity).source.kind, SOURCE_KIND)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
