import type { AgentRunResult } from '../agent/Agent.js'
import type { ToolInputSchema } from '../agent/SchemaTool.js'
import { FunctionAction } from '../pipeline/actions/FunctionAction.js'
import type { PipelineExecutionContext, Runnable } from '../pipeline/Runnable.js'
import { DONE_EXIT, type ExitRoute, resolveRoutes } from '../routing/ExitRoutes.js'

/** La clave del `submit_*` donde un paso que elige salidas entrega su resultado. */
export const RESULT_KEY = 'result'

/**
 * Corre un paso FUERA de una pipeline y devuelve su resultado (sin validar): lo que devuelve
 * `run`, o —para uno que elige salidas, un `Agent`— lo que entregó en `submit_<salida>.result`,
 * con TODAS sus salidas llevando a un paso `result` cuyo input es `output`. Sin reportes, `onError`
 * ni `onInterrupt`: lo que corre así no publica nada. Lo usan las capacidades y quien corra un
 * agente como parte de otro (un sub-agente).
 */
export async function runForResult(
  runnable: Runnable,
  ctx: PipelineExecutionContext,
  input: unknown,
  output: ToolInputSchema,
): Promise<unknown> {
  if (runnable.exitRoutes === undefined) return runnable.run(ctx, input)
  const agentId = runnable.id ?? 'paso'
  const base = runnable.exitRoutes
  const result = new FunctionAction({ id: RESULT_KEY, input: output, fn: (_ctx, value) => value })
  const names = Object.keys(base.routes ?? {})
  const routes: Record<string, ExitRoute> = {}
  for (const name of names.length > 0 ? names : [DONE_EXIT]) {
    routes[name] = { to: result, report: null }
  }
  const resolved = resolveRoutes(agentId, base, {
    step: { routes, report: null, onError: null, onInterrupt: null },
  })
  const ran = await runnable.run({ ...ctx, routesFor: () => resolved }, input)
  const outcome = runnable.outcome(ran)
  if (outcome.kind !== 'exit') {
    const summary = (ran as Partial<AgentRunResult>).output?.summary
    throw new Error(`${agentId} no eligió salida${summary ? ` — ${summary}` : ''}`)
  }
  return outcome.payload[RESULT_KEY] ?? {}
}
