import { z } from 'zod'
import { Condition, type ConditionRow } from '../condition/Condition.js'
import { SchemaTool, type ToolInputSchema } from './SchemaTool.js'

/** Nombre de la tool con la que el modelo pausa su turno hasta que llegue un evento. */
export const WAIT_TOOL_NAME = 'wait_for_event'

/** Qué puede esperar un agente (`AgentDefinitionProps.waits`). */
export interface AgentWaits {
  /** Los tipos de evento que puede esperar. */
  on: string[]
  /** Cuánto espera si no pide otra cosa. Default: 60. */
  defaultMinutes?: number
  /** Lo máximo que puede pedir. Default: 7 días. */
  maxMinutes?: number
}

/** Lo que el modelo pidió esperar: con eso `Agent` arma la `Pause`. */
export interface Waiting {
  on: string[]
  when: ConditionRow[]
  timeoutMs: number
  reason: string
}

const OPS = [
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

const DEFAULT_MINUTES = 60
const MAX_MINUTES = 7 * 24 * 60

/**
 * Pausa el turno del agente A MITAD de su conversación hasta que llegue un evento que espera (o
 * venza el plazo): la ejecución se pausa, libera su lugar, y al despertar el agente sigue en la
 * misma conversación con el evento como mensaje. Sólo se ofrece dentro de una ejecución y a un
 * agente que declara `waits` — qué eventos puede esperar lo decide el operador, no el modelo.
 */
export class WaitTool extends SchemaTool<ToolInputSchema> {
  readonly name = WAIT_TOOL_NAME
  readonly description =
    'Pausá tu turno hasta que llegue un evento (ej. que termine el CI, que alguien conteste un comentario) o venza el plazo. Tu trabajo queda como está y seguís en esta misma conversación con el evento que llegó. Llamala sola: termina tu turno.'
  readonly input: ToolInputSchema
  readonly terminal = true
  /** No es una salida: no cuenta al insistirle al modelo que elija una. */
  readonly failure = true

  constructor(
    private readonly waits: AgentWaits,
    private readonly onWait: (waiting: Waiting) => void,
  ) {
    super()
    const max = waits.maxMinutes ?? MAX_MINUTES
    const [first, ...rest] = waits.on
    if (first === undefined) throw new Error('waits.on: al menos un tipo de evento')
    this.input = z.strictObject({
      on: z
        .array(z.enum([first, ...rest]))
        .min(1)
        .describe('Qué tipos de evento te despiertan.'),
      when: z
        .array(
          z.strictObject({
            field: z.string().min(1).describe('Path punteado sobre el payload del evento.'),
            op: z.enum(OPS),
            value: z.unknown().optional(),
          }),
        )
        .optional()
        .describe('Condiciones sobre el payload del evento, todas tienen que cumplirse.'),
      timeoutMinutes: z
        .number()
        .int()
        .positive()
        .max(max)
        .optional()
        .describe(
          `Cuánto esperar como máximo (default ${waits.defaultMinutes ?? DEFAULT_MINUTES}, máximo ${max}). Si vence, seguís igual con ese aviso.`,
        ),
      reason: z.string().min(1).describe('Qué esperás y por qué, en una oración.'),
    }) as unknown as ToolInputSchema
  }

  protected execute(input: Record<string, unknown>): string {
    const when = (input.when as ConditionRow[] | undefined) ?? []
    // Una condición inválida (una regex rota) tiene que fallar acá, donde el modelo la corrige.
    Condition.fromRows(when)
    const minutes = (input.timeoutMinutes as number | undefined) ?? this.waits.defaultMinutes
    this.onWait({
      on: input.on as string[],
      when,
      timeoutMs: (minutes ?? DEFAULT_MINUTES) * 60_000,
      reason: input.reason as string,
    })
    return 'Esperando. Tu turno termina acá: seguís en esta conversación cuando llegue el evento o venza el plazo.'
  }
}
