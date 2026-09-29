import { open, stat } from 'node:fs/promises'
import { z } from 'zod'
import { FsTool } from '../FsTool.js'

export const FsReadInput = z.strictObject({
  path: z.string().describe('Path relativo a la raíz del worktree'),
})
export type FsReadInput = z.infer<typeof FsReadInput>

const MAX_BYTES = 256 * 1024

export class FsReadTool extends FsTool<typeof FsReadInput> {
  readonly name = 'fs_read'
  readonly description =
    `Lee el contenido completo de un archivo de texto dentro de ${this.baseDir} (path relativo).`
  readonly input = FsReadInput

  protected async execute(input: FsReadInput): Promise<string> {
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
