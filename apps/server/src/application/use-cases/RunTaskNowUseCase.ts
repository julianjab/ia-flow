import { ISSUE_STATUS_CHANGED, matchRules } from '@ia-flow/rules'
import type { EngineEvent, Rule, TaskRunPreview } from '@ia-flow/shared'
import { type RunTaskNowResult, createEvent } from '@ia-flow/shared'
import type { IEventBus } from '../../domain/ports/IEventBus.js'
import { defaultToIssueItem } from '../../domain/ports/IIssueManager.js'
import type { IssueItem, SourceItem } from '../../domain/ports/IIssueManager.js'

/** Lo mínimo que el caso de uso necesita de la fuente: encontrar UN item. */
export interface RunTaskNowSource {
  getItemById?: (id: string) => Promise<SourceItem | null>
  getItems: (opts?: { refresh?: boolean }) => Promise<SourceItem[]>
  /** El mapeo propio de la fuente, cuando lo tiene. Sin él vale el default,
   *  igual que en `SourceDispatcher`: el evento tiene que llevar el MISMO
   *  item que llevaría un scan, o las condiciones `when` sobre labels/repos
   *  evaluarían contra una forma distinta. */
  toIssueItem?: (item: SourceItem) => IssueItem
}

/** ¿Hay un run vivo sobre esta task? Es lo único que se consulta del registry. */
export type IsTaskRunning = (taskId: string) => boolean

/** Las mismas dos lecturas que hace `RuleEngineHandler` antes de matchear.
 *  Se inyectan (no se importa el repo) para que el preview evalúe contra la
 *  config VIVA sin que este caso de uso sepa de SQLite. */
export interface RunTaskRuleDeps {
  loadRules: (event: EngineEvent) => Promise<readonly Rule[]>
  loadBaseWhen: (event: EngineEvent) => Promise<readonly unknown[]>
}

/** Descartes que NO son accionables: la regla no era para esta tarea (es de
 *  otro proyecto, o escucha otro tipo de evento). Listarlas sería enterrar el
 *  motivo real entre todas las reglas del deploy. */
const NOT_APPLICABLE = new Set(['type', 'scope'])

/** Motivo que la tarjeta muestra tal cual — no un 500. */
export class RunTaskNowError extends Error {}

/** El valor que el evento resolvió, en texto. Una lista (labels, repos) se
 *  muestra separada por comas; un objeto, como JSON — cualquier cosa menos
 *  "[object Object]", que es exactamente lo que no ayuda a diagnosticar. */
function stringifyActual(v: unknown): string {
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.map((x) => String(x)).join(', ')
  if (v === null) return 'null'
  return typeof v === 'object' ? JSON.stringify(v) : String(v)
}

/**
 * "Correr esta tarea ahora", sin tocar el board.
 *
 * El problema que resuelve: la activación de un agente vive en una regla que
 * escucha `issue.created` / `issue.status_changed`, así que una task que se
 * queda quieta en su status NO se vuelve a despachar nunca. Cuando un run se
 * cancela a mitad de camino —o cuando uno edita el issue y quiere reintentar—
 * el único recurso era mover la task a otro status y traerla de vuelta, con
 * dos problemas: escribe en GitHub (queda en el historial del issue, y puede
 * despertar la regla del status intermedio) y el estado intermedio tiene que
 * ser OBSERVADO por un ciclo de scan, así que un ida y vuelta rápido no
 * dispara nada.
 *
 * Lo que hace en cambio: **re-emite el hecho** de que la task está en el
 * status en el que está, con `source: 'manual'`. De ahí para abajo el camino
 * es exactamente el de un scan —mismas reglas, misma exclusividad, mismos
 * gates de capacidad—, que es la razón de reusar el tipo de evento que las
 * reglas ya escuchan en vez de inventar uno nuevo: un `task.run_requested`
 * obligaría a cada deploy a agregarle una regla para que sirviera de algo.
 *
 * `from` y `to` son iguales a propósito: la task no se movió. Lo honesto es
 * decir eso, no simular un movimiento que no pasó.
 */
export class RunTaskNowUseCase {
  constructor(
    private readonly bus: IEventBus,
    private readonly isRunning: IsTaskRunning,
    private readonly rules: RunTaskRuleDeps,
  ) {}

  async execute(
    input: { taskId: string; projectId: string },
    source: RunTaskNowSource,
  ): Promise<RunTaskNowResult> {
    const { taskId, projectId } = input

    // Antes de resolver nada: un segundo dispatch sobre una task que ya tiene
    // un run vivo no se pisa (el lock del orquestador lo frena), pero el
    // usuario merece el motivo acá y no un "no pasó nada" silencioso.
    if (this.isRunning(taskId)) {
      throw new RunTaskNowError('Ya hay un run en curso para esta tarea')
    }

    const item = await this.resolveItem(source, taskId, projectId)
    if (!item.status.trim()) {
      // Sin status no hay contra qué evaluar las reglas: el evento saldría y
      // ninguna matchearía, que desde la UI se ve igual que "no hizo nada".
      throw new RunTaskNowError('La tarea no tiene status — movela a uno antes de correrla')
    }

    return {
      outcome: await this.bus.publish(this.buildEvent(item, projectId)),
      status: item.status,
    }
  }

