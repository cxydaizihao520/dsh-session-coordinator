import assert from 'node:assert/strict'
import {fixture} from './session-tools.mjs'
import {installCollaboration} from '../../src/collaboration-tools.ts'

export async function tasksFixture(members=['A','B'],controls) {
  const h=fixture(),records=new Map()
  const store={get:id=>structuredClone(records.get(id)),list:()=>[...records.values()].map(r=>structuredClone(r)),async create(r){if(records.has(r.id))throw Error('exists');records.set(r.id,structuredClone(r));return structuredClone(r)},async update(id,revision,mutate){const prior=records.get(id);assert.equal(prior.revision,revision);const next=mutate(structuredClone(prior));records.set(id,structuredClone(next));return structuredClone(next)},async close(){}}
  h.env.collaboration=installCollaboration(h.env,{store});await h.env.collaboration
  for(const id of members)if(!h.agents.has(id))h.make(id)
  h.human('A')
  const sent=await h.run('send',{targets:['B'],content:'Two independently controlled calculations',authorizationRequest:{extent:'work',participants:members,purpose:'product and shipping calculations',...(controls?{controls}:{})}})
  return {...h,records,communicationHandle:sent.communicationHandle,controlHandle:sent.controlHandle}
}
