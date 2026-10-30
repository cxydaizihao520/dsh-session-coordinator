#!/usr/bin/env node
/** Re-adjudicate a saved filtered native trace; this never runs a model or grants approval. */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { verifyBusyOwnerProof } from './live/busy-owner-proof.mjs'

const { values } = parseArgs({ options: { report: { type: 'string' }, output: { type: 'string' } } })
if (!values.report || !values.output) throw new Error('Usage: node scripts/review-busy-owner-trace.mjs --report native-report.json --output new-re-adjudication.json')
const source = resolve(values.report), output = resolve(values.output)
if (source === output) throw new Error('The original verdict must remain intact')
const bytes = readFileSync(source), original = JSON.parse(bytes)
const reviewed = structuredClone(original)
reviewed.adjudication = { kind: 're-adjudication', adjudicatedAt: new Date().toISOString(), source, sourceSha256: createHash('sha256').update(bytes).digest('hex'), originalPass: original.pass, originalFailure: original.failure, newModelRun: false,
  reason: 'Native input, exact canonical task result and actual model request are primary evidence. The optional runtime requestInclusion annotation is diagnostic.' }
delete reviewed.failure
try { reviewed.result = verifyBusyOwnerProof(reviewed, reviewed.scope); reviewed.pass = true }
catch (error) { reviewed.pass = false; reviewed.failure = String(error?.stack ?? error) }
writeFileSync(output, JSON.stringify(reviewed, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ pass: reviewed.pass, kind: reviewed.adjudication.kind, newModelRun: false, sourceSha256: reviewed.adjudication.sourceSha256, result: reviewed.result, failure: reviewed.failure, humanInputCounts: reviewed.humanInputCounts, approvals: reviewed.approvals, toolErrors: reviewed.errors.length, fatalErrors: reviewed.fatalErrors.length }, null, 2))
if (!reviewed.pass) process.exitCode = 1
