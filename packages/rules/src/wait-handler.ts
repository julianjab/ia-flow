// El suscriptor que despierta esperas.
//
// Vive al lado del motor de reglas y no adentro porque son dos preguntas
// distintas sobre el mismo evento: "¿qué reglas aplican?" (config del
// operador, permanente) y "¿alguien estaba esperando esto?" (estado de
// runtime, de un solo uso). Meterlas en un handler las acoplaría, y el orden
// entre ellas dejaría de ser visible.
import type { EngineEvent, Wait } from '@ia-flow/shared'
import type { EventHandler, EventOutcome } from './bus.js'
import { aggregateOutcomes } from './bus.js'
import { matchWaits } from './waits.js'

export interface WaitHandlerDeps {
  /** Las esperas vivas del proyecto del evento. Un evento sin `projectId` no
   *  puede despertar nada: una espera siempre tiene proyecto. */
  loadWaits(projectId: string): Promise<readonly Wait[]>
  /**
   * Borra la espera. Devuelve `false` si ya no estaba — y ahí el reanudado NO
   * corre: dos entregas del mismo evento (GitHub reintenta) despertarían el
   * run dos veces. El borrado ES la clave de idempotencia.
   */
  consume(waitId: string): Promise<boolean>
  /** Reanuda el run. `wait.checkpoint` distingue una espera de una pausa; el
   *  consumidor decide qué hacer con cada una. */
  resume(wait: Wait, event: EngineEvent): Promise<EventOutcome>
  onError?: (err: unknown, info: { waitId: string; event: EngineEvent }) => void
}

/**
 * Despierta las esperas que este evento matchea.
 *
 * Vive al lado del motor de reglas y no adentro porque son dos preguntas
 * distintas sobre el mismo evento: "¿qué reglas aplican?" (config del
 * operador, permanente) y "¿alguien estaba esperando esto?" (estado de
 * runtime, de un solo uso).
 */
export class WaitHandler implements EventHandler {
  readonly id = 'waits'

  constructor(private readonly deps: WaitHandlerDeps) {}

  /** Acepta todo salvo lo que no puede despertar nada: sin proyecto no hay
   *  esperas que mirar, y consultarlas igual sería una query por cada evento
   *  global. */
  handles(event: EngineEvent): boolean {
    return Boolean(event.scope.projectId)
  }

  async handle(event: EngineEvent): Promise<EventOutcome> {
    const projectId = event.scope.projectId
    if (!projectId) return 'skipped'

    const waits = await this.deps.loadWaits(projectId)
    const matched = matchWaits(waits, event)
    if (!matched.length) return 'skipped'

    const outcomes: EventOutcome[] = []
    for (const wait of matched) {
      try {
        // Consumir ANTES de reanudar, no después: si el reanudado tarda, un
        // segundo delivery del mismo evento encontraría la espera todavía viva
        // y arrancaría un run duplicado. El costo del orden inverso es que un
        // reanudado que falla pierde la espera — preferible a dos runs sobre
        // la misma task.
        if (!(await this.deps.consume(wait.id))) continue
        outcomes.push(await this.deps.resume(wait, event))
      } catch (err) {
        this.deps.onError?.(err, { waitId: wait.id, event })
        outcomes.push('skipped')
      }
    }
    return aggregateOutcomes(outcomes)
  }
}
