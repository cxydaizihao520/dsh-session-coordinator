#!/usr/bin/env node
/** Verify actual desktop tool choices, with both old and new tools still offered. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { parseArgs } from 'node:util'
import { collectDesktopEvidence, decodeFrames } from './desktop-controls-evidence.mjs'

const { values: v } = parseArgs({ options: Object.fromEntries(['base', 'owner', 'members', 'state', 'output'].map(key => [key, { type: 'string' }])) })
assert.ok(v.base && v.owner && ['1', '2'].includes(v.members) && ['cancelled', 'completed'].includes(v.state), '--base --owner --members 1|2 --state cancelled|completed')
const report = collectDesktopEvidence(v.base, v.owner, Number(v.members))
const owner = decodeFrames(fs.readFileSync(report.sourceFiles.find(file => file.sessionId === v.owner).path))
const calls = owner.filter(event => event.type === 'tool/call')
const legacy = ['session_coordinator_cancel', 'session_coordinator_resume']
const choices = calls.filter(event => legacy.includes(event.data.name))
assert.equal(choices.length, 0, 'collaboration control/recovery must not first call legacy cancel/resume and correct itself after rejection: ' + choices.map(event => event.data.name).join(', '))
const headers = owner.filter(event => event.type === 'request/header')
assert.ok(headers.length)
for (const header of headers) {
  const offered = new Set(header.data.header.tools.map(tool => tool.name))
  for (const name of [...legacy, 'session_coordinator_collaboration_control', 'session_coordinator_collaboration_send']) assert.ok(offered.has(name), 'do not claim better selection by hiding ' + name)
}
assert.equal(report.scopeSnapshots.at(-1).state, v.state)
assert.ok(Object.values(report.counts).every(count => count.turnStarts === count.turnEnds))
assert.ok(report.errors.every(error => error.content === 'Error: tool call aborted' || error.content.startsWith('The tool call was interrupted after it was recorded,')), 'no planning/authorization/parameter error may be ignored')
const proof = { passed: true, layer: 'actual-desktop-first-tool-choice', owner: v.owner, scopeId: report.scopeId, finalState: v.state, sourceFiles: report.sourceFiles,
  controls: calls.filter(event => event.data.name === 'session_coordinator_collaboration_control').map(event => ({ time: event.time, ...JSON.parse(event.data.arguments) })),
  legacyCalls: [], bothToolFamiliesOfferedInHeaders: headers.length, counts: report.counts, expectedInterruptionErrors: report.errors,
  boundary: 'This checks real model-issued calls and native completion; it does not prove all future model choices. Business effects and terminal silence require their separate evidence.' }
if (v.output) fs.writeFileSync(v.output, JSON.stringify(proof, null, 2) + '\n')
console.log(JSON.stringify({ passed: true, owner: proof.owner, finalState: proof.finalState, legacyCalls: 0, headers: headers.length }))
