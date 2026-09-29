/**
 * El modelo de definiciones: la forma de una fuente, un agente y una pipeline, venga de donde
 * venga (YAML, SQLite, …). Cada datasource produce estos documentos; `SourceBuilder` los arma.
 * Los pasos son nodos abiertos (`StepNode`): cada tipo de paso los valida con su propia factory.
 */
import { z } from 'zod'

const CONDITION_OPS = [
  'eq',
  'neq',
  'exists',
  'notExists',
  'in',
  'notIn',
  'contains',
  'notContains',
  'matches',
  'gt',
  'gte',
  'lt',
  'lte',
] as const

export const ConditionRows = z.array(
  z.strictObject({
    field: z.string().min(1),
    op: z.enum(CONDITION_OPS),
    value: z.unknown().optional(),
    /** Otro campo del mismo payload contra el que comparar, en vez de `value`. */
    valueFrom: z.string().min(1).optional(),
    logic: z.enum(['and', 'or']).optional(),
  }),
)

export const StepNode = z.record(z.string(), z.unknown())

/**
 * El gate semántico (`whenText`): el criterio en lenguaje natural, o `{ text, systemPrompts }`.
 * El modelo que decide es el del agente que cumple la capacidad `whenText` (ver el engine).
 * Un system prompt se nombra por id —uno del `source.yaml` o del catálogo— o va inline
 * (`{ text }`); se resuelven al cargar.
 */
export const WhenTextNode = z.union([
  z.string().min(1),
  z.strictObject({
    text: z.string().min(1),
    systemPrompts: z
      .array(z.union([z.string().min(1), z.strictObject({ text: z.string().min(1) })]))
      .optional(),
  }),
])
export type WhenTextNode = z.infer<typeof WhenTextNode>
export type StepNode = z.infer<typeof StepNode>

/** `end`, un paso o una lista de pasos. */
export const RouteToNode = z.union([
  z.literal('end'),
  StepNode,
  z.array(z.union([z.literal('end'), StepNode])),
])

export const ExitRouteNode = z.strictObject({
  when: z.string().optional(),
  to: RouteToNode.optional(),
  report: StepNode.nullable().optional(),
})

export const ErrorRouteNode = z.strictObject({
  to: RouteToNode.optional(),
  /** Nombre de un mapper del catálogo: el input de cada destino a partir del error. */
  input: z.string().optional(),
  /** Nombre de un mapper del catálogo: el input del reporte a partir del error. */
  report: z.string().optional(),
})

/** Qué corre si interrumpen al agente (`ifRunning: interrupt` de la regla que viene): sus pasos
 *  leen `{{steps.interruption.reason}}` / `{{steps.interruption.progress}}`. */
export const InterruptRouteNode = z.strictObject({
  to: RouteToNode.optional(),
})

/** `30s`, `45m`, `2h`. */
export const Duration = z.string().regex(/^\d+(s|m|h)$/, 'una duración: `30s`, `45m`, `2h`')

const DURATION_MS = { s: 1_000, m: 60_000, h: 3_600_000 } as const

export function durationMs(duration: string): number {
  const unit = duration.at(-1) as keyof typeof DURATION_MS
  return Number(duration.slice(0, -1)) * DURATION_MS[unit]
}

const SystemPromptRefs = z.array(
  z.strictObject({ id: z.string().optional(), text: z.string().optional() }),
)

const Defaults = {
  onError: ErrorRouteNode.nullable().optional(),
  onInterrupt: InterruptRouteNode.nullable().optional(),
  report: StepNode.nullable().optional(),
}

export const SourceDoc = z.strictObject({
  /** Su id, si el datasource lo lee de la definición (ver `SourceDocs.id`). */
  id: z.string().min(1).optional(),
  /** Constantes de la fuente, si el datasource las sustituye al leer (`{{vars.x}}` en YAML). */
  vars: z.record(z.string(), z.unknown()).optional(),
  /** Van ANTES de los de cada agente de la fuente: el prefijo compartido (y cacheable) de todos. */
  systemPrompts: SystemPromptRefs.optional(),
  /** Quién cumple cada capacidad del engine (`whenText`, `fileFocus`, …): un paso, típicamente
   *  `{ agent: <id> }` con un modelo chico. Ver `Capability` en el engine. */
  capabilities: z.record(z.string().min(1), StepNode).optional(),
  ...Defaults,
})
export type SourceDoc = z.infer<typeof SourceDoc>

