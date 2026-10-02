/**
 * La marca "en curso" de una task en su board — el `Working = Yes` de ia-flow: puesta mientras una
 * ejecución de la task corre, borrada cuando se pausa (esperar el CI) o cierra. Se cuelga del
 * ciclo de vida de la ejecución (`ExecutionStore.observe`), no de cada agente: así también se
 * borra si el agente falla, lo interrumpen o el runner se reinicia.
 */
import {
  createEvent,
  EventBus,
  type ExecutionRecord,
  type ExecutionStore,
  type PipelineExecutionContext,
} from '@ia-flow/agent-engine'
import type { GithubClient } from '@ia-flow/github-api'
import { UpdateIssueAction, type UpdateIssueInput } from '@ia-flow/github-tools'
import { z } from 'zod'
import type { Boards } from '../board/Boards.js'
import type { ProjectConfig } from '../config/RunnerConfig.js'

/** El campo single-select de la marca y sus valores. Sin `off`, apagarla es vaciar el campo. */
export const WorkingMarkerSchema = z.strictObject({
  field: z.string().min(1),
  on: z.string().min(1),
  off: z.string().min(1).optional(),
})
export type WorkingMarker = z.infer<typeof WorkingMarkerSchema>

/** Lo de ia-flow: un single-select `Working` con la opción `Yes`; libre = vacío. */
export const DEFAULT_WORKING_MARKER: WorkingMarker = { field: 'Working', on: 'Yes' }

interface TaskOfExecution {
  projectId: string
  owner: string
  repo: string
  number: number
}

/** La task de una ejecución, desde su clave (el scope que publica `resolve_task`). */
export function taskOfKey(key: string): TaskOfExecution | undefined {
  let entries: Array<[string, unknown]>
  try {
    entries = JSON.parse(key) as Array<[string, unknown]>
  } catch {
    return undefined
  }
  const scope = Object.fromEntries(entries)
  const match =
    typeof scope.issue === 'string' ? /^([^/]+)\/([^#]+)#(\d+)$/.exec(scope.issue) : null
  if (typeof scope.projectId !== 'string' || !match) return undefined
  const [, owner, repo, number] = match as unknown as [string, string, string, string]
  return { projectId: scope.projectId, owner, repo, number: Number(number) }
}

/**
 * Pone o saca la marca en cada cambio de estado de las ejecuciones: `running` la pone; `paused`,
 * `done`, `failed` y `superseded` la sacan. Las escrituras de una misma task van en serie (un
 * "sacar" nunca le gana a un "poner" anterior); un error se loguea y no toca la corrida.
 */
export function trackWorking(
  executions: ExecutionStore,
  projects: ProjectConfig[],
  github: GithubClient,
  boards: Pick<Boards, 'writerFor'>,
  log: (line: string) => void,
): () => void {
  const queues = new Map<string, Promise<void>>()
  return executions.observe((record: ExecutionRecord) => {
    const task = taskOfKey(record.key)
    const project = task && projects.find((candidate) => candidate.id === task.projectId)
    const marker = project?.workingMarker
    if (!task || !project || !marker) return
    const on = record.status === 'running'
    const input: UpdateIssueInput = on
      ? { fields: { [marker.field]: marker.on } }
      : marker.off
        ? { fields: { [marker.field]: marker.off } }
        : { clearFields: [marker.field] }
    const writer = boards.writerFor(project.id, github)
    const action = new UpdateIssueAction({
      client: github,
      ...(writer ? { board: writer } : {}),
      issue: () => task,
      id: 'working_marker',
    })
    const ref = `${task.owner}/${task.repo}#${task.number}`
    const previous = queues.get(ref) ?? Promise.resolve()
    const next = previous
      .then(() => action.run(markerContext(), input))
      .then(
        () => log(`[working] ${ref}: ${on ? marker.on : (marker.off ?? '∅')} (${record.status})`),
        (error) => log(`[working] ${ref}: no se pudo marcar — ${(error as Error).message}`),
      )
    queues.set(ref, next)
    void next.finally(() => {
      if (queues.get(ref) === next) queues.delete(ref)
    })
  })
}

/** La acción saca el issue de `issue`, no del evento: el contexto sólo cumple la forma. */
function markerContext(): PipelineExecutionContext {
  return {
    event: createEvent('execution.working', {}),
    steps: {},
    bus: new EventBus(),
    pipelineId: 'working',
  }
}
