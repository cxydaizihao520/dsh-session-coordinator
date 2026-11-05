/** Historical fixture only: a persisted outgoing v1 delivery opens the old
 * argument adapter, but grants no runtime reply or communication permission. */
import {appendPluginRecord,Session} from '@deepseek-ai/dsh-session'
import {sourceIdentityMessage} from '../../src/core.ts'
export function legacyHistory(agent){
 const requestId='historical-fixture-'+agent.id,target='historical-fixture-peer',text='Previous completed legacy exchange'
 const message=sourceIdentityMessage(text,{senderSessionId:agent.id,messageId:requestId,rootMessageId:requestId,hopCount:1})
 const session=agent.session instanceof Session?agent.session:Session.create('historical-fixture-log')
 appendPluginRecord(session,'plugin:dsh-session-coordinator/delivery',{version:1,owner:agent.id,target,requestId,stage:'delivered',text,message})
 if(session!==agent.session)agent.session.events.push({...session.snapshotEvents().at(-1),seq:agent.session.events.length+1})
}
