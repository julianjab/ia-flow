import { ISSUE_STATUS_CHANGED } from '@ia-flow/rules'
import { createEvent } from '@ia-flow/shared'
import type { EventOutcome, IEventBus } from '../../domain/ports/IEventBus.js'
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

/** Motivo que la tarjeta muestra tal cual — no un 500. */
export class RunTaskNowError extends Error {}

export interface RunTaskNowResult {
  outcome: EventOutcome
  /** El status contra el que se evaluaron las reglas. */
  status: string
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

    const raw = await this.findItem(source, taskId)
    if (!raw) throw new RunTaskNowError('La tarea ya no está en el board del proyecto')
    const item: IssueItem = {
      ...(source.toIssueItem ? source.toIssueItem(raw) : defaultToIssueItem(raw)),
      projectId,
    }
    if (!item.status.trim()) {
      // Sin status no hay contra qué evaluar las reglas: el evento saldría y
      // ninguna matchearía, que desde la UI se ve igual que "no hizo nada".
      throw new RunTaskNowError('La tarea no tiene status — movela a uno antes de correrla')
    }

    const event = createEvent({
      type: ISSUE_STATUS_CHANGED,
      source: 'manual',
      scope: { projectId, ...(item.repos ? { repos: item.repos } : {}), issueId: item.id },
      // Mismo payload que arma `diffStatus`: el item aplanado (para las
      // condiciones `when` que resuelven al nivel de arriba) MÁS el item
      // entero bajo `item`, que es lo que necesita un dispatch real.
      payload: { ...item, from: item.status, to: item.status, status: item.status, item },
    })

    return { outcome: await this.bus.publish(event), status: item.status }
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
