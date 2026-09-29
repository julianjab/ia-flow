import { readFile, stat, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import { FsTool } from '../FsTool.js'

export const FsEditInput = z.strictObject({
  path: z.string().describe('Path relativo a la raíz del worktree'),
  oldString: z.string().min(1).describe('Texto exacto a reemplazar'),
  newString: z.string().describe('Texto de reemplazo'),
  replaceAll: z.boolean().optional().describe('Reemplazar todas las ocurrencias, default false'),
})
export type FsEditInput = z.infer<typeof FsEditInput>

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0
  let count = 0
  let from = 0
  while (true) {
    const idx = haystack.indexOf(needle, from)
    if (idx === -1) break
    count++
    from = idx + needle.length
  }
  return count
}

export class FsEditTool extends FsTool<typeof FsEditInput> {
  readonly name = 'fs_edit'
  readonly description =
    `Reemplaza \`oldString\` por \`newString\` en un archivo dentro de ${this.baseDir} — tira si \`oldString\` no aparece, o aparece más de una vez sin \`replaceAll\`.`
  readonly input = FsEditInput

  protected async execute(input: FsEditInput): Promise<string> {
    const absPath = await this.resolveSafePath(input.path)
    // `readFile` sobre un FIFO (armable con `bash_run "mkfifo p"`) se queda esperando para
    // siempre a que algo lo abra en escritura — mismo problema que ya se cerró en fs_read/
    // fs_grep. `stat` nunca bloquea así, y filtra sockets/devices de paso.
    const info = await stat(absPath)
    if (!info.isFile()) {
      throw new Error(`fs_edit: "${input.path}" no es un archivo regular`)
    }
    const content = await readFile(absPath, 'utf-8')
    const occurrences = countOccurrences(content, input.oldString)
    if (occurrences === 0) {
      throw new Error(`fs_edit: "${input.oldString}" no aparece en ${input.path}`)
    }
    if (occurrences > 1 && !input.replaceAll) {
      throw new Error(
        `fs_edit: "${input.oldString}" aparece ${occurrences} veces en ${input.path} — agregá más contexto para que sea único, o pasá replaceAll: true`,
      )
    }
    // Replacer function, no el 2do arg string: `content.replace(old, newString)` interpreta
    // los patrones especiales de String.prototype.replace ($$, $&, $`, $', $1) DENTRO de
    // newString — un newString real como "echo $$" o "x = $&" quedaría corrompido. `split/join`
    // (rama replaceAll) ya es literal por diseño; acá hace falta la función para el mismo efecto.
    const updated = input.replaceAll
      ? content.split(input.oldString).join(input.newString)
      : content.replace(input.oldString, () => input.newString)
    await writeFile(absPath, updated, 'utf-8')
    return `Editado: ${input.path} (${occurrences} ocurrencia${occurrences > 1 ? 's' : ''})`
  }
}
