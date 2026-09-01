// Reglas y acciones — el contrato que reemplaza "un status cablea agentes".
//
// Una regla dice: cuando pase un evento DE ESTE TIPO, que además cumpla ESTAS
// condiciones, y que caiga DENTRO DE MI ÁMBITO, ejecutá ESTAS acciones en
// orden.
//
// Los nombres de los campos de activación (`projectId`, `repoName`, `when`,
// `whenText`, `enabled`, `position`) son deliberadamente los mismos que los de
// `AgentActivationSchema`, con la misma semántica. No es coincidencia estética:
// es lo que permite que el editor de reglas reuse el de condiciones, y que la
// activación de un agente se pueda migrar a una fila de `rules` sin traducción
// conceptual.
import { z } from 'zod'
import { AgentExitSchema, WhenConditionSchema } from './schemas.js'
import { ScriptActionSchema } from './script-action.js'

// ── Acciones ─────────────────────────────────────────────────────────────────

/**
 * Correr un agente. Envuelve lo que hoy hace `AgentOrchestrator.runAgent`, así
 * que el agente conserva intactos su prompt, tools, MCP, policy y workspace: lo
 * único que cambia es quién decide cuándo corre.
 */
export const AgentActionSchema = z.object({
  action: z.literal('agent'),
  agentId: z.string().min(1),
  /**
   * Publicar el resultado del run como evento.
   *
   * Es lo que convierte a un agente en un NORMALIZADOR: un triager lee un
   * mensaje sin estructura, decide de qué proyecto es, y su salida entra al
   * bus como un evento ya ruteable que las reglas de proyecto sí pueden ver.
   *
   * Sin esto, un agente sólo puede mover el status del issue — que no sirve
   * cuando el evento que lo despertó no tenía issue.
   */
  emitOn: z.enum(['exit']).optional(),
  /** Tipo del evento derivado. Ausente ⇒ `run.finished`. */
  emitType: z.string().optional(),
  /**
   * Por qué está corriendo el agente, esta vez.
   *
   * Un agente declara QUÉ sabe hacer; sólo la regla sabe qué lo despertó — y
   * ese dato no existía en ningún lado. El mismo implementer al que un
   * `task.status_changed` manda a construir desde cero tiene que atender un
   * pedido puntual cuando lo despierta un `pr.review_submitted`, y sin brief
   * la única forma de expresarlo era ramificar dentro del prompt del agente,
   * haciéndolo adivinar el motivo a partir de si los comentarios vinieron
   * vacíos.
   *
   * Se antepone al user turn, ANTES del prompt del agente, y admite
   * `{{event.*}}` (`type`, `id`, `payload.*`, `scope.*`) para bajar el dato
   * concreto que disparó la regla. Una ruta desconocida se deja literal, igual
   * que en el prompt de un agente.
   *
   * Es el mismo concepto que el `brief` de la tool `run_agent` —contarle al
   * que va a correr lo que no puede deducir de su propia definición—, con la
   * diferencia de quién lo escribe: allá un agente padre, acá el operador.
   */
  brief: z.string().optional(),
  /**
   * Redirige el destino de las salidas del agente, para ESTE disparo.
   *
   * El `set` de una salida es el nombre de una columna de este board — ruteo,
   * exactamente el mismo dato que la migración 059 sacó del agente cuando se
   * llevó `statusName` a las reglas. Sin esto, reusar un roster contra un
   * segundo board obliga a clonar los agentes nada más que por el mapeo.
   *
   * **Merge por clave, y sólo sobre claves que el agente ya declara.** El
   * agente es dueño del VOCABULARIO (qué salidas existen y qué significan, que
   * es lo que va al enum de `select_exit`); la regla, del DESTINO. Una clave
   * desconocida se descarta con un warn — ver `resolveEffectiveExits`.
   *
   * Casi ningún disparo lo necesita: el default es el `exits` del agente, que
   * cubre a todo el roster sin escribir nada. Mismo patrón de tres niveles que
   * `resolveCommentTarget` (salida > agente > default).
   */
  exits: z.record(z.string(), AgentExitSchema).optional(),
})

