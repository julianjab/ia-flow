import { z } from 'zod'

// La acción `script`: correr un archivo del repo cuando pasa un evento.
//
// **Es ejecución de código configurada desde una UI.** El schema vive acá
// porque cruza la red, pero las guardas reales están en el adapter — ver
// `adapters/actions/script-action.ts`. Lo que este archivo aporta es la forma
// mínima posible: cuanto menos pueda expresar la config, menos superficie hay.
//
// **No hay `code` inline, a propósito.** Un script en el repo pasa por code
// review, queda versionado y se diffea; uno guardado en la base no lo ve nadie
// hasta que corre. Si en algún momento hace falta inline, va a ser una decisión
// aparte y con su propio motivo — no un campo que se agregó "por si acaso".

/** Los intérpretes soportados. Cerrado a propósito: `runtime` elige el binario
 *  que se spawnea, así que dejarlo abierto sería dejar elegir qué ejecutar. */
export const ScriptRuntimeSchema = z.enum(['bash', 'python'])
export type ScriptRuntime = z.infer<typeof ScriptRuntimeSchema>

export const ScriptActionSchema = z.object({
  action: z.literal('script'),
  runtime: ScriptRuntimeSchema,
  /**
   * Ruta del script, RELATIVA al repo de la tarea.
   *
   * Se valida en el adapter que caiga dentro del workspace: una ruta absoluta
   * o con `..` que se escape se rechaza. Acá sólo se descarta lo que ni
   * siquiera tiene sentido intentar.
   */
  file: z
    .string()
    .min(1)
    .refine((f) => !f.startsWith('/'), 'la ruta es relativa al repo, no absoluta'),
  /** Argumentos posicionales. Interpolan `{{event.payload...}}` como la acción
   *  http, y viajan como argv — nunca por una shell, así que un valor con
   *  espacios o `;` es un argumento y no un comando. */
  args: z.array(z.string()).optional(),
  /**
   * Variables de entorno a pasar, por NOMBRE.
   *
   * Allow-list y no un mapa de valores: el script recibe SÓLO éstas, con el
   * valor interpolado del evento. Heredar el env del daemon le entregaría a
   * cualquier script el `GITHUB_TOKEN` y el `ANTHROPIC_API_KEY`.
   */
  env: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
})
export type ScriptAction = z.infer<typeof ScriptActionSchema>

/** La env var que habilita la capacidad. Apagada por default: algo de este
 *  calibre no puede aparecer porque alguien actualizó el producto. */
export const SCRIPT_ACTIONS_ENV = 'IA_FLOW_ENABLE_SCRIPT_ACTIONS'