const EventFilterNode = z.strictObject({
  on: z.array(z.string().min(1)).min(1),
  when: ConditionRows.optional(),
})

const ActionEntry = z.union([
  z.string(),
  z.strictObject({
    action: z.string(),
    allowWrite: z.boolean().optional(),
    /** Campos del input que fija la config (`Action.bind`). */
    with: z.record(z.string(), z.unknown()).optional(),
    /** Para una acción que el catálogo arma a pedido (`ActionProvider`): cómo armarla. */
    options: z.record(z.string(), z.unknown()).optional(),
  }),
])

const InputField = z.strictObject({
  type: z.enum(['string', 'number', 'boolean']),
  description: z.string().optional(),
  optional: z.boolean().optional(),
})

export const AgentDoc = z.strictObject({
  id: z.string().min(1),
  provider: z.string().min(1),
  prompt: z.string(),
  /** Lo que recibe cuando lo alcanza una ruta (`{{input.x}}`): un schema del catálogo por nombre,
   *  o los campos inline. */
  input: z.union([z.string(), z.record(z.string(), InputField)]).optional(),
  systemPrompts: SystemPromptRefs.optional(),
  variables: z
    .record(
      z.string(),
      z.union([
        z.string(),
        z.strictObject({
          value: z.string(),
          full: z.string().optional(),
          description: z.string().optional(),
        }),
      ]),
    )
    .optional(),
  tools: z.array(z.string()).optional(),
  actions: z.array(ActionEntry).optional(),
  /** Todas sus acciones pueden escribir: listarlas ya es la decisión del operador. Sin esto, una
   *  que escribe necesita `allowWrite: true` en su entrada. */
  allowWrites: z.boolean().optional(),
  onStart: z.array(StepNode).optional(),
  injects: z.array(EventFilterNode).optional(),
  providerConfig: z.record(z.string(), z.unknown()).optional(),
  /** Por id (del catálogo `mcpServers`) o inline. Un id que el catálogo no tiene se omite con un
   *  aviso: el agente corre sin ese servidor. */
  mcpServers: z
    .array(
      z.union([
        z.string(),
        z.strictObject({ id: z.string(), config: z.record(z.string(), z.unknown()) }),
      ]),
    )
    .optional(),
  continueOnError: z.boolean().optional(),
  when: ConditionRows.optional(),
  /** Donde sea que corra: un modelo decide si el evento le corresponde (ver `WhenTextNode`). */
  whenText: WhenTextNode.optional(),
  routes: z.record(z.string(), ExitRouteNode).optional(),
  ...Defaults,
})
export type AgentDoc = z.infer<typeof AgentDoc>

export const PipelineDoc = z.strictObject({
  id: z.string().min(1),
  /** Para leerla: no cambia nada. */
  name: z.string().optional(),
  on: z.array(z.string().min(1)).min(1),
  scope: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().optional(),
  position: z.number().optional(),
  exclusive: z.boolean().optional(),
  /** Los pasos son alternativas: corre sólo el primero cuyo `when` pasa (ver `Pipeline`). */
  firstMatch: z.boolean().optional(),
  ifRunning: z.enum(['wait', 'skip', 'interrupt']).optional(),
  /** Con `ifRunning: interrupt`: qué eventos interrumpen; los demás esperan. */
  interruptOn: z.array(EventFilterNode).optional(),
  ifPaused: z.enum(['supersede', 'wait']).optional(),
  ifQueued: z.enum(['replace', 'keep']).optional(),
  when: ConditionRows.optional(),
  /** Después del `when`: un modelo decide si la pipeline corre (ver `WhenTextNode`). */
  whenText: WhenTextNode.optional(),
  do: z.array(StepNode).min(1),
  /** Overrides por agente: `routes.<agentId>.routes.<salida>` (`null` la elimina). */
  routes: z
    .record(
      z.string(),
      z.strictObject({
        routes: z.record(z.string(), ExitRouteNode.nullable()).optional(),
        ...Defaults,
      }),
    )
    .optional(),
  ...Defaults,
})
export type PipelineDoc = z.infer<typeof PipelineDoc>

/** Claves que cualquier paso puede llevar además de las suyas. */
export const CommonStepShape = {
  id: z.string().min(1).optional(),
  when: ConditionRows.optional(),
  whenText: WhenTextNode.optional(),
  continueOnError: z.boolean().optional(),
}