  /**
   * Qué pasaría si la corrieras ahora — sin publicar nada.
   *
   * Contesta la pregunta que hoy sólo vive en el `daemon.log`: **por qué NO
   * levanta un run**. Un run que nunca arranca no deja fila en
   * `execution_logs` ni comentario en el issue, así que sin esto el operador
   * mira una tarea quieta y no tiene dónde buscar.
   *
   * Corre el MISMO `matchRules` que el motor, contra el MISMO evento que
   * publicaría `execute`, con las reglas y el `baseWhen` vivos. No es una
   * reimplementación del criterio: es el criterio, sin el efecto.
   *
   * Lo que no cubre, a propósito: `whenText` (necesita un modelo — sería una
   * llamada por apertura del detalle) y los gates de capacidad, que se
   * evalúan después y cambian entre que mirás y apretás.
   */
  async preview(
    input: { taskId: string; projectId: string },
    source: RunTaskNowSource,
  ): Promise<TaskRunPreview> {
    const { taskId, projectId } = input
    const item = await this.resolveItem(source, taskId, projectId)

    const blocked = this.isRunning(taskId)
      ? 'Ya hay un run en curso para esta tarea'
      : !item.status.trim()
        ? 'La tarea no tiene status — movela a uno antes de correrla'
        : null
    // Sin status el matcheo no dice nada útil (ninguna regla de status puede
    // matchear), así que se contesta con el motivo y listo.
    if (blocked && !item.status.trim()) {
      return {
        status: item.status,
        blockedReason: blocked,
        matched: [],
        rejected: [],
        notApplicable: 0,
      }
    }

    const event = this.buildEvent(item, projectId)
    const [rules, baseWhen] = await Promise.all([
      this.rules.loadRules(event),
      this.rules.loadBaseWhen(event),
    ])
    const { matched, rejected } = matchRules({ event, rules, baseWhen })
    const byId = new Map(rules.map((r) => [r.id, r]))
    const nameOf = (id: string) => byId.get(id)?.name ?? id

    return {
      status: item.status,
      blockedReason: blocked,
      matched: matched.map((r) => ({ id: r.id, name: r.name ?? r.id })),
      rejected: rejected
        .filter((r) => !NOT_APPLICABLE.has(r.reason))
        .map((r) => ({
          id: r.id,
          name: nameOf(r.id),
          reason: r.reason,
          ...(r.whenTrace
            ? {
                failed: r.whenTrace.groups
                  .flat()
                  .filter((c) => !c.matched)
                  .map((c) => ({
                    field: c.field,
                    op: c.op,
                    ...(c.value !== undefined ? { value: c.value } : {}),
                    // El valor real se serializa acá y no en la web: un
                    // `actual` que es un array de labels tiene que llegar
                    // legible, no como "[object Object]".
                    actual: c.actual === undefined ? null : stringifyActual(c.actual),
                  })),
              }
            : {}),
        })),
      notApplicable: rejected.filter((r) => NOT_APPLICABLE.has(r.reason)).length,
    }
  }

  private async resolveItem(
    source: RunTaskNowSource,
    taskId: string,
    projectId: string,
  ): Promise<IssueItem> {
    const raw = await this.findItem(source, taskId)
    if (!raw) throw new RunTaskNowError('La tarea ya no está en el board del proyecto')
    return {
      ...(source.toIssueItem ? source.toIssueItem(raw) : defaultToIssueItem(raw)),
      projectId,
    }
  }

  private buildEvent(item: IssueItem, projectId: string): EngineEvent {
    return createEvent({
      type: ISSUE_STATUS_CHANGED,
      source: 'manual',
      scope: { projectId, ...(item.repos ? { repos: item.repos } : {}), issueId: item.id },
      // Mismo payload que arma `diffStatus`: el item aplanado (para las
      // condiciones `when` que resuelven al nivel de arriba) MÁS el item
      // entero bajo `item`, que es lo que necesita un dispatch real.
      payload: { ...item, from: item.status, to: item.status, status: item.status, item },
    })
  }

  private async findItem(source: RunTaskNowSource, taskId: string): Promise<SourceItem | null> {
    if (source.getItemById) return source.getItemById(taskId)
    // Fuente sin lookup directo: se paga un listado, igual que el
    // reconciliador. `refresh` porque el punto de esto es reaccionar a lo que
    // el usuario acaba de editar.
    const items = await source.getItems({ refresh: true })
    return items.find((i) => i.id === taskId) ?? null
  }
}
