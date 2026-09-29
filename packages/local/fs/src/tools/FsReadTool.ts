import { open, stat } from 'node:fs/promises'
import { z } from 'zod'
import { FsTool } from '../FsTool.js'
import { type FileFocuser, numberLines } from '../focus.js'

export const FsReadInput = z.strictObject({
  path: z.string().describe('Path relativo a la raíz del worktree'),
  focus: z
    .string()
    .optional()
    .describe(
      'Para un archivo grande: qué necesitás de él (ej. "la firma de createOrder y sus validaciones"). Devuelve sólo esas partes, citadas con su rango de líneas, en vez del archivo entero. Una lectura con focus no cuenta como haber leído el archivo completo.',
    ),
})
export type FsReadInput = z.infer<typeof FsReadInput>

const MAX_BYTES = 256 * 1024
/** Debajo de esto un `focus` no vale la vuelta al modelo: el archivo entra entero. */
const FOCUS_THRESHOLD = 15_000
/** Lo máximo que se le manda a quien enfoca. */
const MAX_FOCUS_INPUT = 150_000

export interface FsReadToolOptions {
  /** Quién resuelve un `focus` (la capacidad `fileFocus`). Sin esto, `focus` se ignora. */
  focus?: FileFocuser
}

export class FsReadTool extends FsTool<typeof FsReadInput> {
  readonly name = 'fs_read'
  readonly description =
    `Lee el contenido completo de un archivo de texto dentro de ${this.baseDir} (path relativo). Con \`focus\`, de un archivo grande devuelve sólo las partes que pedís.`
  readonly input = FsReadInput

  constructor(
    baseDir: string,
    private readonly options: FsReadToolOptions = {},
  ) {
    super(baseDir)
  }

  protected async execute(input: FsReadInput): Promise<string> {
    const content = await this.read(input)
    const focus = input.focus?.trim()
    if (!focus || Buffer.byteLength(content) <= FOCUS_THRESHOLD) return content
    return this.focused(input.path, focus, content)
  }

  /** Las partes que pidió `focus`. Si no hay quién enfoque, o falla, el archivo con el motivo:
   *  un focus que no se resolvió no tumba el turno. */
  private async focused(path: string, focus: string, content: string): Promise<string> {
    if (!this.options.focus) return content
    const partial = content.length > MAX_FOCUS_INPUT
    try {
      const text = await this.options.focus({
        path,
        focus,
        content: numberLines(partial ? content.slice(0, MAX_FOCUS_INPUT) : content),
      })
      if (text) {
        const coverage = partial ? `, sólo los primeros ${MAX_FOCUS_INPUT} caracteres` : ''
        return `[focus: ${focus} — ${content.length} → ${text.length} caracteres${coverage}]\n${text}`
      }
    } catch (error) {
      return `[focus no disponible: ${(error as Error).message} — va el archivo]\n${content}`
    }
    return `[focus no disponible — va el archivo]\n${content}`
  }

  private async read(input: FsReadInput): Promise<string> {
    const absPath = await this.resolveSafePath(input.path)
    // `readFile` sobre un FIFO (armable con `bash_run "mkfifo p"`) no tira ni devuelve — se
    // queda esperando para siempre a que algo lo abra en escritura. `stat().isFile()` filtra
    // eso (y sockets/devices) ANTES de intentar leer; a diferencia de `readFile`, `stat` nunca
    // bloquea esperando un writer.
    const info = await stat(absPath)
    if (!info.isFile()) {
      throw new Error(`fs_read: "${input.path}" no es un archivo regular`)
    }
    // Lee como mucho MAX_BYTES bytes crudos del archivo — nunca el archivo entero primero para
    // recién ahí cortar. Un `bash_run "truncate -s 1900M big"` + `fs_read big` con la versión
    // vieja (readFile completo, corte después) agotaba la memoria del proceso antes de llegar
    // al corte. El corte también es por BYTES reales acá (no `.slice()` sobre el string, que
    // corta por unidad UTF-16 y puede partir un carácter multibyte a la mitad).
    const truncated = info.size > MAX_BYTES
    const readSize = truncated ? MAX_BYTES : info.size
    const handle = await open(absPath, 'r')
    try {
      const buffer = Buffer.alloc(readSize)
      await handle.read(buffer, 0, readSize, 0)
      const content = buffer.toString('utf-8')
      return truncated ? `${content}\n\n[truncado — el archivo supera ${MAX_BYTES} bytes]` : content
    } finally {
      await handle.close()
    }
  }
}
