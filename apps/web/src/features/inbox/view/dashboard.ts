// El dashboard de UN runner: qué es una decisión para quien mira, cómo se llama, en qué orden va y
// qué paneles se ven. Es config de la web —el runner publica hechos y acciones, no presentación—,
// elegida por el server seleccionado (`resolve.ts`).
//
// Un documento YAML:
//
//   decisions:                 # la primera cuyo `when` se cumple gana; sin ninguna, la tarea no
//     - id: merge              # aparece (el pipeline la lleva solo)
//       group: need            # need | fail | run | queue — la sección donde se muestra
//       kind: merge            # el caso (etiqueta y color de la tarjeta)
//       weight: 100            # dentro del grupo, mayor primero
//       when: [ ... ]          # filas como el `when` de una pipeline, sobre los hechos de la tarea
//       verb: Decidir el merge # plantilla; sin verbo, el nombre del caso
//       why: 'Review + reviewed{{fmt.pr}}'
//       chips: [ { text: a un merge de Done, tone: hot } ]
//       actions: [ merge ]     # de las que el runner ofrece, cuáles y en qué orden
//       primary: merge
//
// Raíz de `when` y de las plantillas: lo que publica `GET /api/tasks` por tarea —`item.*`, `run.*`,
// `live.*`, `queue.*`, `task.*`, `pr.*`, `ref`, `title`, `updated_at`, `last_run.*`, `live_run.*`,
// `blocked_by_refs`, `actions`— y `fmt.*`: textos ya armados (`fmt.pr`, `fmt.tokens`, `fmt.who`,
// `fmt.pause`, `fmt.expires`, `fmt.summary`, `fmt.blocked_by`).

import { InboxKindSchema } from '@ia-flow/shared'
import { parse } from 'yaml'
import { z } from 'zod'

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

const RowSchema = z
  .object({
    field: z.string().min(1),
    op: z.enum(OPS),
    value: z.unknown().optional(),
    valueFrom: z.string().optional(),
    logic: z.enum(['and', 'or']).optional(),
  })
  .strict()
const Rows = z.array(RowSchema)

const ChipSchema = z
  .object({
    text: z.string().min(1),
    tone: z.enum(['hot', 'warn', 'bad']).optional(),
    /** Si no se cumple, el chip no sale. */
    when: Rows.optional(),
  })
  .strict()

/** Un texto o una lista de textos: el primero que resuelve a algo gana. */
const Texts = z.union([z.string(), z.array(z.string())]).transform((value) => [value].flat())

export const DecisionSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]*$/, 'el id va en snake_case'),
    group: z.enum(['need', 'fail', 'run', 'queue']),
    kind: InboxKindSchema.exclude(['idle']),
    weight: z.number().default(0),
    when: Rows.default([]),
    verb: z.string().optional(),
    /** Una línea: por qué está acá. */
    why: z.string().min(1),
    /** Desde cuándo está así (ISO): el primero de la lista que no queda vacío. El default ya es
     *  la lista: con Zod 4 (el que empaqueta Vite) un `.default()` no pasa por el `transform`, y un
     *  string suelto se recorría letra por letra (`"{"`, una fecha que no parsea: sin antigüedad). */
    since: Texts.default(['{{updated_at}}']),
    /** Lo que dijo el agente. */
    said: z.string().optional(),
    context: z.string().optional(),
    chips: z.array(ChipSchema).default([]),
    /** De las acciones que el runner ofrece para la tarea, cuáles se muestran y en qué orden. Sin
     *  esto, todas las que ofrece. */
    actions: z.array(z.string()).optional(),
    /** La que se destaca; sin ella, la principal del caso. */
    primary: z.string().optional(),
  })
  .strict()
export type Decision = z.infer<typeof DecisionSchema>

const FeedSchema = z
  .object({
    title: z.string().default('Qué le das al pipeline'),
    /** Qué cards entran: las que el pipeline podría tomar ya. */
    when: Rows,
    /** La acción del runner que las pone a correr. */
    action: z.string().optional(),
    limit: z.number().int().positive().default(5),
  })
  .strict()

const HygieneSchema = z.object({ text: z.string().min(1), when: Rows }).strict()

export const DashboardSchema = z
  .object({
    version: z.literal(1).default(1),
    /** A qué runner(s) pertenece: su URL base —`local` es el que proxea Vite—. Con ella se elige el
     *  dashboard de un archivo de `.config/dashboards/`. */
    server: z.union([z.string(), z.array(z.string())]).optional(),
    decisions: z.array(DecisionSchema).min(1),
    /** Cómo se desempata dentro de un grupo. */
    rank: z
      .array(z.enum(['group', 'weight', 'unlocks', 'waiting']))
      .default(['group', 'weight', 'waiting']),
    panels: z
      .object({
        /** Cuántas corridas tiene el runner y cuántos lugares libres. */
        pipeline: z.boolean().default(true),
        feed: FeedSchema.optional(),
        hygiene: z.array(HygieneSchema).default([]),
      })
      .strict()
      .default({}),
  })
  .strict()
export type Dashboard = z.infer<typeof DashboardSchema>
export type DashboardRow = z.infer<typeof RowSchema>

export class DashboardError extends Error {}

/** El YAML de un dashboard, validado. Un error dice dónde, para quien lo escribe a mano. */
export function parseDashboard(text: string): Dashboard {
  let doc: unknown
  try {
    doc = parse(text)
  } catch (err) {
    throw new DashboardError(`YAML inválido: ${err instanceof Error ? err.message : String(err)}`)
  }
  const result = DashboardSchema.safeParse(doc)
  if (!result.success) {
    const where = result.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join('.') || '(raíz)'}: ${issue.message}`)
      .join('\n')
    throw new DashboardError(`El dashboard no cumple el formato:\n${where}`)
  }
  return result.data
}
