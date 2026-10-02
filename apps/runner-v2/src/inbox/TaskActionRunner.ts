/**
 * Ejecuta las `taskActions` de un proyecto (ver `TaskActionDef`): decide cuáles se ofrecen para una
 * tarea y corre la cadena de actions de la que se pide. Sin I/O propio: las actions las arma quien
 * lo llama (`instantiate`), con la identidad de la persona.
 */
import {
  type Action,
  ActionStep,
  Condition,
  createEvent,
  EventBus,
  type PipelineExecutionContext,
} from '@ia-flow/agent-engine'
import type { ExecutionSummary } from '@ia-flow/shared'
import type { cardItem } from './BoardReader.js'
import type { TaskActionDef, TaskActionDefs } from './TaskActionDef.js'
import { TaskActionError } from './TaskActionError.js'

/** Lo que una guarda (`available`, `when` de un paso) y un `with` pueden leer de la tarea. */
export interface TaskFacts {
  /** La card, como la ve el `when` de un proyecto (`item.status`, `item.labels`…). */
  item: ReturnType<typeof cardItem>
  /** Su última ejecución cerrada: `exit`, `status`, `failure_by`, `agent`. */
  run: Record<string, string>
}

/** `run.*` a partir de la última ejecución cerrada de la task; sin ella, vacío. */
export function runFacts(lastClosed: ExecutionSummary | undefined): Record<string, string> {
  if (!lastClosed) return {}
  const entries: Array<[string, string | undefined]> = [
    ['exit', lastClosed.exit],
    ['status', lastClosed.status],
    ['failure_by', lastClosed.failure?.by],
    ['agent', lastClosed.agent_id],
  ]
  return Object.fromEntries(entries.filter((entry): entry is [string, string] => !!entry[1]))
}

const holds = (rows: TaskActionDef['available'] | undefined, facts: unknown) =>
  Condition.evaluateAll(
    (rows ?? []).map((row) => new Condition(row)),
    facts,
  )

/** Los ids de las `taskActions` que se ofrecen para estos hechos, en el orden en que se declaran. */
export function availableTaskActions(defs: TaskActionDefs, facts: TaskFacts): string[] {
  return Object.entries(defs)
    .filter(([, def]) => holds(def.available, facts))
    .map(([id]) => id)
}

/** Que cada paso de cada acción nombre una action registrada: un typo rompe el arranque y no la
 *  primera vez que alguien aprieta el botón. `registered` es lo que ve cada scope (`runner` y el
 *  proyecto). */
export function assertTaskActionsRegistered(
  projects: Array<{ id: string; taskActions: TaskActionDefs }>,
  registered: Record<string, string[]>,
  globalSource: string,
): void {
  for (const project of projects) {
    const known = new Set([...(registered[globalSource] ?? []), ...(registered[project.id] ?? [])])
    for (const [id, def] of Object.entries(project.taskActions)) {
      for (const step of def.steps) {
        if (!known.has(step.action)) {
          throw new Error(
            `proyecto ${project.id}: taskActions.${id} usa la action "${step.action}", que no está registrada`,
          )
        }
      }
    }
  }
}

const NEEDS_RESUME_STAGE = 'task.resume_stage'

export interface RunTaskActionArgs {
  def: TaskActionDef
  id: string
  /** `owner/repo#n` ya partido: el issue sobre el que actúan los pasos. */
  issue: { owner: string; repo: string; number: number }
  facts: TaskFacts
  input: { comment?: string }
  actor: string
  /** La columna a la que vuelve una tarea trabada (`task.resume_stage`), si se sabe. */
  resumeStage?: string
  /** Arma la action del catálogo con la identidad de quien actúa. */
  instantiate(name: string): Action
}

/**
 * Corre los pasos en orden, cada uno con su `with` resuelto contra `input.*`, `task.*`, `item.*`,
 * `run.*` y `actor`. Se corta en el primer error y dice qué pasos ya corrieron: no hay rollback —
 * un comentario publicado no se despublica—, así que el orden de los pasos es parte del diseño de
 * la acción. Devuelve lo que contó cada paso.
 */
export async function runTaskAction(args: RunTaskActionArgs): Promise<string[]> {
  const { def, id, facts } = args
  // Mover una tarea a "la etapa que no sé" no es un paso que se pueda saltar: se rechaza antes de
  // tocar nada.
  if (args.resumeStage === undefined && JSON.stringify(def.steps).includes(NEEDS_RESUME_STAGE)) {
    throw new TaskActionError(
      `no sé a qué etapa devolver ${args.issue.owner}/${args.issue.repo}#${args.issue.number}: no encuentro la ejecución que falló`,
      409,
    )
  }
  const payload = {
    ...args.issue,
    input: args.input,
    task: { resume_stage: args.resumeStage },
    actor: args.actor,
    ...facts,
  }
  const ctx: PipelineExecutionContext = {
    event: createEvent(`human.${id}`, payload),
    steps: {},
    bus: new EventBus(),
    pipelineId: `task-action:${id}`,
  }
  const done: string[] = []
  for (const [index, step] of def.steps.entries()) {
    if (step.when && !holds(step.when, payload)) continue
    try {
      const result = await new ActionStep({
        action: args.instantiate(step.action),
        with: step.with,
      }).run(ctx)
      done.push(typeof result === 'string' ? result : step.action)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      const ran = done.length > 0 ? `; ya corrieron: ${done.length} paso(s)` : ''
      throw new TaskActionError(
        `${id}: falló el paso ${index + 1} (${step.action}): ${reason}${ran}`,
        502,
      )
    }
  }
  return done
}
