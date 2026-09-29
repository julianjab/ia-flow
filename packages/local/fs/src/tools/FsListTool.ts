import { readdir } from 'node:fs/promises'
import { z } from 'zod'
import { FsTool } from '../FsTool.js'

export const FsListInput = z.strictObject({
  path: z.string().optional().describe('Path relativo, default "."'),
})
export type FsListInput = z.infer<typeof FsListInput>

export class FsListTool extends FsTool<typeof FsListInput> {
  readonly name = 'fs_list'
  readonly description =
    `Lista archivos y carpetas de un directorio dentro de ${this.baseDir} (path relativo, default: la raíz).`
  readonly input = FsListInput

  protected async execute(input: FsListInput): Promise<string> {
    const absPath = await this.resolveSafePath(input.path ?? '.')
    const entries = await readdir(absPath, { withFileTypes: true })
    const listing = entries
      .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'dir' : 'file' }))
      .sort((a, b) => a.name.localeCompare(b.name))
    return JSON.stringify(listing)
  }
}
