// Keep fixture calls on the SDK's own validation, scope and execution path.
export async function nativeToolDispatch(ctx, runtime) {
  if (typeof runtime.setExecutor !== 'function') {
    return {
      dispatch: input => runtime.execute(input),
      sdkSchemas: agent => runtime.sdkSchemas(agent),
    }
  }

  const { projectToolSchema } = await import('@deepseek-ai/dsh-tools')
  const { ToolExecutionPipeline, executeToolBatch } = await import('@deepseek-ai/dsh-tools/pipeline')
  const pipeline = new ToolExecutionPipeline(ctx)
  const executor = {
    describe: tools => ({ schemas: tools.map(tool => projectToolSchema(tool, false)) }),
    execute: input => executeToolBatch(input, pipeline, () => 1),
  }
  runtime.setExecutor(executor)
  return {
    sdkSchemas: agent => executor.describe(runtime.definitions(agent)).schemas,
    async dispatch({ agent, signal, callId, name, arguments: args }) {
      const batch = await runtime.execute({
        agent, signal, calls: [{ type: 'tool-call', id: callId, name, arguments: JSON.stringify(args) }],
      })
      return batch.results[0].result
    },
  }
}