/**
 * Llamar a una API.
 *
 * `body` y `headers` admiten `{{event.payload...}}` y `${SECRETO}`; los
 * secretos los resuelve el daemon antes de salir (mismo `setSecretResolver` que
 * usan los MCP), nunca el modelo.
 */
export const HttpActionSchema = z.object({
  action: z.literal('http'),
  url: z.string().min(1),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('POST'),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.unknown().optional(),
  timeoutMs: z.number().int().positive().optional(),
})

/** Invocar una tool del catálogo (`packages/tools`). Le abre a una regla las
 *  30 tools que ya existen —Slack, GitHub, memoria— sin escribir un handler
 *  por cada una. */

/**
 * Publicar un evento derivado.
 *
 * Es lo que permite encadenar sin inventar un DSL de workflow, y lo que hace
 * que un agente de triage pueda convertir un evento crudo (un mensaje suelto de
 * Slack, sin scope) en uno ya ruteable. El evento nace con `causationId` y
 * `depth+1` del que lo provocó — ver `deriveEvent`.
 */
export const EmitActionSchema = z.object({
  action: z.literal('emit'),
  type: z.string().min(1),
  scope: z
    .object({
      projectId: z.string().optional(),
      repos: z.array(z.string()).optional(),
      issueId: z.string().optional(),
      prNumber: z.number().int().optional(),
    })
    .optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
})

/**
 * Correr una acción definida aparte, por id.
 *
 * Las dos formas conviven a propósito: una llamada que se usa una vez no merece
 * nombre, y una que usan tres reglas no merece estar escrita tres veces.
 *
 * **Una `ref` apunta a una acción concreta, NUNCA a otra `ref`.** Eso mata el
 * problema de ciclos antes de que exista —sin contador de profundidad ni
 * detección en runtime— y no pierde nada: componer acciones es exactamente lo
 * que ya hace el `do[]` de una regla.
 */
export const RefActionSchema = z.object({
  action: z.literal('ref'),
  actionId: z.string().min(1),
})

export const RuleActionSchema = z.discriminatedUnion('action', [
  AgentActionSchema,
  HttpActionSchema,
  EmitActionSchema,
  ScriptActionSchema,
  RefActionSchema,
])
export type RuleAction = z.infer<typeof RuleActionSchema>
export type RuleActionKind = RuleAction['action']

/** Config común a toda acción, fuera del union para no repetirla en cada
 *  variante. `continueOnError` decide si una falla corta la secuencia; el
 *  default es cortar, porque el orden es lo que hace predecible una regla que
 *  primero comenta y después mueve el status. */
export const RuleActionEntrySchema = z.intersection(
  RuleActionSchema,
  z.object({ continueOnError: z.boolean().optional() }),
)
export type RuleActionEntry = z.infer<typeof RuleActionEntrySchema>

// ── La regla ─────────────────────────────────────────────────────────────────

export const RuleSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),

  /** Tipos de evento que la despiertan. Vacío sería una regla que nunca
   *  dispara, así que se exige al menos uno. */
  on: z.array(z.string().min(1)).min(1),

  // ── Ámbito: dónde vive la regla ES su filtro ──────────────────────────────
  // `null`/ausente = sin restricción. Un valor más específico ESTRECHA el
  // conjunto de eventos que ve; no reemplaza un default (es lo contrario de
  // `resolveSlackReviewTarget`, donde el repo cae al proyecto). Y es
  // fail-closed: un evento sin `scope.projectId` no lo ve una regla que sí lo
  // declara — ver `matchScope`.
  projectId: z.string().nullable().optional(),
  repoName: z.string().nullable().optional(),

  /** Condiciones sobre el payload del evento, incluyendo caminos anidados
   *  (`pr.head.ref`). Mismo DSL que la activación de un agente. */
  when: z.union([z.array(WhenConditionSchema), z.record(z.string(), z.string())]).optional(),
  /** Gate semántico: un modelo lee el evento y dice si cumple. Descarta la
   *  regla aunque sea la única candidata. */
  whenText: z.string().optional(),

  /**
   * Expresion cron que hace tickear esta regla.
   *
   * Vive EN la regla y no en una tabla aparte: son dos cosas que siempre se
   * editan juntas, y separarlas dejaria posible un schedule que no apunta a
   * ninguna regla. Una regla con `schedule` normalmente lleva
   * `on: ['schedule.tick']`.
   *
   * Cinco campos, comodines, listas y pasos. Sin rangos ni nombres de mes —
   * ver `parseCron` en @ia-flow/rules para por que el parser es minimo.
   */
  schedule: z.string().optional(),

  enabled: z.boolean().optional(),
  position: z.number().optional(),

  /**
   * Si esta regla, al matchear, impide que disparen las de menor prioridad.
   *
   * Existe para recuperar la semántica que tenía `selectAgent` —el primero por
   * especificidad y `position`, y basta— en el modelo nuevo, donde por default
   * **todas** las reglas que matchean disparan. Eso último es lo que permite
   * que un PR detone dos acciones, pero también deja que dos reglas mal
   * configuradas lancen dos agentes sobre la misma task.
   */
  exclusive: z.boolean().optional(),

  /** Acciones, en orden. Correr en paralelo tendría que ser explícito y no un
   *  default: el orden es parte de lo que hace predecible una regla. */
  do: z.array(RuleActionEntrySchema).min(1),

  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
})
export type Rule = z.infer<typeof RuleSchema>

