#!/usr/bin/env node
/**
 * T3（issue #5）：单条消息的三级回执查询。
 *
 * 走仓库既有的"纯函数 + 合成事件日志"缝隙（见 scripts/test-bridge-core.mjs）：
 * Node 类型剥离直接 import src/receipts.ts，不构建、不起宿主。
 *
 * 事件形状取自真实 V4 会话日志（0.2.1-rc.3）：
 *   - 进 inbox：`agent/inbox/spliced`，data.inserted 里是完整消息对象（带 id 与 source）
 *   - 写入历史：`user/message`，data 就是那条消息（id + source）
 *   - 模型请求：`step/start`（一步＝一次模型调用）、`request/header`（派发前落盘）、
 *     `assistant/message` / `assistant/attempt`（模型已产出，说明那次请求真的发过）
 *
 * 覆盖四类分支：只有 inbox 条目 → 已接收；历史里有 → 已写入；写入之后有模型请求
 * → 已进入模型请求；查不到证据 → 未知（绝不报成功）。两种身份（工具路径的
 * messageId、GUI 路径的 requestId）都要认，否则 GUI 发的消息永远查不到。
 */
import assert from 'node:assert/strict'
import { deriveReceipt, registerReceipt } from '../src/receipts.ts'

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

// --- 合成事件日志 -------------------------------------------------------------

/** 工具路径（#3）的消息：source.kind='session-message'，带 senderSessionId/messageId。 */
const relayMessage = (messageId = 'msg-1111') => ({
  id: messageId,
  role: 'user',
  content: [{ type: 'text', text: '来自会话 session-aaaa · 回信请发给它\n任务' }],
  source: { kind: 'session-message', senderSessionId: 'session-aaaa', messageId },
})

/** GUI 路径（#4 / ADR-0003）的消息：宿主固定写 source={kind:'user', rpcId}。 */
const guiMessage = (rpcId = 'req-2222') => ({
  id: 'host-generated-id',
  role: 'user',
  content: [{ type: 'text', text: '来自会话 session-aaaa · 回信请发给它\n任务' }],
  source: { kind: 'user', rpcId, clientTimeZone: 'Asia/Shanghai' },
})

const inboxSpliced = (seq, message) => ({
  seq, time: seq, type: 'agent/inbox/spliced',
  data: { target: 'next-turn', start: 0, inserted: [message] },
})
/** 同一条消息被领走（真实日志里 removed 只有计数、没有 id，无法按身份匹配）。 */
const inboxRemoved = (seq) => ({
  seq, time: seq, type: 'agent/inbox/spliced',
  data: { target: 'next-turn', start: 0, inserted: [], removedCount: 1 },
})
const userMessage = (seq, message) => ({ seq, time: seq, type: 'user/message', data: message })
const stepStart = (seq, turn = 1, step = 1) => ({ seq, time: seq, type: 'step/start', data: { turn, step } })
const stepEnd = (seq, turn = 1, step = 1) => ({ seq, time: seq, type: 'step/end', data: { turn, step } })
const requestHeader = (seq) => ({ seq, time: seq, type: 'request/header', data: { header: {}, reason: 'initial' } })
const assistantMessage = (seq, turn = 1, step = 1) => ({
  seq, time: seq, type: 'assistant/message',
  data: { turn, step, message: { content: [{ type: 'text', text: '收到' }] } },
})
const turnStart = (seq, turn = 1) => ({ seq, time: seq, type: 'turn/start', data: { turn } })

// --- 1. 四类分支 --------------------------------------------------------------

await test('只有 inbox 条目：已接收，未写入', () => {
  const receipt = deriveReceipt([turnStart(1), inboxSpliced(2, relayMessage())], 'msg-1111')
  assert.equal(receipt.status, 'accepted')
  assert.equal(receipt.evidence.inboxSeq, 2)
  assert.equal(receipt.evidence.appendedSeq, undefined, 'nothing written yet')
})

