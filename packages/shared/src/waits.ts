// Esperas y pausas — lo único que sobrevive al final de un run.
//
// "El run se detiene y sigue después" describe DOS cosas que no se parecen, y
// tratarlas como una sola lleva al diseño equivocado:
//
//   Espera  — la decide el AGENTE, porque terminó lo que podía hacer. No hay
//             posición que conservar. Cuesta cero: libera slot, lock y
//             worktree, y el contexto vive en el issue y en su memoria.
//   Pausa   — la decide el agente porque un HUMANO se lo pidió por el hilo, a
//             mitad del trabajo. Hay que conservar la posición, así que
//             retiene el worktree.
//
// La unificación que hace que esto no sea un mecanismo aparte: **una pausa es
// una espera con un checkpoint colgado**. Misma tabla, mismo matcher; lo único
// que las separa es si `checkpoint` viene lleno y qué evento las despierta.
//
// Y la observación que lo hace barato: un wait es una REGLA EFÍMERA, de un solo
// uso, con scope de task. Se evalúa con el mismo `matchScope` + `evalWhen` que
// una regla; las dos diferencias son que se consume al matchear y que vence.
import { z } from 'zod'
import { WhenConditionSchema } from './schemas.js'

export const WaitSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  taskId: z.string(),
  /** Quién esperó. Es también el default de `resumeWith`. */
  agentId: z.string(),

  /** Tipos de evento que la despiertan. Sin al menos uno, nada podría hacerlo. */
  on: z.array(z.string().min(1)).min(1),
  /** Mismas condiciones que una regla, evaluadas contra el payload del evento. */
  when: z.union([z.array(WhenConditionSchema), z.record(z.string(), z.string())]).optional(),

  /**
   * OBLIGATORIO.
   *
   * Un CI que nunca corre porque el workflow tenía un error de sintaxis
   * dejaría la task esperando para siempre, sin nadie mirando. Al vencer, el
   * engine emite `wait.expired` — que es un evento, así que qué hacer con un
   * timeout se configura con una regla en vez de hardcodearse.
   */
  expiresAt: z.string(),

  /** Qué agente corre al despertar. Ausente = el que esperó. */
  resumeWith: z.string().optional(),
  /** El run que la creó, para trazabilidad. */
  createdByRun: z.string().optional(),

  /**
   * El estado del run, cuando es una PAUSA.
   *
   * `null` en una espera común: no hay nada que conservar. En una pausa es lo
   * que el provider serializó — para `anthropic-api`, el array de mensajes del
   * `executeLoop`. Opaco a propósito: cada provider decide qué significa "el
   * punto donde va", y este contrato no modela ninguno.
   */
  checkpoint: z.record(z.string(), z.unknown()).nullable().optional(),

  createdAt: z.string(),
})
export type Wait = z.infer<typeof WaitSchema>

/** Lo que un agente pide al esperar. El resto lo completa el engine con datos
 *  del dispatch — el agente no puede nombrar la task ni el proyecto de otro. */
export const WaitRequestSchema = z.object({
  on: z.array(z.string().min(1)).min(1),
  when: z.union([z.array(WhenConditionSchema), z.record(z.string(), z.string())]).optional(),
  timeoutMs: z.number().int().positive().optional(),
  reason: z.string().optional(),
})
export type WaitRequest = z.infer<typeof WaitRequestSchema>

/** Una hora. Suficiente para un CI, corto para que una espera olvidada no
 *  bloquee la task por días. Un agente que necesita más lo pide explícito. */
export const DEFAULT_WAIT_TIMEOUT_MS = 60 * 60 * 1000

/** Tope duro: siete días. Un `timeoutMs` mayor se recorta acá en vez de
 *  aceptarse, porque una espera de un mes es indistinguible de una task
 *  abandonada. */
export const MAX_WAIT_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000

/** Emitido cuando una espera vence sin que su evento llegara. Es un evento
 *  como cualquier otro: qué hacer con un timeout lo decide una regla. */
/** Un mensaje inyectado en el run de una tarea. Vive aca y no junto a la tool
 *  `pause_until` porque es un CONTRATO de dos puntas: la tool arma la
 *  espera sobre este tipo, y quien publica el mensaje (la ruta, Slack) no
 *  deberia tener que importar el paquete de tools para nombrarlo. */
export const TASK_MESSAGE_EVENT = 'task.message'

export const WAIT_EXPIRED = 'wait.expired'

/** Emitido cuando una espera se consume y su run se reanuda. Permite que una
 *  regla observe el ciclo sin acoplarse al mecanismo. */
export const WAIT_RESUMED = 'wait.resumed'

// ── Mensajes inyectados en un run en curso ──────────────────────────────────

/**
 * Un mensaje que entra a un run que ya está corriendo.
 *
 * La cola se drena al tope del loop, antes de cada turno. Vale por sí sola
 * —dirigir un agente en vuelo ("che, mirá también X") es útil sin pausar
 * nada— y es la primera de las tres piezas de una pausa.
 */
export const RunMessageSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  /** Nulo mientras el mensaje espera a que arranque un run. */
  runId: z.string().nullable().optional(),
  body: z.string(),
  /** Quién lo mandó: un handle de Slack, un usuario de GitHub, 'system'. */
  author: z.string().optional(),
  /** De dónde vino: 'slack' | 'github' | 'api'. */
  source: z.string().optional(),
  createdAt: z.string(),
  /** Cuándo lo consumió el loop. Nulo = todavía pendiente. */
  deliveredAt: z.string().nullable().optional(),
})
export type RunMessage = z.infer<typeof RunMessageSchema>
