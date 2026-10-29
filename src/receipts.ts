/**
 * 单条消息的三级回执（issue #5 / PLAN T3.1）：拿着消息标识去目标会话的事件日志里
 * 找证据，能证到哪一级就报哪一级，查不到就报「未知」——绝不推测成功。
 *
 * 三级（术语见 GLOSSARY「回执」）：
 *   accepted     已接收：消息躺在目标 inbox 里，还没写进目标历史
 *   appended     已写入：目标历史里出现了这条 user/message
 *   acknowledged 已进入模型请求：写入之后目标发起过模型请求
 *
 * 状态推导是纯函数 `deriveReceipt`（无副作用、不改事件），工具层只负责读日志、
 * 校验参数与渲染；只读查询不改变任何会话状态。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { DEFAULT_MAX_HOPS, TERMINAL_REASON } from './hop.ts'
import { asEventList, getLiveAgent, inspectPersistedSession, sessionEvents } from './core.ts'

export type ReceiptStatus = 'accepted' | 'appended' | 'acknowledged' | 'unknown'

/** 证据位置：每级命中的事件序号与事件类型（序号即日志里的位置）。 */
export interface ReceiptEvidence {
  /** inbox 条目：`agent/inbox/spliced` 的 inserted 里出现了这条消息。 */
  inboxSeq?: number
  /** 目标历史写入：`user/message` 事件序号。 */
  appendedSeq?: number
  /** 写入之后的模型请求证据事件序号。 */
  requestSeq?: number
  requestType?: string
}

export interface Receipt {
  rootMessageId?: string
  hopCount?: number
  terminal?: boolean
  terminalReason?: string
  status: ReceiptStatus
  evidence: ReceiptEvidence
}

/**
 * 能证明"写入之后目标发起过模型请求"的事件（形状取自真实 V4 会话日志）：
 * - `step/start`：开一步＝一次模型调用；
 * - `request/header`：下一次请求的头部，派发前落盘；
 * - `assistant/message` / `assistant/attempt`：模型已产出（或已尝试），即那次请求
 *   确实发过——单步轮里写入事件夹在 step/start 与它之间，只认更晚的 step/start 会漏。
 */
const REQUEST_EVIDENCE_TYPES: ReadonlySet<string> = new Set([
  'step/start',
  'request/header',
  'assistant/message',
  'assistant/attempt',
])

/**
 * 消息标识匹配。两种身份都要认，否则其中一条路径发的消息永远查不到：
 * - 工具路径（#3）：`source.kind='session-message'`，带 `source.messageId`；
 * - GUI 路径（#4 / ADR-0003）：宿主固定写 `source={kind:'user', rpcId}`，身份是 `rpcId`。
 * 另外宿主把消息原样落盘时 `message.id` 就是工具路径的 messageId（T0.3 自定义
 * source 的实机日志尚未验），一并认下以免工具路径整体失效。
 */
function identityMatches(raw: unknown, id: string): boolean {
  const message = raw as { id?: unknown; source?: { messageId?: unknown; rpcId?: unknown } | null } | null | undefined
  if (message === null || message === undefined) return false
  if (message.id === id) return true
  const source = message.source
  return source !== null && source !== undefined && (source.messageId === id || source.rpcId === id)
}

function causalReceipt(raw: unknown): Partial<Receipt> {
  const source = (raw as { source?: { kind?: string; rootMessageId?: unknown; hopCount?: unknown; purpose?: unknown } })?.source
  if (source?.kind !== 'session-message' || typeof source.rootMessageId !== 'string' ||
    typeof source.hopCount !== 'number' || !Number.isInteger(source.hopCount) || source.hopCount < 1) return {}
  const information = source.purpose === 'information'
  const terminal = information || source.hopCount >= DEFAULT_MAX_HOPS
  return { rootMessageId: source.rootMessageId, hopCount: source.hopCount, terminal,
    ...(terminal ? { terminalReason: information ? 'information only; no reply requested or permitted' : TERMINAL_REASON } : {}) }
}

/**
 * 从目标会话的事件日志推导一条消息的回执（纯函数）。
 *
 * 判定顺序：先找 inbox 条目与目标历史写入，两者都没有 → unknown；有写入再看写入
 * 之后有没有模型请求证据 → acknowledged，否则 appended；只有 inbox 条目 → accepted。
 * inbox 的移除事件只带 removedCount、不带消息 id，无法按身份匹配，故不参与判定：
 * 被领走后必然留下写入事件（更强的证据），被丢弃则维持 accepted。
 */