await test('目标历史出现该消息：已写入', () => {
  const receipt = deriveReceipt([inboxSpliced(2, relayMessage()), userMessage(5, relayMessage())], 'msg-1111')
  assert.equal(receipt.status, 'appended')
  assert.equal(receipt.evidence.inboxSeq, 2)
  assert.equal(receipt.evidence.appendedSeq, 5)
  assert.equal(receipt.evidence.requestSeq, undefined, 'no model request evidence yet')
})

await test('写入之后出现模型请求（step/start）：已进入模型请求', () => {
  const receipt = deriveReceipt([
    inboxSpliced(2, relayMessage()),
    userMessage(5, relayMessage()),
    stepEnd(6),
    stepStart(7, 1, 2),
  ], 'msg-1111')
  assert.equal(receipt.status, 'acknowledged')
  assert.equal(receipt.evidence.appendedSeq, 5)
  assert.equal(receipt.evidence.requestSeq, 7)
  assert.equal(receipt.evidence.requestType, 'step/start')
})

await test('写入与那次请求同一步（只有 assistant/message 在写入之后）：已进入模型请求', () => {
  // 真实日志里 steered 消息写在 step 内：step/start 在前、user/message 居中、
  // 同一段的 assistant/message 在写入之后 —— 只认"更晚的 step/start"会漏掉单步轮。
  const receipt = deriveReceipt([
    stepStart(3),
    userMessage(5, relayMessage()),
    assistantMessage(6),
  ], 'msg-1111')
  assert.equal(receipt.status, 'acknowledged')
  assert.equal(receipt.evidence.requestType, 'assistant/message')
})

await test('写入之后出现 request/header：已进入模型请求', () => {
  const receipt = deriveReceipt([userMessage(5, relayMessage()), requestHeader(6)], 'msg-1111')
  assert.equal(receipt.status, 'acknowledged')
  assert.equal(receipt.evidence.requestType, 'request/header')
})

await test('证据缺失 / 消息标识未知：未知，且不报成功', () => {
  const empty = deriveReceipt([], 'msg-1111')
  assert.equal(empty.status, 'unknown')
  assert.deepEqual(empty.evidence, {})

  const noMatch = deriveReceipt([
    inboxSpliced(2, guiMessage('req-other')),
    userMessage(5, guiMessage('req-other')),
    stepStart(6),
  ], 'msg-1111')
  assert.equal(noMatch.status, 'unknown', 'another message id must never be reported as success')
  assert.deepEqual(noMatch.evidence, {})
})

// --- 2. 证据顺序 --------------------------------------------------------------

await test('模型请求早于写入：不算已进入模型请求', () => {
  const receipt = deriveReceipt([
    stepStart(3),
    assistantMessage(4),
    userMessage(5, relayMessage()),
    stepEnd(6),
  ], 'msg-1111')
  assert.equal(receipt.status, 'appended')
  assert.equal(receipt.evidence.requestSeq, undefined)
})

await test('inbox 条目被领走（removedCount）不影响已写入的判定', () => {
  const receipt = deriveReceipt([
    inboxSpliced(2, relayMessage()),
    inboxRemoved(3),
    userMessage(5, relayMessage()),
  ], 'msg-1111')
  assert.equal(receipt.status, 'appended')
  assert.equal(receipt.evidence.appendedSeq, 5)
})

// --- 3. 两种身份 --------------------------------------------------------------

await test('GUI 身份（requestId = source.rpcId）：inbox 条目可查', () => {
  const receipt = deriveReceipt([inboxSpliced(2, guiMessage('req-2222'))], 'req-2222')
  assert.equal(receipt.status, 'accepted')
  assert.equal(receipt.evidence.inboxSeq, 2)
})

await test('GUI 身份（requestId = source.rpcId）：写入与模型请求可查', () => {
  const receipt = deriveReceipt([
    inboxSpliced(2, guiMessage('req-2222')),
    userMessage(5, guiMessage('req-2222')),
    assistantMessage(6),
  ], 'req-2222')
  assert.equal(receipt.status, 'acknowledged')
  assert.equal(receipt.evidence.appendedSeq, 5)
})

// --- 4. 纯函数 ----------------------------------------------------------------

