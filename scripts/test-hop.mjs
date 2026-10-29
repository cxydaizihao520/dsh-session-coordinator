#!/usr/bin/env node
/**
 * T4（issue #6）：防环——默认两跳与回信即终。
 *
 * 沿用仓库既有缝隙（见 scripts/test-bridge-core.mjs / test-relay.mjs）：
 * Node 类型剥离直接 import src/hop.ts 与 src/core.ts，不构建、不起宿主。
 *
 * 覆盖票里的五条验收：
 *   1. 消息带因果根与跳数，只进 source，不进正文
 *   2. 到达上限后报终态原因（回执里可见）
 *   3. 规则文案写清「默认两跳、回信即终、如何回信」
 *   4. 缺失因果根的历史消息按新链处理，不报错
 *   5. 跳数判定是纯函数，覆盖 0/1/2/越界/缺失
 */
import assert from 'node:assert/strict'
import { DEFAULT_MAX_HOPS, HOP_RULE_TEXT, hopParentOf, nextHop } from '../src/hop.ts'
import { formatSourceLine, sourceIdentityMessage } from '../src/core.ts'

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

const firstMessage = { messageId: 'msg-root' }
const parent = (hopCount, rootMessageId = 'msg-root') => ({ rootMessageId, hopCount })

// --- 1. 跳数判定：0 / 1 / 2 / 越界 -------------------------------------------

await test('hop: 默认上限是两跳', () => {
  assert.equal(DEFAULT_MAX_HOPS, 2)
})

await test('hop 0：无父消息（新链）记第 1 跳、根是自己、非终态', () => {
  const d = nextHop(firstMessage)
  assert.deepEqual(d, { rootMessageId: 'msg-root', hopCount: 1, terminal: false })
  assert.ok(!('reason' in d), '非终态不带终态原因')
})

await test('hop 0：父记账为 0（旧字段/无效值）按新链处理，不报错', () => {
  const d = nextHop({ messageId: 'msg-1', parent: parent(0) })
  assert.equal(d.hopCount, 1)
  assert.equal(d.rootMessageId, 'msg-1', '无有效父记账 -> 自己当根')
  assert.equal(d.terminal, false)
})

await test('hop 1：回第 1 跳的消息 -> 第 2 跳、沿用链根、到上限即终态', () => {
  const d = nextHop({ messageId: 'msg-1', parent: parent(1) })
  assert.equal(d.hopCount, 2)
  assert.equal(d.rootMessageId, 'msg-root', '链根沿用父消息的根')
  assert.equal(d.terminal, true)
  assert.equal(typeof d.reason, 'string')
  assert.match(d.reason, /terminal/i, '终态原因要能被回执直接读出')
})

await test('hop 2：父已在上限（越界一格）仍是终态、且不抛错', () => {
  const d = nextHop({ messageId: 'msg-2', parent: parent(2) })
  assert.equal(d.hopCount, 3)
  assert.equal(d.rootMessageId, 'msg-root')
  assert.equal(d.terminal, true)
})

await test('hop 越界：父远超上限仍是终态', () => {
  const d = nextHop({ messageId: 'msg-9', parent: parent(7) })
  assert.equal(d.hopCount, 8)
  assert.equal(d.terminal, true)
})

// --- 2. 缺失因果根：按新链，不报错 -------------------------------------------

await test('缺失：没有父消息 -> 新链', () => {
  assert.deepEqual(nextHop({ messageId: 'msg-x' }), { rootMessageId: 'msg-x', hopCount: 1, terminal: false })
  assert.deepEqual(nextHop({ messageId: 'msg-x', parent: null }), { rootMessageId: 'msg-x', hopCount: 1, terminal: false })
})

await test('缺失：历史消息只有 messageId、没有根与跳数 -> 新链', () => {
  assert.deepEqual(nextHop({ messageId: 'msg-x', parent: { messageId: 'msg-old' } }), {
    rootMessageId: 'msg-x',
    hopCount: 1,
    terminal: false,
  })
})

await test('缺失：只有跳数没有根（或只有根没有跳数）-> 新链，不报错', () => {
  assert.equal(nextHop({ messageId: 'msg-x', parent: { hopCount: 1 } }).rootMessageId, 'msg-x')
  assert.equal(nextHop({ messageId: 'msg-x', parent: { rootMessageId: 'msg-root' } }).hopCount, 1)
})

await test('缺失：跳数是垃圾值（字符串/负数/NaN/小数）-> 新链，不抛错', () => {
  for (const bad of ['2', -1, Number.NaN, 1.5, null, {}]) {
    const d = nextHop({ messageId: 'msg-x', parent: { rootMessageId: 'msg-root', hopCount: bad } })
    assert.equal(d.hopCount, 1, `hopCount=${String(bad)} 应按新链处理`)
    assert.equal(d.rootMessageId, 'msg-x')
    assert.equal(d.terminal, false)
  }
})

// --- 3. 纯函数 ---------------------------------------------------------------

await test('纯函数：不改输入、同输入同输出', () => {
  const input = { messageId: 'msg-1', parent: parent(1) }
  const snapshot = JSON.stringify(input)
  assert.deepEqual(nextHop(input), nextHop(input))
  assert.equal(JSON.stringify(input), snapshot, '不能改写入参')
})

