import type {ContentBlock, UserMessage} from '@deepseek-ai/dsh-llm'
import {isDeepStrictEqual} from 'node:util'
import {throwIfCollaborationAborted, type LiveAgentLike} from './core.ts'
import {prepareCollaborationMaterials, type CollaborationArtifact, type CollaborationMaterialInput, type MaterialContext} from './collaboration-materials.ts'
import {readSessionModelSelection} from './session-model-selection.ts'

export type SessionContentPart = {type:'text';text:string}
  | {type:'file';path:string}
  | {type:'image';path:string;mediaType:NonNullable<CollaborationMaterialInput['mediaType']>}
  | {type:'reference';sessionId:string;label?:string}
export type SessionContent = string | SessionContentPart[]
export interface PreparedSessionContent {
  content: ContentBlock[]
  artifacts: CollaborationArtifact[]
  referenceContext?: UserMessage
  modelRoute?: {provider:string;model:string}
}
export type SessionContentSnapshot = Omit<PreparedSessionContent,'content'> & {version:1;input:SessionContentPart[]}

export function sessionContentWireText(input: SessionContent): string {
  sessionContentParts(input)
  return typeof input === 'string' ? input : JSON.stringify(input)
}

/** Read-only recovery checks the original ordered request against its captured native blocks. */
export function matchesSessionContent(text: string, content: readonly ContentBlock[], snapshot: SessionContentSnapshot): boolean {
  try {
    if (snapshot.version !== 1 || !Array.isArray(snapshot.input) || JSON.stringify(snapshot.input) !== text || !Array.isArray(snapshot.artifacts)) return false
    const parts = sessionContentParts(snapshot.input)
    let index = 0
    const expected = parts.flatMap<ContentBlock>(part => {
      if (part.type === 'reference') return []
      if (part.type === 'text') return [{type:'text',text:part.text}]
      const artifact = snapshot.artifacts[index++]
      if (!artifact || artifact.block.type !== part.type || typeof artifact.block.attachment?.attachmentId !== 'string') throw new Error('Invalid native material evidence')
      return [artifact.block]
    })
    const refs = parts.filter(part => part.type === 'reference').map(part=>part.sessionId).sort()
    const captured = snapshot.referenceContext?.source as {kind?:string;references?:{sessionId:string}[]} | undefined
    if (refs.length && (captured?.kind !== 'session-reference' || !isDeepStrictEqual([...new Set(captured.references?.map(ref=>ref.sessionId))].sort(),[...new Set(refs)]))) return false
    return index === snapshot.artifacts.length && isDeepStrictEqual(content,expected)
  } catch { return false }
}

export const sessionContentSchema = {
  oneOf: [
    {type:'string'},
    {type:'array',items:{oneOf:[
      {type:'object',additionalProperties:false,properties:{type:{type:'string',enum:['text'],required:true},text:{type:'string',required:true}}},
      {type:'object',additionalProperties:false,properties:{type:{type:'string',enum:['file'],required:true},path:{type:'string',required:true}}},
      {type:'object',additionalProperties:false,properties:{type:{type:'string',enum:['image'],required:true},path:{type:'string',required:true},mediaType:{type:'string',enum:['image/png','image/jpeg','image/webp','image/gif'],required:true}}},
      {type:'object',additionalProperties:false,properties:{type:{type:'string',enum:['reference'],required:true},sessionId:{type:'string',required:true},label:{type:'string'}}},
    ]}},
  ],
  description:'Exact text, or ordered text/file/image parts with absolute source paths. Reference parts capture native read-only chat context separately; they confer no communication permission. Never invent native attachment identities.',
} as const

