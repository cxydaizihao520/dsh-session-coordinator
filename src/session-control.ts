import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { BridgeEnv } from './tools.ts'
import { CONTROL_ACTIONS, requestCoordinationApproval } from './delivery.ts'
import { diagnosticTool } from './diagnostics.ts'
import { getLiveAgent, sessionEvents, throwIfCollaborationAborted, type LiveAgentLike } from './core.ts'
import type { CommandResult, CoordinateInvocation } from './coordinate.ts'

export interface SessionControlInput {
  object: 'message' | 'communication' | 'execution' | 'task' | 'authorization'
  action: 'edit' | 'withdraw' | 'revoke' | 'interrupt' | 'pause' | 'resume' | 'revise' | 'cancel' | 'finish' | 'block' | 'fail' | 'revalidate'
  taskHandle?: string
  taskId?: string
  reason?: string
  objective?: string
  evidenceRefs?: string[]
  requestId: string
  messageId?: string
  expectedRevision?: number
  content?: string
  handle?: string
  sessionId?: string
  expectedExecution?: string
  controlHandle?: string
}
export type SessionControlResult = Record<string, JsonValue>
export interface SessionControlChoice { label:string; input:Omit<SessionControlInput,'requestId'> }
export const controlAuthorizationSchema = {type:'object' as const,additionalProperties:false,properties:{controllers:{type:'array',items:{type:'string'},description:'Exact approved members who may control; defaults to the caller, not all members. Being a controller does not implicitly make that session an approved target.'},targets:{type:'array',items:{type:'string'},description:'Exact approved sessions affected by control; omit to default to all participants. For task controls this must include the task owner AND every task member, including the caller when it owns the task: pausing a task also pauses its owner dispatch. Do not list only the recipients when the user approved control of the complete task.'},actions:{type:'array',items:{type:'string',enum:[...CONTROL_ACTIONS]},required:true}},description:'Only for work extent, and only control actions explicitly allowed by the user. The first native approval displays this scope; communication alone never grants control. execution.interrupt affects the entire named turn, not just one business item; job.stop remains subject to native owner permissions.'} as const

