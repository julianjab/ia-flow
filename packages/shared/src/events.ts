// EngineEvent — la unidad de "algo pasó" que atraviesa el engine.
//
// Un evento es un HECHO INMUTABLE CON IDENTIDAD, y esa es toda la diferencia
// con el modelo que reemplaza. Hasta ahora el disparador era implícito: el
// scan preguntaba "¿el issue está en Ready?" y volvía a preguntarlo para
// siempre, así que un agente sin criterios que dejaran de cumplirse se
// re-ejecutaba sin freno (de ahí el gate `isScoped` de agent-selection.ts). Un
// evento se consume una vez, y ese problema desaparece por construcción.
//
// Vive en `shared` porque cruza la frontera server↔web: la UI lista eventos y
// sus reglas. Es contrato puro — sin lógica, sin I/O.
import { z } from 'zod'

/**
 * De qué habla el evento. Es lo que hace que un evento sea **ruteable**: la
 * ubicación declarada de una regla (projectId + repoName) se compara contra
 * esto (ver `matchScope` en @ia-flow/rules).
 *
 * Todos los campos son opcionales porque un productor puede no saberlos. Un
 * mensaje suelto de Slack no trae proyecto — y como el matching es fail-closed,
 * un evento sin `projectId` sólo lo ven las reglas sin `projectId`. Eso no es
 * una carencia: un evento sin scope está *sin rutear todavía*, y asignarle
 * scope es un paso explícito del pipeline (un agente de triage que emite un
 * evento ya scopeado), no algo que el matcher adivine.
 */
export const EventScopeSchema = z.object({
  projectId: z.string().optional(),
  /** Repos que el evento toca. Lista y no string porque el sujeto puede tocar
   *  varios: una task sin refinar trae `[]`, una épica trae varios. El
   *  matching es de pertenencia. */
  repos: z.array(z.string()).optional(),
  issueId: z.string().optional(),
  prNumber: z.number().int().optional(),
})
export type EventScope = z.infer<typeof EventScopeSchema>

export const EngineEventSchema = z.object({
  /** Clave de dedupe. Un delivery de GitHub trae la suya; el resto se
   *  sintetiza. Es lo que garantiza que un evento se procese una sola vez. */
  id: z.string().min(1),
  /** `dominio.hecho` — ver las constantes de abajo. Es un string y no un enum
   *  a propósito: un productor nuevo no debería tener que tocar este schema
   *  para publicar un tipo que sólo él y sus reglas entienden. */
  type: z.string().min(1),
  occurredAt: z.string(),
  /** Quién lo produjo: 'github' | 'slack' | 'engine' | 'cron' | 'manual'. */
  source: z.string().min(1),
  scope: EventScopeSchema,
  /** Normalizado por tipo. Es contra esto que evalúan las condiciones `when`
   *  de una regla, incluyendo caminos anidados como `pr.head.ref`. */
  payload: z.record(z.string(), z.unknown()),
  /** Qué evento causó a éste. Junto con `depth`, es el freno de los ciclos:
   *  sin esto, la regla A emite X, B reacciona y emite Y, C reacciona y emite
   *  X — un loop infinito, y esta vez sin `isScoped` para salvarlo. */
  causationId: z.string().optional(),
  depth: z.number().int().nonnegative().default(0),
})
export type EngineEvent = z.infer<typeof EngineEventSchema>

/** Tope de la cadena de causación. Por encima, el evento se descarta con un
 *  log ruidoso en vez de seguir propagándose. Diez es holgado para cualquier
 *  pipeline legítimo y corto para cualquier ciclo. */
export const MAX_EVENT_DEPTH = 10

// ── Vocabulario de tipos ─────────────────────────────────────────────────────
// Constantes y no un enum de Zod: `EngineEvent.type` acepta cualquier string
// para que un productor nuevo no tenga que modificar el contrato compartido.
// Éstas son las que el engine produce y consume hoy.

/** Un run de agente terminó. Lo publica la acción `agent` cuando la regla lo
 *  pide con `emitOn: 'exit'` — es lo que permite encadenar sobre el resultado
 *  de un agente sin que el engine cablee la cadena. */
export const RUN_FINISHED = 'run.finished'

export type EngineEventInput = Omit<EngineEvent, 'id' | 'occurredAt' | 'depth'> & {
  id?: string
  occurredAt?: string
  depth?: number
}

/**
 * Completa los campos que casi ningún productor quiere escribir a mano.
 *
 * El `id` sintetizado incluye un sufijo aleatorio porque **no** es una clave de
 * idempotencia semántica: dos scans del mismo issue son dos hechos distintos y
 * los dos tienen que despachar. Los productores que SÍ tienen identidad natural
 * (el `X-GitHub-Delivery` de un webhook) pasan la suya y ahí el dedupe muerde.
 */
export function createEvent(input: EngineEventInput): EngineEvent {
  return {
    ...input,
    id: input.id ?? `${input.type}:${crypto.randomUUID()}`,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    depth: input.depth ?? 0,
  }
}

/**
 * Evento derivado: hereda la cadena de causación del que lo provocó.
 *
 * Es el único camino por el que debería nacer un evento producido por una
 * acción — usar `createEvent` ahí reiniciaría `depth` en 0 y el tope dejaría
 * de frenar nada.
 */
export function deriveEvent(cause: EngineEvent, input: EngineEventInput): EngineEvent {
  return createEvent({ ...input, causationId: cause.id, depth: cause.depth + 1 })
}