export function sessionContentParts(input: unknown): SessionContentPart[] {
  if (typeof input === 'string') {
    if (!input.trim()) throw new Error('Session content must not be empty')
    return [{type:'text',text:input}]
  }
  if (!Array.isArray(input) || !input.length) throw new Error('Session content must not be empty')
  for (const part of input) {
    if (!part || typeof part !== 'object') throw new Error('Invalid session content part')
    const keys = part.type === 'text' ? ['type','text'] : part.type === 'file' ? ['type','path'] : part.type === 'image' ? ['type','path','mediaType'] : part.type === 'reference' ? ['type','sessionId','label'] : []
    if (!keys.length || Object.keys(part).some(key => !keys.includes(key))) throw new Error('Unsupported session content type or material fields; use a source path')
    if (part.type === 'text' && typeof part.text !== 'string') throw new Error('Text content requires text')
    if (['file','image'].includes(part.type) && (typeof part.path !== 'string' || !part.path)) throw new Error('Material requires a source path')
    if (part.type === 'image' && !['image/png','image/jpeg','image/webp','image/gif'].includes(part.mediaType)) throw new Error('Image material requires a supported mediaType')
    if (part.type === 'reference' && (typeof part.sessionId !== 'string' || !part.sessionId.trim() || part.label !== undefined && typeof part.label !== 'string')) throw new Error('Reference content requires an exact session identity')
  }
  if (input.every(part => part.type === 'text' && !part.text.trim())) throw new Error('Session content must not be empty')
  return input.map(part=>{
    if (part.type==='text') return {type:'text',text:part.text}
    if (part.type==='file') return {type:'file',path:part.path}
    if (part.type==='image') return {type:'image',path:part.path,mediaType:part.mediaType}
    return {type:'reference',sessionId:part.sessionId,...(part.label===undefined?{}:{label:part.label})}
  }) as SessionContentPart[]
}

/** Preparation runs only after authorization; the caller journals this immutable snapshot before submission. */
export async function prepareSessionContent(source: LiveAgentLike, target: LiveAgentLike, input: SessionContent, signal?: AbortSignal): Promise<PreparedSessionContent> {
  throwIfCollaborationAborted(signal)
  const parts = sessionContentParts(input)
  let modelRoute: PreparedSessionContent['modelRoute']
  if (parts.some(part => part.type === 'image')) {
    const selected = readSessionModelSelection(target)
    const llm = target.ctx.get('llm') as {resolveModelInfo(provider:string,model:string):Promise<{inputModalities?: readonly string[]}|undefined>} | undefined
    if (!selected?.provider || !selected.model || typeof llm?.resolveModelInfo !== 'function') throw new Error('Image capability unavailable: target model selection cannot be verified')
    const info = await llm.resolveModelInfo(selected.provider,selected.model)
    throwIfCollaborationAborted(signal)
    if (!info?.inputModalities?.includes('image')) throw new Error(info?.inputModalities ? 'Target model does not support image input' : 'Image capability unavailable: target input modalities are unknown')
    modelRoute = {provider:selected.provider,model:selected.model}
  }
  const materialParts = parts.filter((part): part is Extract<SessionContentPart,{type:'file'|'image'}> => part.type === 'file' || part.type === 'image')
  const prepared = materialParts.length ? await prepareCollaborationMaterials(source.ctx as MaterialContext,target.ctx as MaterialContext,materialParts.map(part => ({kind:part.type,path:part.path,...(part.type === 'image' ? {mediaType:part.mediaType} : {})})),signal) : {content:[],artifacts:[]}
  let materialIndex = 0
  const content: ContentBlock[] = parts.flatMap(part => part.type === 'reference' ? [] : part.type === 'text' ? [{type:'text',text:part.text}] : [prepared.content[materialIndex++]!])
  const references = parts.filter((part): part is Extract<SessionContentPart,{type:'reference'}> => part.type === 'reference').map(({sessionId,label}) => ({sessionId,...(label === undefined ? {} : {label})}))
  let referenceContext: UserMessage | undefined
  if (references.length) {
    const resolver = target.ctx.get('sessionReferenceResolver') as {prepare(agent:LiveAgentLike,content:ContentBlock[],references:{sessionId:string;label?:string}[],signal?:AbortSignal):Promise<{content:ContentBlock[];additionalContext?:UserMessage}>} | undefined
    if (!resolver) throw new Error('Native session reference capability is unavailable')
    const result = await resolver.prepare(target,content,references,signal)
    if (!result.additionalContext) throw new Error('Native reference preparation returned no captured context')
    referenceContext = result.additionalContext
  }
  throwIfCollaborationAborted(signal)
  const result = {content,artifacts:prepared.artifacts,...(referenceContext ? {referenceContext} : {}),...(modelRoute ? {modelRoute} : {})}
  assertSessionContentModel(target,result)
  return result
}

/** Repeat synchronously after the last await, immediately before the native Inbox write. */
export function assertSessionContentModel(target: LiveAgentLike, prepared: Pick<PreparedSessionContent,'modelRoute'>): void {
  if (!prepared.modelRoute) return
  const current = readSessionModelSelection(target)
  if (current?.provider !== prepared.modelRoute.provider || current.model !== prepared.modelRoute.model) throw new Error('Target model changed during image preparation; inspect and retry without changing the requested model')
}
