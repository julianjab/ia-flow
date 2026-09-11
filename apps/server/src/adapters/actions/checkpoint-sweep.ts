import type { RecoverableCheckpoint, RunTaskNowResult } from '@ia-flow/shared'
import type { RunTaskNowSource } from '../../application/use-cases/RunTaskNowUseCase.js'
import { RunTaskNowError } from '../../application/use-cases/RunTaskNowUseCase.js'
import { createLogger } from '../../logger.js'

const log = createLogger('action:checkpoint-sweep')

export interface CheckpointSweepDeps {
  listRecoverableCheckpoints(): Promise<RecoverableCheckpoint[]>
  /** ¿Este proceso ya lo está corriendo? Mismo predicado que usa
   *  `RunTaskNowUseCase` — se consulta ACÁ TAMBIÉN para no pagar
   *  `sourceFor`/`runTaskNow` en el caso común (nada que hacer). */
  isRunning(taskId: string): boolean
  sourceFor(projectId: string): RunTaskNowSource
  runTaskNow(
    input: { taskId: string; projectId: string },
    source: RunTaskNowSource,
    eventSource: string,
  ): Promise<RunTaskNowResult>
}

/**
 * Redespacha en soledad los runs sync (provider `anthropic-api`, sin sesión
 * tmux/iterm/remota) que quedaron con un checkpoint resumible y ninguna
 * regla volviendo a tocarlos — el incidente `d62fddc3` del PRD #232: un
 * crash a mitad de vuelta no mueve el status en GitHub, así que ningún scan
 * ve un diff y la task queda parada hasta un `POST /api/tasks/:id/run`
 * manual.
 *
 * Reusa `deps.runTaskNow` (`RunTaskNowUseCase.execute`, el mismo camino que
 * ese botón manual) en vez de reconstruir el evento a mano: mismas reglas,
 * misma exclusividad, mismos gates de capacidad — incluyendo
 * `TaskDispatcher.hasOpenAsyncSession`, que blinda el otro extremo (una
 * sesión async rehidratada) y corre igual acá abajo.
 *
 * NUNCA toca una fila con sesión (tmux/iterm/remota): `listRecoverableCheckpoints`
 * (composition/actions.ts) ya filtra por eso antes de que esta función vea la
 * lista — ver su test para la cobertura explícita del caso async.
 *
 * Factory con deps inyectadas (mismo patrón que `createRedispatchAborted` al
 * lado): así se testea con fakes, sin tocar SQLite ni el container real.
 */
/** Un solo checkpoint — separado de la vuelta del `for` para que el linter de
 *  complejidad no cuente los dos `try/catch` como una sola función gigante. */
async function redispatchOne(deps: CheckpointSweepDeps, cp: RecoverableCheckpoint): Promise<void> {
  if (!cp.projectId) return

  let source: RunTaskNowSource
  try {
    source = deps.sourceFor(cp.projectId)
  } catch (err) {
    log.warn(
      { err, taskId: cp.taskId, projectId: cp.projectId },
      'No se pudo resolver la fuente del proyecto — checkpoint sync sin redespachar',
    )
    return
  }

  try {
    const result = await deps.runTaskNow(
      { taskId: cp.taskId, projectId: cp.projectId },
      source,
      'checkpoint-sweep',
    )
    log.info(
      { taskId: cp.taskId, agentId: cp.agentId, outcome: result.outcome },
      'Checkpoint sync huérfano redespachado',
    )
  } catch (err) {
    // `RunTaskNowError` (ya corriendo, sin status, issue ya no está en el
    // board) es esperable — el próximo barrido lo vuelve a evaluar sin que
    // nadie tenga que enterarse. Cualquier otra cosa sí es un `warn`.
    if (err instanceof RunTaskNowError) {
      log.debug(
        { taskId: cp.taskId, reason: err.message },
        'Checkpoint sync no redespachado por esta vuelta',
      )
      return
    }
    log.warn({ err, taskId: cp.taskId }, 'Fallo el redespacho de un checkpoint sync huérfano')
  }
}

export function createCheckpointSweep(deps: CheckpointSweepDeps) {
  return async function redispatchRecoverableCheckpoints(): Promise<void> {
    const checkpoints = await deps.listRecoverableCheckpoints()
    for (const cp of checkpoints) {
      if (!cp.resumable || !cp.projectId) continue
      if (deps.isRunning(cp.taskId)) continue
      await redispatchOne(deps, cp)
    }
  }
}
