import { type CapabilityInvoker, defineCapability } from '@ia-flow/agent-engine'
import { z } from 'zod'

/**
 * Leer sólo lo que hace falta de un archivo grande: quien cumple la capacidad recibe el archivo
 * numerado (`N\tlínea`) y lo que el agente busca, y devuelve esas partes citadas textualmente
 * con su rango de líneas (`## lines A-B`), o `Not found:` y qué cubre el archivo.
 */
export const FILE_FOCUS = defineCapability({
  name: 'fileFocus',
  description:
    'Devuelve, citadas textualmente con su rango de líneas, sólo las partes de un archivo grande que responden a lo que busca el agente.',
  input: z.strictObject({
    path: z.string().describe('El archivo, relativo al worktree.'),
    focus: z.string().min(1).describe('Qué necesita el agente del archivo.'),
    content: z.string().describe('El contenido, con las líneas numeradas como "N\\tlínea".'),
  }),
  output: z.strictObject({
    text: z
      .string()
      .min(1)
      .describe('Las partes citadas (`## lines A-B` + el texto) o `Not found:`.'),
  }),
})

/** Lo que `fs_read` usa para enfocar: el texto enfocado, o `undefined` si no pudo. */
export type FileFocuser = (request: z.input<typeof FILE_FOCUS.input>) => Promise<string | undefined>

/** El `FileFocuser` sobre las capacidades de la corrida — `undefined` si nadie cumple
 *  `fileFocus`: `fs_read` ignora `focus`. */
export function capabilityFocuser(capabilities?: CapabilityInvoker): FileFocuser | undefined {
  if (!capabilities?.has(FILE_FOCUS.name)) return undefined
  return async (request) => (await capabilities.invoke(FILE_FOCUS, request))?.text
}

/** `N\tlínea`, desde 1. */
export function numberLines(content: string): string {
  return content
    .split('\n')
    .map((line, i) => `${i + 1}\t${line}`)
    .join('\n')
}
