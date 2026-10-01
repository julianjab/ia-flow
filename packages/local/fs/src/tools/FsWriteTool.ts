import { mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { FsTool } from '../FsTool.js'

export const FsWriteInput = z.strictObject({
  path: z.string().describe('Path relativo a la raíz del worktree'),
  content: z.string().describe('Contenido completo del archivo'),
})
export type FsWriteInput = z.infer<typeof FsWriteInput>

export class FsWriteTool extends FsTool<typeof FsWriteInput> {
  readonly name = 'fs_write'
  readonly description =
    `Escribe (crea o sobreescribe por completo) un archivo dentro de ${this.baseDir} (path relativo).`
  readonly input = FsWriteInput

  protected async execute(input: FsWriteInput): Promise<string> {
    const absPath = await this.resolveSafePath(input.path)
    // Abrir un FIFO existente (armable con `bash_run "mkfifo p"`) en escritura se queda
    // esperando para siempre a que algo lo abra en lectura — `writeFile` colgaría igual que
    // `readFile` en fs_read/fs_grep/fs_edit. ENOENT (el caso normal: archivo nuevo) sigue de
    // largo; sólo se rechaza cuando YA existe algo ahí y no es un archivo regular.
    const existing = await stat(absPath).catch(() => undefined)
    if (existing && !existing.isFile()) {
      throw new Error(`fs_write: "${input.path}" ya existe y no es un archivo regular`)
    }
    await mkdir(dirname(absPath), { recursive: true })
    await writeFile(absPath, input.content, 'utf-8')
    return `Escrito: ${input.path} (${Buffer.byteLength(input.content, 'utf-8')} bytes)`
  }
}
