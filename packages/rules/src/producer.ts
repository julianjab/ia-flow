// Qué es un productor de eventos, y qué hay que escribir para agregar uno.
//
// Los productores vienen en DOS formas, y no es un accidente: es la diferencia
// entre quién tiene la iniciativa.
//
//   INGRESO   — algo de afuera llega y hay que traducirlo (un webhook de
//               GitHub, uno de Slack, un POST a la API). El ciclo de vida es
//               el del servidor HTTP; lo único propio es la TRADUCCIÓN.
//               Se escribe un `EventNormalizer` y se lo llama desde la ruta.
//
//   INICIATIVA — nadie llama: hay que ir a mirar (un tick de cron, un barrido
//               de vencimientos, un watcher del filesystem). Tiene ciclo de
//               vida propio. Se escribe un `EventProducer`.
//
// Reglas que valen para los dos, y que son las que se olvidan:
//
//   1. **Poné un `id` estable cuando la fuente tenga uno.** El
//      `X-GitHub-Delivery`, el `event_id` de Slack, el minuto exacto de un
//      tick. El bus deduplica por ahí, y sin eso un reintento de la fuente
//      dispara las reglas dos veces. Si el hecho NO tiene identidad natural
//      (dos scans del mismo issue son dos hechos distintos), dejá que
//      `createEvent` sintetice uno.
//   2. **No inventes scope.** Si no sabés de qué proyecto es, mandá `{}`: el
//      matcher es fail-closed y sólo lo verán las reglas globales, que es lo
//      correcto. Un scope adivinado dispara reglas de un proyecto ajeno.
//   3. **Devolvé `null` en vez de un evento vacío.** Un delivery que no
//      interesa (una acción que no miramos, un mensaje de bot) no es un
//      evento — y publicar uno "por las dudas" hace que cada regla tenga que
//      filtrarlo.
//   4. **Un fallo del productor no puede voltear nada.** Loguealo y seguí: el
//      próximo tick o el próximo delivery vuelve a intentar.
import type { EngineEvent } from '@ia-flow/shared'
import type { EventOutcome } from './bus.js'

/** Publicar al bus. Es lo único que un productor necesita saber hacer. */
export type Publish = (event: EngineEvent) => Promise<EventOutcome>

export interface Disposable {
  dispose(): void
}

/**
 * Traduce lo que llegó de afuera a un evento del engine.
 *
 * Puro a propósito: sin I/O, sin acceso al bus. Eso es lo que permite testear
 * la forma de un evento sin levantar nada, y lo que mantiene la resolución de
 * scope (que sí necesita la DB) en el borde, donde se puede inyectar.
 *
 * `null` = este input no produce evento.
 */
export type EventNormalizer<Raw> = (raw: Raw) => EngineEvent | null

/**
 * Un productor con ciclo de vida propio.
 *
 * `start` recibe cómo publicar y devuelve cómo pararse. El productor NO
 * importa el bus: así se lo puede correr en un test con un `publish` falso, y
 * el daemon decide cuáles arranca.
 */
export interface EventProducer {
  /** Para logs y para el diagnóstico de "¿qué está corriendo?". */
  readonly id: string
  start(publish: Publish): Disposable
}

export interface IntervalProducerOptions {
  id: string
  intervalMs: number
  /**
   * Qué eventos hay para publicar ahora. Devolver `[]` es lo normal — la
   * mayoría de los ticks no encuentra nada.
   *
   * Async porque casi todos consultan algo (reglas con schedule, esperas
   * vencidas, el board).
   */
  produce: (at: Date) => Promise<EngineEvent[]>
  onError?: (err: unknown) => void
}

/**
 * El productor por iniciativa más común: mirar cada N milisegundos.
 *
 * Cubre el cron, el barrido de esperas vencidas y cualquier sondeo periódico.
 * Existe para que ninguno de ellos vuelva a escribir su propio `setInterval`
 * con su propio try/catch — que es exactamente como estaban antes de esto, y
 * la razón por la que agregar el cuarto significaba leer los otros tres.
 *
 * El `catch` es del helper y no de cada `produce`: un tick que tira no puede
 * matar el intervalo, o el productor deja de producir para siempre sin que
 * nada lo diga.
 */
export function createIntervalProducer(opts: IntervalProducerOptions): EventProducer {
  return {
    id: opts.id,
    start(publish) {
      const tick = async () => {
        try {
          for (const event of await opts.produce(new Date())) {
            await publish(event)
          }
        } catch (err) {
          opts.onError?.(err)
        }
      }
      const timer = setInterval(() => void tick(), opts.intervalMs)
      return { dispose: () => clearInterval(timer) }
    },
  }
}