export function deriveReceipt(events: readonly SessionEvent[], messageId: string): Receipt {
  const list = asEventList(events)
  let causal: Partial<Receipt> = {}
  let inboxSeq: number | undefined
  let appendedSeq: number | undefined
  for (const event of list) {
    if (event.type === 'agent/inbox/spliced') {
      const inserted = (event.data as { inserted?: unknown }).inserted
      if (inboxSeq === undefined && Array.isArray(inserted)) {
        const match = inserted.find(item => identityMatches(item, messageId))
        if (match !== undefined) { inboxSeq = event.seq; causal = causalReceipt(match) }
      }
    } else if (event.type === 'user/message') {
      if (appendedSeq === undefined && identityMatches(event.data, messageId)) { appendedSeq = event.seq; causal = causalReceipt(event.data) }
    }
  }
  const evidence: ReceiptEvidence = {}
  if (inboxSeq !== undefined) evidence.inboxSeq = inboxSeq
  if (appendedSeq === undefined) return { ...causal, status: inboxSeq === undefined ? 'unknown' : 'accepted', evidence }
  evidence.appendedSeq = appendedSeq
  for (const event of list) {
    if (event.seq <= appendedSeq) continue
    if (!REQUEST_EVIDENCE_TYPES.has(event.type)) continue
    evidence.requestSeq = event.seq
    evidence.requestType = event.type
    return { ...causal, status: 'acknowledged', evidence }
  }
  return { ...causal, status: 'appended', evidence }
}

/** 三级状态的中文说法（渲染用；术语与 GLOSSARY 一致）。 */
const STATUS_TEXT: Record<ReceiptStatus, string> = {
  accepted: '已接收，未写入',
  appended: '已写入',
  acknowledged: '已进入模型请求',
  unknown: '未知',
}

/** 工具返回值必须是 lossless JSON 对象（与 tools.ts 其他工具同一形状）。 */
function asJson(value: unknown): Record<string, JsonValue> {
  return value as Record<string, JsonValue>
}

interface ReceiptArgs {
  sessionId: string
  messageId: string
}

/**
 * 注册只读回执查询工具。输入是「目标会话 + 一个消息标识」：调用方（投递方）
 * 手上有 session_coordinator_send 返回的 messageId，GUI 面板那侧手上有 requestId，
 * 两者都是同一个匹配函数认的身份，所以只留一个 messageId 参数。
 */
export function registerReceipt(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'session_coordinator_message_status',
    description: 'Query the delivery receipt of ONE message in a target session, by reading that session event log only — it never sends, resumes, or changes anything. Three levels, each reported only when the log proves it: accepted (the message sits in the target inbox but is not in its history yet), appended (a user/message carrying this identity is in the target history), acknowledged (after that write the target dispatched a model request — step/start, request/header, or a produced assistant message). If the log holds no evidence for this id the status is unknown: it never reports success without evidence. Pass the messageId returned by session_coordinator_send, or for a message delivered from the GUI send panel the request id of that delivery (current panels use that request id as messageId; legacy panels stored source.rpcId).',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Target session id the message was delivered to (live or persisted/offline).' },
      messageId: { type: 'string', required: true, description: 'Message identity: the messageId from session_coordinator_send, or the request id of a GUI send (host stores it as source.rpcId).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const v = value as Record<string, unknown>
        const status = v.status as ReceiptStatus
        const evidence = (v.evidence as ReceiptEvidence | undefined) ?? {}
        const lines = [
          'message ' + String(v.messageId) + ' @ ' + String(v.sessionId),
          'status: ' + STATUS_TEXT[status] + ' (' + status + ')',
        ]
        if (v.terminal === true) lines.push('terminal: ' + String(v.terminalReason))
        const where: string[] = []
        if (evidence.inboxSeq !== undefined) where.push('inbox entry: agent/inbox/spliced seq ' + String(evidence.inboxSeq))
        if (evidence.appendedSeq !== undefined) where.push('target history: user/message seq ' + String(evidence.appendedSeq))
        if (evidence.requestSeq !== undefined) where.push('model request: ' + String(evidence.requestType) + ' seq ' + String(evidence.requestSeq))
        if (where.length === 0) where.push('no evidence in the target session log')
        return [{ type: 'text' as const, text: lines.concat(where.map((line) => 'evidence: ' + line)).join('\n') }]
      },
    },
    async execute(args: ReceiptArgs) {
      if (typeof args.sessionId !== 'string' || args.sessionId.trim() === '') throw new Error('invalid sessionId: expected a non-empty string')
      if (typeof args.messageId !== 'string' || args.messageId.trim() === '') throw new Error('invalid messageId: expected a non-empty string')
      const messageId = args.messageId.trim()
      const agent = getLiveAgent(ctx, args.sessionId)
      let events: readonly SessionEvent[]
      if (agent === undefined) {
        try {
          events = (await inspectPersistedSession(ctx, args.sessionId)).events
        } catch (error) {
          throw new Error('cannot read session ' + JSON.stringify(args.sessionId) + ': ' + (error instanceof Error ? error.message : String(error)))
        }
      } else {
        events = sessionEvents(agent.session)
      }
      const receipt = deriveReceipt(events, messageId)
      return asJson({ sessionId: args.sessionId, messageId, ...receipt })
    },
  }))
}