await test('纯函数：不改动传入的事件日志，两次调用结果一致', () => {
  const events = [inboxSpliced(2, relayMessage()), userMessage(5, relayMessage()), assistantMessage(6)]
  const snapshot = JSON.parse(JSON.stringify(events))
  const first = deriveReceipt(events, 'msg-1111')
  const second = deriveReceipt(events, 'msg-1111')
  assert.deepEqual(events, snapshot, 'events must not be mutated')
  assert.deepEqual(first, second)
})

// --- 5. 工具面 ----------------------------------------------------------------

function captureTool() {
  const tools = new Map()
  // 离线会话：走持久化读路径；'gone' 模拟会话不存在。
  const ctx = {
    tools: { register: (tool) => { tools.set(tool.name, tool) } },
    agents: { get: () => undefined, list: () => [] },
    sessionPersistence: {
      open: async (id) => {
        if (id === 'gone') throw new Error('session "gone" not found')
        return {
          header: {},
          read: async () => ({ events: id === 'terminal' ? [userMessage(1, { ...relayMessage('reply'), source: { kind: 'session-message', messageId: 'reply', rootMessageId: 'task', hopCount: 2 } }), stepStart(2)] : id === 'written' ? [inboxSpliced(2, relayMessage()), userMessage(5, relayMessage())] : [] }),
          close: async () => {},
        }
      },
    },
  }
  registerReceipt(ctx)
  return tools.get('session_coordinator_message_status')
}

await test('工具：名称与参数（sessionId + 消息标识都必填）', () => {
  const tool = captureTool()
  assert.ok(tool !== undefined, 'session_coordinator_message_status must register')
  const props = tool.parameters?.properties ?? {}
  assert.equal(props.sessionId?.type, 'string')
  assert.equal(props.messageId?.type, 'string')
  assert.deepEqual(JSON.parse(JSON.stringify(tool.parameters?.required ?? [])), ['sessionId', 'messageId'])
})

await test('工具：四类状态都能渲染，未知不报成功', async () => {
  const tool = captureTool()
  const render = (args, value) => tool.output.render(args, value).map((block) => block.text).join('\n')

  const unknown = await tool.execute({ sessionId: 'empty', messageId: 'msg-1111' }, {})
  assert.equal(unknown.status, 'unknown')
  assert.ok(render({}, unknown).includes('未知'))
  assert.ok(!render({}, unknown).includes('已写入'), 'unknown must not render as success')

  const appended = await tool.execute({ sessionId: 'written', messageId: 'msg-1111' }, {})
  assert.equal(appended.status, 'appended')
  const appendedText = render({}, appended)
  assert.ok(appendedText.includes('已写入'))
  assert.ok(appendedText.includes('user/message'), 'evidence location is rendered')
  assert.deepEqual(JSON.parse(JSON.stringify(appended)), appended, 'tool value must be lossless JSON')
})

await test('工具：读不到的会话报错，不返回未知以外的成功', async () => {
  const tool = captureTool()
  await assert.rejects(
    () => tool.execute({ sessionId: 'gone', messageId: 'msg-1111' }, {}),
    (error) => error.message.includes('gone'),
  )
})

await test('终态回信的回执带跳数和原因；旧 GUI 消息不臆造终态', () => {
  const reply = relayMessage('reply')
  Object.assign(reply.source, { rootMessageId: 'task', hopCount: 2 })
  const receipt = deriveReceipt([userMessage(1, reply), stepStart(2)], 'reply')
  assert.equal(receipt.status, 'acknowledged')
  assert.equal(receipt.terminal, true)
  assert.equal(receipt.hopCount, 2)
  assert.match(receipt.terminalReason, /terminal/)
  assert.equal(deriveReceipt([userMessage(1, guiMessage())], 'req-2222').terminal, undefined)
})

await test('终态字段经工具真实返回并渲染，不能只留在纯函数里', async () => {
  const tool = captureTool()
  const value = await tool.execute({ sessionId: 'terminal', messageId: 'reply' }, {})
  assert.equal(value.terminal, true)
  assert.equal(value.hopCount, 2)
  assert.match(tool.output.render({}, value).map(part => part.text).join('\n'), /terminal:/)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
