import { matchRules } from '@ia-flow/rules'
import {
  type EngineEvent,
  RUN_FINISHED,
  type Rule,
  type TaskDispositionEntry,
  createEvent,
} from '@ia-flow/shared'
import type { ExecutionLog } from '@ia-flow/shared'
import { defaultToIssueItem } from '../../domain/ports/IIssueManager.js'
import type { IssueItem, SourceItem } from '../../domain/ports/IIssueManager.js'
import { type DispositionFacts, resolveDisposition } from '../../domain/task-disposition.js'

/**
 * La disposición de cada tarea de un proyecto, en una sola request.
 *
 * Existe porque el cliente **no puede** calcularla: depende de si hay una regla
 * de retry que vaya a tomar este fallo, de los blockers que resuelve la fuente,
 * y del status del issue. Las tres viven acá. Y la primera no se adivina con
 * una heurística: se le pregunta al MISMO matcher que usa el engine, con un
 * `run.finished` sintético, así que "reintenta solo" significa literalmente que
 * el engine lo va a reintentar.
 *
 * El caso que la motivó: un run que falló con regla de retry y uno que falló
 * sin ella dicen los dos `✕ falló` en la app de hoy. Uno se arregla solo en dos
 * minutos; el otro está muerto hasta que alguien lo toque.
 *
 * Recibe todo por puerto (constructor), sin importar un solo adapter: es lo que
 * lo hace testeable con tres objetos literales en vez de una base y un GitHub.
 */

/** Lo mínimo que se necesita de la fuente. Interfaz angosta a propósito: no
 *  todo `ProjectSource`, sólo lo que este caso de uso lee. */
export interface DispositionSource {
  getItems: (opts?: { refresh?: boolean }) => Promise<SourceItem[]>
  getBlockers?: (item: IssueItem) => Promise<Array<{ id: string; ref?: string }>>
  toIssueItem?: (item: SourceItem) => IssueItem
}

export interface DispositionDeps {
  /** El último run + intentos por tarea. Es el agregado que ya existe. */
  latestByTask: (
    projectId: string,
  ) => Array<{ taskId: string; attempts: number; last: ExecutionLog }>
  /** Las reglas visibles para el proyecto — las suyas más las globales. */
  loadRules: (projectId: string) => Promise<readonly Rule[]>
}

/** Concurrencia del fan-out de blockers: el `getBlockers` de GitHub es una
 *  request por issue, y abrirle cuarenta de golpe es cómo se gasta el rate
 *  limit del token compartido. Mismo pool que usa la ruta batch. */
const BLOCKER_POOL = 5

/**
 * ¿Alguna regla configurada va a tomar este fallo?
 *
 * Se sintetiza el `run.finished` que el engine publicaría —mismo tipo, mismo
 * scope, mismo payload— y se lo pasa al matcher real. Una heurística sobre
 * `rule.on.includes('run.finished')` habría dicho que sí para una regla que
 * escucha ese evento pero condiciona sobre otro agente, u otro repo, o sobre
 * `outcome: success`: o sea, habría prometido un retry que no existe, que es
 * peor que no prometerlo.
 *
 * `whenText` NO se evalúa acá: necesita que un modelo lea el evento, y esto
 * corre en el camino de un listado. Una regla con `whenText` cuenta como
 * candidata — si después el gate la descarta, la tarea aparece un ciclo más
 * tarde en `te espera` en vez de no aparecer nunca. Fail-open hacia "avanza
 * solo" sería la dirección equivocada.
 */
function hasRetryRule(rules: readonly Rule[], projectId: string, last: ExecutionLog): boolean {
  const event: EngineEvent = createEvent({
    type: RUN_FINISHED,
    source: 'engine',
    scope: {
      projectId,
      ...(last.taskId ? { issueId: last.taskId } : {}),
    },
    payload: {
      agentId: last.agentId,
      outcome: last.outcome ?? 'error',
      taskId: last.taskId,
    },
  })
  const { matched } = matchRules({ event, rules })
  // Sólo cuenta una regla que vuelva a CORRER algo. Una que comenta en el
  // issue o avisa por Slack no reintenta nada — y contarla dejaría la tarea en
  // "avanza solo" para siempre, esperando a un agente que nadie va a lanzar.
  return matched.some((r) =>
    (r.do ?? []).some((a) => {
      const kind = (a as { action?: string }).action
      // Una acción con nombre (`use`) puede envolver un `agent`: no se puede
      // descartar sin resolverla, y resolverla acá sería otra lectura por fila.
      // Se cuenta como candidata — misma dirección que `whenText`.
      return kind === 'agent' || kind === undefined
    }),
  )
}

