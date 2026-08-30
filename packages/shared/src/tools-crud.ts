import { z } from 'zod'

// Tools editables.
//
// Dos cosas distintas en una tabla, con `kind` explícito porque el límite entre
// ellas es lo que hace segura la feature:
//
//   `defined`  — una tool NUEVA que ejecuta una acción con nombre. Todo suyo es
//                editable: nace de la config, no del código.
//   `override` — un ajuste sobre una tool BUILT-IN. **Sólo la descripción.**
//
// Por qué el override no puede tocar más que la descripción:
//
//   `name`         es la clave que los agentes escriben en su `tools[]`.
//                  Renombrarla rompe el roster en silencio.
//   `input_schema` el `execute` compilado está escrito contra él.
//   `execute`      es código.
//
// La descripción, en cambio, es prompt engineering puro: hoy afinarla exige un
// deploy, y es exactamente el tuning que más se quiere hacer sin uno.

export const TOOL_KINDS = ['defined', 'override'] as const
export type ToolKind = (typeof TOOL_KINDS)[number]

/**
 * El nombre de una tool es GLOBAL, no por proyecto.
 *
 * Es lo que un agente escribe en su `tools[]`, y `ProviderInput.tools` viaja
 * como lista de nombres —no de objetos— hasta el provider, que los resuelve
 * contra un registry único del proceso. Hacerlo por proyecto obligaría a
 * namespacear el nombre en el wire y a que el agente supiera en qué proyecto
 * corre para nombrar su tool, que es exactamente lo que un id de tool no
 * debería requerir.
 *
 * `projectId` sigue existiendo para saber quién la creó y poder listarla en su
 * ámbito; NO desambigua nombres. Dos proyectos con una `deploy_staging`
 * distinta tienen que llamarlas distinto — es una restricción real, y es más
 * honesta que dos tools con el mismo nombre y ninguna forma de saber cuál corrió.
 */
export const ToolNameSchema = z
  .string()
  .min(1)
  .regex(
    /^[a-z][a-z0-9_]*$/,
    'sólo minúsculas, dígitos y guión bajo — es un identificador que el modelo escribe',
  )

export const DefinedToolSchema = z.object({
  kind: z.literal('defined'),
  name: ToolNameSchema,
  /** Lo que el modelo lee para decidir si la usa. Es la mitad del valor de una
   *  tool: sin esto es una función sin documentar. */
  description: z.string().min(1),
  /** JSON Schema de la entrada. Se mapea a las variables del script. */
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  /** La acción con nombre que ejecuta. Una tool NO trae config de ejecución
   *  propia: eso es de la acción, y separarlas es lo que permite afinar la
   *  descripción sin tocar cómo se ejecuta. */
  actionId: z.string().min(1),
  projectId: z.string().nullable().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
})

export const ToolOverrideSchema = z.object({
  kind: z.literal('override'),
  /** El nombre de la built-in a la que ajusta. Tiene que existir. */
  name: ToolNameSchema,
  /** Lo ÚNICO editable de una built-in. */
  description: z.string().min(1),
  projectId: z.null().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
})

export const EditableToolSchema = z.discriminatedUnion('kind', [
  DefinedToolSchema,
  ToolOverrideSchema,
])
export type EditableTool = z.infer<typeof EditableToolSchema>
export type DefinedTool = z.infer<typeof DefinedToolSchema>
export type ToolOverride = z.infer<typeof ToolOverrideSchema>

// ── Los parámetros de una tool definida ──────────────────────────────────────
//
// `inputSchema` se guarda como JSON Schema porque eso es lo que viaja a la API
// del modelo (`Tool.input_schema`): guardarlo en un formato propio obligaría a
// traducir en el borde de cada provider. Lo que se EDITA, en cambio, es una
// lista plana de parámetros — que es la forma en que se piensa una tool, y la
// única que se puede poner al lado de los `{{event.payload.<campo>}}` que la
// acción lee (ver `action-payload.ts`).
//
// Las dos funciones de abajo son ese par, y son puras a propósito: la coherencia
// entre tool y acción se decide con datos que ya están en memoria, sin I/O.

/** Los tipos que el editor sabe expresar. Cerrado a propósito: son los que un
 *  parámetro de tool necesita, y abrirlo a `object`/`array` pediría un editor
 *  de schemas anidados —para eso está la API. */
export const TOOL_PARAM_TYPES = ['string', 'number', 'boolean'] as const

export const ToolParamSchema = z.object({
  /** La clave que el modelo manda. Es el mismo nombre que la acción escribe en
   *  su `{{event.payload.<name>}}`. */
  name: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'identificador: letras, dígitos y guión bajo'),
  type: z.enum(TOOL_PARAM_TYPES),
  /** Lo que el modelo lee para saber qué poner. Sin esto un `branch` es un
   *  string sin pistas. */
  description: z.string().optional(),
  required: z.boolean().optional(),
})
export type ToolParam = z.infer<typeof ToolParamSchema>

/** La lista de parámetros, como el JSON Schema que viaja al modelo. */
export function toolParamsToInputSchema(params: ToolParam[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  for (const p of params) {
    properties[p.name] = {
      type: p.type,
      ...(p.description ? { description: p.description } : {}),
    }
  }
  const required = params.filter((p) => p.required).map((p) => p.name)
  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
  }
}

/**
 * El camino de vuelta, o `null` si el schema dice algo que esta lista no puede.
 *
 * `null` y no un mejor esfuerzo: un `inputSchema` escrito por API puede tener
 * un `array`, un `enum` o un objeto anidado, y devolver una aproximación haría
 * que abrir el editor y guardar lo destruyera en silencio. Con `null` la UI
 * muestra el schema y manda a editarlo por donde se escribió.
 */
export function inputSchemaToToolParams(schema: unknown): ToolParam[] | null {
  if (schema == null) return []
  if (typeof schema !== 'object' || Array.isArray(schema)) return null

  const s = schema as Record<string, unknown>
  const known = new Set(['type', 'properties', 'required'])
  if (Object.keys(s).some((k) => !known.has(k))) return null
  if (s.type !== undefined && s.type !== 'object') return null

  const props = s.properties
  if (props === undefined) return []
  if (typeof props !== 'object' || props === null || Array.isArray(props)) return null

  const required = new Set(Array.isArray(s.required) ? (s.required as unknown[]) : [])

  const params: ToolParam[] = []
  for (const [name, raw] of Object.entries(props as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
    const p = raw as Record<string, unknown>
    if (Object.keys(p).some((k) => k !== 'type' && k !== 'description')) return null
    if (typeof p.type !== 'string' || !TOOL_PARAM_TYPES.includes(p.type as ToolParam['type'])) {
      return null
    }
    if (p.description !== undefined && typeof p.description !== 'string') return null
    const parsed = ToolParamSchema.safeParse({
      name,
      type: p.type,
      ...(p.description ? { description: p.description } : {}),
      ...(required.has(name) ? { required: true } : {}),
    })
    if (!parsed.success) return null
    params.push(parsed.data)
  }
  return params
}
