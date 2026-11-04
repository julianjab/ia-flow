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
  // Una task que es sólo un PR (`kind: pr`) no tiene card: no hay marca que poner.
  if (scope.kind === 'pr') return undefined
  const match =
    typeof scope.issue === 'string' ? /^([^/]+)\/([^#]+)#(\d+)$/.exec(scope.issue) : null
  if (typeof scope.projectId !== 'string' || !match) return undefined
  const [, owner, repo, number] = match as unknown as [string, string, string, string]
  return { projectId: scope.projectId, owner, repo, number: Number(number) }
}

/** Cuánto tiene que llevar corriendo una ejecución para que se marque: las cortas (un review de
 *  un hijo de épica, 2–15 s) no se marcan — eran dos mutaciones y dos webhooks por corrida. */
export const WORKING_MARK_DELAY_MS = 10_000

/** Programa `run` en `ms` y devuelve cómo cancelarlo (un puerto: los tests no esperan de verdad). */
export type ScheduleTimer = (run: () => void, ms: number) => () => void

const realTimer: ScheduleTimer = (run, ms) => {
  const timer = setTimeout(run, ms)
  // Una marca pendiente no retiene el proceso (un `--event` que termina antes).
  timer.unref?.()
  return () => clearTimeout(timer)
}

export interface TrackWorkingOptions {
  delayMs?: number
  schedule?: ScheduleTimer
}

/**
 * Pone o saca la marca según el estado de las ejecuciones: una que lleva `delayMs` corriendo la
 * pone; `paused`, `done`, `failed` y `superseded` la sacan. Una que cierra antes no escribe nada.
 * Cada ejecución la pone UNA vez: su registro se vuelve a guardar `running` cada vez que guarda su
 * progreso, y eso no es un cambio. Las escrituras de una misma task van en serie (un "sacar" nunca
 * le gana a un "poner" anterior); un error se loguea y no toca la corrida.
 */
export function trackWorking(
  executions: ExecutionStore,
  projects: ProjectConfig[],
  github: GithubClient,
  boards: Pick<Boards, 'writerFor'>,
  log: (line: string) => void,
  options: TrackWorkingOptions = {},
): () => void {
  const delayMs = options.delayMs ?? WORKING_MARK_DELAY_MS
  const schedule = options.schedule ?? realTimer
  const queues = new Map<string, Promise<void>>()
  /** Las que esperan su `delayMs` para marcarse, con cómo cancelarlo. */
  const pending = new Map<string, () => void>()
  /** Las que ya marcaron la card. */
  const marked = new Set<string>()
  const stop = executions.observe((record: ExecutionRecord) => {
    const task = taskOfKey(record.key)
    const project = task && projects.find((candidate) => candidate.id === task.projectId)
    const marker = project?.workingMarker
    if (!task || !project || !marker) return
    if (record.status === 'running') {
      if (pending.has(record.id) || marked.has(record.id)) return
      pending.set(
        record.id,
        schedule(() => {
          pending.delete(record.id)
          marked.add(record.id)
          write(task, project.id, marker, true, record.status)
        }, delayMs),
      )
      return
    }
    const cancel = pending.get(record.id)
    if (cancel) {
      cancel()
      pending.delete(record.id)
      return
    }
    if (!marked.delete(record.id)) return
    write(task, project.id, marker, false, record.status)
  })

  function write(
    task: TaskOfExecution,
    projectId: string,
    marker: WorkingMarker,
    on: boolean,
    status: ExecutionRecord['status'],
  ): void {
    const input: UpdateIssueInput = on
      ? { fields: { [marker.field]: marker.on } }
      : marker.off
        ? { fields: { [marker.field]: marker.off } }
        : { clearFields: [marker.field] }
    const writer = boards.writerFor(projectId, github)
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
        () => log(`[working] ${ref}: ${on ? marker.on : (marker.off ?? '∅')} (${status})`),
        (error) => log(`[working] ${ref}: no se pudo marcar — ${(error as Error).message}`),
      )
    queues.set(ref, next)
    void next.finally(() => {
      if (queues.get(ref) === next) queues.delete(ref)
    })
  }

  return () => {
    stop()
    for (const cancel of pending.values()) cancel()
    pending.clear()
  }
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