// --- 4. 从调用方日志解析父消息记账 -------------------------------------------

const relayEvent = (seq, identity) => ({ seq, time: seq, type: 'user/message', data: sourceIdentityMessage('正文', identity) })

await test('hopParentOf: 按 replyTo 从日志里取回父消息的根与跳数', () => {
  const events = [relayEvent(1, { senderSessionId: 'A', messageId: 'msg-root', rootMessageId: 'msg-root', hopCount: 1 })]
  assert.deepEqual(hopParentOf(events, 'msg-root'), { rootMessageId: 'msg-root', hopCount: 1 })
})

await test('hopParentOf: 找不到 / 没传 replyTo / 垃圾日志 -> undefined，不抛错', () => {
  const events = [relayEvent(1, { senderSessionId: 'A', messageId: 'msg-root', rootMessageId: 'msg-root', hopCount: 1 })]
  assert.equal(hopParentOf(events, 'msg-unknown'), undefined)
  assert.equal(hopParentOf(events, undefined), undefined)
  assert.equal(hopParentOf(events, ''), undefined)
  assert.equal(hopParentOf(null, 'msg-root'), undefined)
  assert.equal(hopParentOf({}, 'msg-root'), undefined)
})

await test('hopParentOf: 历史消息（没有因果根）取不到记账 -> 按新链处理，不报错', () => {
  const events = [relayEvent(1, { senderSessionId: 'A', messageId: 'msg-old' })]
  assert.deepEqual(nextHop({ messageId: 'msg-2', parent: hopParentOf(events, 'msg-old') }), {
    rootMessageId: 'msg-2',
    hopCount: 1,
    terminal: false,
  })
})

// --- 5. 与消息信封的集成：记账只进 source，不进正文 ---------------------------

await test('envelope: 因果根与跳数只在 source，正文逐字不变', () => {
  const identity = { senderSessionId: 'session-aaaa', messageId: 'msg-1', rootMessageId: 'msg-root', hopCount: 2 }
  const msg = sourceIdentityMessage('正文保持不变', identity)
  assert.equal(msg.source.rootMessageId, 'msg-root')
  assert.equal(msg.source.hopCount, 2)
  const bare = sourceIdentityMessage('正文保持不变', { senderSessionId: 'session-aaaa', messageId: 'msg-1' })
  assert.equal(msg.content[0].text, bare.content[0].text, '记账不得改动正文')
  assert.ok(msg.content[0].text.startsWith(formatSourceLine(identity) + '\n'))
  assert.ok(msg.content[0].text.endsWith('\n正文保持不变'))
  assert.doesNotMatch(msg.content[0].text, /\bhop|跳数/i, '用户可见正文里不出现跳数')
})

await test('envelope: 没有记账时不写空字段', () => {
  const msg = sourceIdentityMessage('hi', { senderSessionId: 'A', messageId: 'm' })
  assert.ok(!('rootMessageId' in msg.source))
  assert.ok(!('hopCount' in msg.source))
})

// --- 6. 端到端：A→B→A 在第二跳停住 ------------------------------------------

await test('end-to-end: A→B 第一跳、B→A 第二跳即终态、A 再回仍是终态', () => {
  // A 发第一跳（没有 replyTo -> 新链）
  const first = nextHop({ messageId: 'msg-1' })
  assert.deepEqual(first, { rootMessageId: 'msg-1', hopCount: 1, terminal: false })
  const aToB = sourceIdentityMessage('任务', { senderSessionId: 'A', messageId: 'msg-1', rootMessageId: 'msg-1', hopCount: 1 })

  // B 回信：从 B 自己的日志里认出 A 那条消息的记账
  const bLog = [{ seq: 1, time: 1, type: 'user/message', data: aToB }]
  const parentHop = hopParentOf(bLog, 'msg-1')
  const second = nextHop({ messageId: 'msg-2', parent: parentHop })
  assert.equal(second.hopCount, 2)
  assert.equal(second.rootMessageId, 'msg-1')
  assert.equal(second.terminal, true, '回信即终：第二跳到达就停')

  // A 若还硬要再回（越界），仍然报终态而不是报错
  const bToA = sourceIdentityMessage('回信', {
    senderSessionId: 'B',
    messageId: 'msg-2',
    rootMessageId: second.rootMessageId,
    hopCount: second.hopCount,
  })
  const third = nextHop({ messageId: 'msg-3', parent: hopParentOf([{ seq: 1, time: 1, type: 'user/message', data: bToA }], 'msg-2') })
  assert.equal(third.hopCount, 3)
  assert.equal(third.rootMessageId, 'msg-1')
  assert.equal(third.terminal, true)
})

// --- 7. 规则文案 -------------------------------------------------------------

await test('rule text: 写清默认两跳、回信即终、如何回信', () => {
  assert.match(HOP_RULE_TEXT, /hop 2/i)
  assert.match(HOP_RULE_TEXT, /terminal/i)
  assert.match(HOP_RULE_TEXT, /replyTo/)
  assert.match(HOP_RULE_TEXT, /session_coordinator_send/)
  assert.match(HOP_RULE_TEXT, /hop count/i, '说明跳数是插件侧记账')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