export class GetTaskDispositionsUseCase {
  constructor(private readonly deps: DispositionDeps) {}

  async execute(projectId: string, source: DispositionSource): Promise<TaskDispositionEntry[]> {
    const [items, rules] = await Promise.all([source.getItems(), this.deps.loadRules(projectId)])

    const runs = new Map(this.deps.latestByTask(projectId).map((r) => [r.taskId, r]))
    const blockersById = await this.loadBlockers(items, source)

    // El grafo invertido: cuántos ítems dependen de cada uno. Es el primer
    // desempate del bucket 1 —el único que mide CONSECUENCIA en vez de
    // antigüedad— y sale gratis de los blockers que ya se pidieron.
    const unblocks = new Map<string, number>()
    for (const list of blockersById.values()) {
      for (const b of list) unblocks.set(b, (unblocks.get(b) ?? 0) + 1)
    }

    return items.map((item) => {
      const run = runs.get(item.id)
      const last = run?.last ?? null
      const openPr = firstOpenPr(item)
      const facts: DispositionFacts = {
        taskId: item.id,
        last,
        attempts: run?.attempts ?? 0,
        // `undefined` y no `[]` cuando no se pudo saber: la diferencia decide
        // si la tarea se puede afirmar libre.
        blockers: blockersById.get(item.id),
        ...(openPr ? { openPr } : {}),
        hasRetryRule: last?.outcome === 'error' ? hasRetryRule(rules, projectId, last) : false,
        // Sólo si la FUENTE lo dice. Adivinar "cerrado" por el nombre del
        // status acertaría en los repos de quien escribiera la lista de
        // palabras y fallaría callado en el resto.
        isClosed: (item.meta as { state?: string } | undefined)?.state === 'closed',
        unblocks: unblocks.get(item.id) ?? 0,
      }
      const verdict = resolveDisposition(facts)
      return {
        taskId: item.id,
        disposition: verdict.disposition,
        reason: verdict.reason,
        waitingOnYouSince: verdict.waitingOnYouSince,
        unblocks: facts.unblocks,
        blockedBy: blockersById.get(item.id) ?? [],
        verb: verdict.verb,
      }
    })
  }

  /**
   * Los blockers de todos los ítems.
   *
   * Un id ausente del mapa significa **"no se pudo saber"**, y esa distinción
   * viaja hasta el dominio: una fuente sin `getBlockers` no devuelve un mapa
   * vacío de "nada bloqueado", devuelve un mapa vacío de "no consta". Un fallo
   * por ítem no tira el resto — su clave simplemente no aparece.
   */
  private async loadBlockers(
    items: SourceItem[],
    source: DispositionSource,
  ): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>()
    if (!source.getBlockers) return out
    const queue = [...items]
    const worker = async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        // El MISMO mapeo que haría un scan: las condiciones `when` de una
        // regla evalúan contra esta forma, así que derivarla distinto acá daría
        // otra respuesta que el engine.
        const issueItem = source.toIssueItem ? source.toIssueItem(item) : defaultToIssueItem(item)
        try {
          const blockers = await source.getBlockers!(issueItem)
          out.set(
            item.id,
            blockers.map((b) => b.ref ?? b.id),
          )
        } catch {
          // Sin clave: "no sé" ≠ "no hay".
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(BLOCKER_POOL, items.length) }, worker))
    return out
  }
}

/** El PR abierto de un item, con el rollup de CI de su último commit. Un draft
 *  cuenta como abierto: está abierto y es donde está el trabajo. */
function firstOpenPr(
  item: SourceItem,
): { number: number; url: string; ci?: 'success' | 'failure' | 'pending' | null } | undefined {
  const prs = (item.meta?.pullRequests ?? []) as Array<{
    number: number
    url: string
    state?: string
    ci?: 'success' | 'failure' | 'pending' | null
  }>
  const open = prs.find((pr) => pr.state === 'open')
  if (!open) return undefined
  return { number: open.number, url: open.url, ci: open.ci ?? null }
}