export function registerSessionControl(env: BridgeEnv): void {
  env.ctx.tools.register(diagnosticTool(env.ctx, defineTool({
    name: 'session_coordinator_control',
    description: 'Independently edit/withdraw one pending message, revoke one communication or control permission, or interrupt one observed execution. Reuse a current explicitly approved control scope for its listed actor/targets/actions/purpose; select it with controlHandle when ambiguous. Communication alone grants no execution control. An uncovered action requests native one-action approval; an invalid explicit controlHandle is rejected. Optional object=task supports pause/resume/revise/cancel/finish/block/fail/revalidate with taskHandle and expectedRevision. After restart or permission loss, explicit resume uses stable taskId, expectedRevision and reason instead of taskHandle, obtaining new approval restricted to that one task. Read original operations and effects before dispatching remaining work. Historical receipts do not restore executable handles. Owner completion retains real evidenceRefs validation. Task cancellation reports separate pending, execution and job outcomes; cancelled state does not mean all work stopped. An independent job is stopped by its owner with native job_list/job_output/job_kill, verifying producer terminal state; no task declaration or startup wrapper required. Never interrupt a whole mixed execution as a substitute. Communication revocation preserves admitted messages, approved control scopes and work; authorization.revoke separately revokes its control handle. Withdrawal does not stop work. Interrupt affects the whole named current turn and retains other inbox inputs; background jobs may continue. Edit replaces the entire pending body with text, removing attachments/references while preserving original records. No close/end is required for ordinary work.',
    parameters: {
      object: { type: 'string', enum: ['message', 'communication', 'execution', 'task', 'authorization'], required: true },
      action: { type: 'string', enum: ['edit', 'withdraw', 'revoke', 'interrupt', 'pause', 'resume', 'revise', 'cancel', 'finish', 'block', 'fail', 'revalidate'], required: true, description:'For object=task: block means wait for user/dependency without holding the model turn; pause stops new steps for this task; resume reconciles prior effects and continues remaining work, including from blocked. These are plugin work states, not native Team task statuses. No process suspension is implied. The owner may block its own task via its existing task authority; pause/resume/revise/cancel require their exact control authorization or an explicit native human command.' },
      taskHandle:{type:'string',description:'Only for object=task.'},taskId:{type:'string',description:'Stable task identity, only for explicit resume after restart or permission loss; obtains a new task-restricted approval.'},reason:{type:'string',description:'Required only for object=task. Omit for message, communication and execution.'},objective:{type:'string',description:'Only for object=task/action=revise.'},evidenceRefs:{type:'array',items:{type:'string'},description:'Only for object=task/action=finish or revalidate.'},
      requestId: { type: 'string', required: true, description:'Unique mutation identity, 8–120 letters, digits, underscores or hyphens.' },
      messageId: { type: 'string', description:'Required only for object=message; do not also pass sessionId.' }, expectedRevision: { type: 'number', description:'Required for message edit or task control; omit for message withdraw.' }, content: { type: 'string', description:'Only for object=message/action=edit.' },
      handle: { type: 'string', description:'For communication.revoke use its communicationHandle (or original once messageId); for authorization.revoke use the control permission handle.' }, sessionId: { type: 'string', description:'Required only for object=execution/action=interrupt.' }, expectedExecution: { type: 'string', description:'Current executionId from status, only for object=execution/action=interrupt.' },
      controlHandle:{type:'string',description:'Select one previously approved control scope. It grants nothing by itself; an uncovered action/actor/target is rejected. Omit to request native one-action approval when no matching scope exists.'},
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text' as const, text: JSON.stringify(value) }] },
    async execute(args: SessionControlInput, exec) {
      return executeSessionControl(env,args,exec)
    },
  })))
}

/** Tools and native human commands share validation, mutation identity and audit. */
export async function executeSessionControl(env:BridgeEnv,args:SessionControlInput,exec:{agent?:unknown;signal:AbortSignal;callId?:string},checkUser?:()=>void):Promise<SessionControlResult> {
  checkUser?.()
  if(args.controlHandle!==undefined&&(typeof args.controlHandle!=='string'||!args.controlHandle||args.controlHandle!==args.controlHandle.trim()))throw new Error('controlHandle must be an exact nonempty handle')
  if (typeof args.requestId !== 'string' || !/^[\w-]{8,120}$/.test(args.requestId)) throw new Error('invalid control requestId')
  if (args.object === 'task') {
    if(args.taskId!==undefined){
      const allowed=new Set(['object','action','requestId','taskId','expectedRevision','reason'])
      if(args.action!=='resume'||!args.taskId?.trim()||!args.reason?.trim()||Object.entries(args).some(([key,value])=>value!==undefined&&!allowed.has(key)))throw new Error('taskId recovery requires exact resume identity, revision and reason')
      return env.delivery!.control(structuredClone(args),exec,async()=>{},async beforeMutation=>await (await env.collaboration!).recoverSessionTask({...args,taskId:args.taskId!},exec,beforeMutation,checkUser) as unknown as SessionControlResult,checkUser)
    }
    const allowed = new Set(['object','action','requestId','taskHandle','expectedRevision','reason','controlHandle',...(args.action==='revise'?['objective']:[]),...(['finish','revalidate'].includes(args.action)?['evidenceRefs']:[])])
    for (const [key,value] of Object.entries(args)) if (value!==undefined&&!allowed.has(key)) throw new Error('unexpected task control field: '+key)
    if (!['pause','resume','revise','cancel','finish','block','fail','revalidate'].includes(args.action)||!args.reason?.trim()) throw new Error('invalid task control action/reason')
    return env.delivery!.control(structuredClone(args),exec,async()=>{},async beforeMutation=>await (await env.collaboration!).controlSessionTask(args,exec,beforeMutation,checkUser) as unknown as SessionControlResult,checkUser)
  }
  const valid = args.object === 'message' && ['edit', 'withdraw'].includes(args.action) && args.messageId || ['communication','authorization'].includes(args.object) && args.action === 'revoke' && args.handle || args.object === 'execution' && args.action === 'interrupt' && args.sessionId && args.expectedExecution
  if (!valid) throw new Error('control requires an exact object/action and identity')
  const allowed = new Set(['object', 'action', 'requestId', 'controlHandle', ...(args.object === 'message' ? ['messageId', ...(args.action === 'edit' ? ['expectedRevision', 'content'] : [])] : ['communication','authorization'].includes(args.object) ? ['handle'] : ['sessionId', 'expectedExecution'])])
  for (const [key, value] of Object.entries(args)) if (value !== undefined && !allowed.has(key)) throw new Error('unexpected control field for this object/action: ' + key)
  if (args.action === 'edit' && (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision! < 1 || typeof args.content !== 'string' || !args.content.trim())) throw new Error('edit requires expectedRevision and nonempty exact text')
  return env.delivery!.control(structuredClone(args),exec,async()=>{if(checkUser){checkUser();return checkUser}await requestCoordinationApproval(env.ctx,exec,'session_coordinator_control',JSON.stringify({...args,...(args.action==='interrupt'?{impact:'interrupt the entire named execution; retain inbox; background jobs are not stopped'}:{})}))},undefined,checkUser)
}

/** Native commands are human entry points; model arguments cannot supply this proof. */
export async function sessionControlCommand(env:BridgeEnv,payload:CoordinateInvocation):Promise<CommandResult> {
  try {
    const caller=payload.agent as LiveAgentLike|undefined
    const check=()=>{
      if(!payload.signal)throw new Error('native command cancellation signal unavailable')
      throwIfCollaborationAborted(payload.signal)
      if(!caller||getLiveAgent(env.ctx,caller.id)!==caller||!payload.commandId)throw new Error('native user command identity unavailable')
      const own=sessionEvents(caller.session).filter(event=>caller.session.isOwnSeq?.(event.seq)===true) as unknown as readonly {type:string;data:{commandId?:string;name?:string;args?:string;source?:{kind?:string}}}[]
      const runs=own.filter(event=>event.type==='command/run'&&event.data.commandId===payload.commandId)
      const run=runs[0]
      if(runs.length!==1||run?.type!=='command/run'||run.data.name!=='coordinate'||run.data.args!==payload.rawInput||run.data.source?.kind!=='user'||own.some(event=>event.type==='command/done'&&event.data.commandId===payload.commandId))throw new Error('no current exact native user command')
    }
    check()
    const exec={agent:caller,callId:payload.commandId!,signal:payload.signal!}
    const raw=payload.rawInput?.trim()??''
    if(raw==='controls') {
      let tasks:SessionControlChoice[]=[],taskControlsUnavailable=false
      try{tasks=await (await env.collaboration!).sessionControlChoices(exec)}catch{taskControlsUnavailable=true}
      check()
      return {kind:'success',text:JSON.stringify({choices:[...tasks,...env.delivery!.controlChoices(caller!)],taskControlsUnavailable})}
    }
    if(!raw.startsWith('control '))throw new Error('invalid native control command')
    const input:SessionControlInput=JSON.parse(raw.slice(8))
    if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('invalid native control input')
    const result=await executeSessionControl(env,input,exec,check)
    if(input.object==='task'&&input.action==='resume'&&result.outcome==='applied'&&typeof result.taskHandle==='string') {
      try {await (await env.collaboration!).notifySessionTaskResumed(result.taskHandle,input.requestId,exec,check)}
      catch(error){return {kind:'error',text:JSON.stringify({...result,outcome:'unknown',error:{code:'RESUME_CONTINUATION_UNKNOWN',message:'Task state was restored, but owner continuation needs reconciliation: '+(error instanceof Error?error.message:String(error))}})}}
    }
    return {kind:result.outcome==='rejected'?'error':'success',text:JSON.stringify(result)}
  } catch(error) {return {kind:'error',text:JSON.stringify({error:error instanceof Error?error.message:String(error)})}}
}
