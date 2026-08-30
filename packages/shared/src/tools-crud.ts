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