/** Lo que acepta un POST/PUT: sin los campos que pone el server. */
export const RuleInputSchema = RuleSchema.omit({ createdAt: true, updatedAt: true }).partial({
  id: true,
})
export type RuleInput = z.infer<typeof RuleInputSchema>

// ── Ejecución ────────────────────────────────────────────────────────────────

export const ActionRunStatusSchema = z.enum([
  'pending',
  'running',
  'succeeded',
  'failed',
  'skipped',
])
export type ActionRunStatus = z.infer<typeof ActionRunStatusSchema>

/**
 * Una acción encolada o ya ejecutada.
 *
 * Persiste porque una acción `http` no tiene ninguna de las redes que tiene un
 * run de agente (ni `execution_logs`, ni el flag `working` en la fuente): si el
 * proceso se reinicia entre "el evento llegó" y "la llamada salió", la llamada
 * se perdió y nadie se entera. Como efecto lateral da el panel de "qué disparó
 * qué", que hoy no existe para nada que no sea un agente.
 */
export const ActionRunSchema = z.object({
  id: z.string(),
  ruleId: z.string(),
  eventId: z.string(),
  eventType: z.string(),
  projectId: z.string().nullable().optional(),
  /** Índice dentro del `do[]` de la regla — el orden importa al reintentar. */
  position: z.number().int().nonnegative(),
  kind: z.string(),
  status: ActionRunStatusSchema,
  attempts: z.number().int().nonnegative().default(0),
  error: z.string().nullable().optional(),
  result: z.string().nullable().optional(),
  createdAt: z.string(),
  startedAt: z.string().nullable().optional(),
  finishedAt: z.string().nullable().optional(),
})
export type ActionRun = z.infer<typeof ActionRunSchema>

/** Lo que una acción con nombre puede hacer: todo menos referenciar a otra. */
export const NamedActionBodySchema = z.discriminatedUnion('action', [
  AgentActionSchema,
  HttpActionSchema,
  EmitActionSchema,
  ScriptActionSchema,
])
export type NamedActionBody = z.infer<typeof NamedActionBodySchema>

/**
 * Una acción con nombre propio.
 *
 * Mismo modelo de ámbito que las reglas: `projectId: null` es global y la ven
 * todos los proyectos; con valor, es de ese proyecto. Referenciar desde una
 * regla la acción de OTRO proyecto no es posible por construcción — el
 * repositorio sólo devuelve las visibles en el ámbito.
 */
export const NamedActionSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  projectId: z.string().nullable().optional(),
  /** El cuerpo va anidado y no aplanado sobre la fila: así una acción con
   *  nombre y una inline son EL MISMO objeto para el runner, que es lo que
   *  permite ejecutarlas por el mismo camino sin ramas. */
  body: NamedActionBodySchema,
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
})
export type NamedAction = z.infer<typeof NamedActionSchema>
