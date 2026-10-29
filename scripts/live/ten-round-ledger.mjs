import assert from 'node:assert/strict'

export const tenRoundPrompt = '这是用户授权的隔离10轮会话往返验收，执行库存逐期对账。请用 session_coordinator_collaboration_*，start 创建1个新的独立主会话“十轮库存·核算”，继承当前目录和模型；预算maxOperations=40,maxNoProgress=12,maxElapsedMs=600000，不设置token cap。只建立1项task，所有10轮复用同一taskId/taskRevision。初始库存100，第n轮入库3*n、出库n+1，结存=期初+入库-出库；n从1到10。你作为总控，每次只派当前一轮，给出轮号、上一轮真实结存作为期初、当轮出入库量；收到对方真实collaboration_result并核对后才发下一轮的新task消息，每轮使用新的operationId。独立会话每轮用result提交，text必须含一行ROUND=n;OPEN=期初;IN=入库;OUT=出库;CLOSE=结存（等号右侧为实际整数，无空格），evidence附计算依据。不要并行派十轮、另建task、预先编造回信或只写十行答案。总控完成10轮后，用这10个真实resultIds先finish task，再finish scope，确认completed，最后汇报10行实际收发库存表。不得使用旧send/create或临时子代理，不读写文件、不调用无关工具；中间不请求人类逐轮开闸。遇真实拒绝、预算或故障如实停止，不能绕过。'

export function verifyTenRoundLedger(scope) {
  assert.equal(scope.state, 'completed')
  const tasks = Object.values(scope.tasks)
  assert.equal(tasks.length, 1, 'ten exchanges must reuse the same original task')
  assert.equal(tasks[0].state, 'completed')
  assert.equal(scope.members.length, 2)
  assert.equal(Object.keys(scope.results).length, 10)
  const task = tasks[0]
  const operations = Object.values(scope.operations).filter(op => op.intent === 'task').sort((a, b) => a.createdAt - b.createdAt)
  assert.equal(operations.length, 10, 'ten actual dispatches, not one dispatch with ten lines')
  assert.equal(Object.values(scope.operations).filter(op => op.intent === 'result').length, 10)
  const rows = []
  let previous = -1
  for (const [index, op] of operations.entries()) {
    const n = index + 1
    assert.equal(op.taskId, task.id)
    assert.equal(op.taskRevision, task.revision)
    assert.ok(op.createdAt >= previous, 'each dispatch must follow the previous real result')
    assert.equal(op.requestInclusion?.evidence, 'native-llm-stream')
    const result = Object.values(scope.results).find(item => item.operationId === op.id)
    assert.ok(result && !result.stale && result.taskId === task.id && result.taskRevision === task.revision && result.sender === op.target)
    assert.ok(result.createdAt >= op.createdAt)
    const expected = `ROUND=${n};OPEN=${100 + (n - 1) ** 2};IN=${3 * n};OUT=${n + 1};CLOSE=${100 + n ** 2}`
    assert.ok(result.text.split(/\r?\n/).some(line => line.trim() === expected), 'actual peer result must contain the correct ledger row: ' + expected)
    assert.ok(task.acceptedResultIds?.includes(result.id), 'owner must accept every actual result')
    assert.equal(op.error, undefined)
    rows.push({ round: n, operationId: op.id, resultId: result.id, sentAt: op.createdAt, resultAt: result.createdAt, ledger: expected })
    previous = result.createdAt
  }
  assert.equal(task.attention, undefined)
  return rows
}
