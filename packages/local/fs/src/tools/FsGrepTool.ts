import { lstat, readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { z } from 'zod'
import { FsTool } from '../FsTool.js'
import { SKIPPED_DIR_NAMES } from '../shared.js'

export const FsGrepInput = z.strictObject({
  pattern: z.string().min(1).describe('Regex (sintaxis JS)'),
  path: z
    .string()
    .optional()
    .describe('Subdirectorio o archivo (relativo) donde buscar, default "."'),
})
export type FsGrepInput = z.infer<typeof FsGrepInput>

const MAX_MATCHES = 200
const MAX_FILES_SCANNED = 5000
/** Archivos más grandes se saltan sin leer — ni el ReDoS ni la memoria son manejables si el
 *  input no tiene un tope. */
const MAX_FILE_BYTES = 2 * 1024 * 1024
/** Una línea más larga que esto no se testea contra el regex — el patrón lo manda el modelo,
 *  nunca confiable, y un patrón con backtracking catastrófico (`(a+)+$`) contra una línea larga
 *  bloquea el event loop sin timeout posible (JS no puede preemptar un regex.test() a mitad de
 *  camino). Acotar el largo de la línea acota el peor caso; NO lo elimina para cualquier patrón
 *  — una garantía real pide correr el match en un worker con `terminate()`, fuera de alcance acá. */
const MAX_LINE_LENGTH = 2000
/** Presupuesto de tiempo total del walk — entre archivos, no puede cortar un regex.test() ya
 *  arrancado, pero evita que muchos archivos "razonables" sumen un tiempo total sin techo. */
const MAX_WALK_MS = 5000

interface Match {
  file: string
  line: number
  text: string
}

interface WalkBudget {
  filesScanned: number
  deadline: number
}

function budgetExhausted(matches: Match[], budget: WalkBudget): boolean {
  return (
    matches.length >= MAX_MATCHES ||
    budget.filesScanned >= MAX_FILES_SCANNED ||
    Date.now() >= budget.deadline
  )
}

async function walk(
  dir: string,
  baseDir: string,
  matches: Match[],
  regex: RegExp,
  budget: WalkBudget,
) {
  if (budgetExhausted(matches, budget)) return
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (budgetExhausted(matches, budget)) return
    // Un symlink NO es `isDirectory()` (eso mira el link, no el target) — sin este check caería
    // en la rama de archivo de abajo y `readFile` seguiría el link, leyendo lo que sea que
    // apunte, DENTRO o fuera de baseDir. `resolveSafePath` ya audita el path de entrada; el
    // walk recursivo tiene que hacer lo mismo con cada entrada que descubre sola.
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      if (SKIPPED_DIR_NAMES.has(entry.name)) continue
      await walk(join(dir, entry.name), baseDir, matches, regex, budget)
      continue
    }
    // Ni symlink ni directorio no alcanza para "es un archivo leíble" — un FIFO (`mkfifo`,
    // armable con `bash_run`), un socket, o un device caen en esta rama igual. `stat` sobre un
    // FIFO no bloquea (sólo lee metadata), pero `readFile` sí: se queda esperando a que algún
    // proceso lo abra en escritura, para SIEMPRE — `MAX_WALK_MS` no ayuda, ese presupuesto sólo
    // se chequea ENTRE archivos, nunca corta un `readFile` ya arrancado.
    if (!entry.isFile()) continue
    await grepFile(join(dir, entry.name), baseDir, matches, regex, budget)
  }
}

/** Una pasada del regex sobre UN archivo regular, con los mismos topes que el walk. */
async function grepFile(
  absPath: string,
  baseDir: string,
  matches: Match[],
  regex: RegExp,
  budget: WalkBudget,
) {
  budget.filesScanned++
  let content: string
  try {
    const info = await stat(absPath)
    if (info.size > MAX_FILE_BYTES) return
    content = await readFile(absPath, 'utf-8')
  } catch {
    return // binario u otro error de lectura — se salta, no se aborta el grep entero
  }
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (matches.length >= MAX_MATCHES) break
    if (lines[i].length > MAX_LINE_LENGTH) continue
    if (regex.test(lines[i])) {
      matches.push({ file: relative(baseDir, absPath), line: i + 1, text: lines[i].trim() })
    }
    regex.lastIndex = 0 // regex global reusada entre líneas — sin esto .test() pisa el cursor
  }
}

export class FsGrepTool extends FsTool<typeof FsGrepInput> {
  readonly name = 'fs_grep'
  readonly description =
    `Busca un patrón (regex) en los archivos de texto dentro de ${this.baseDir}, recursivo — o en un solo archivo, si \`path\` apunta a uno. Salta node_modules/.git/dist/.turbo/.cache, archivos >2MB, y líneas >2000 caracteres.`
  readonly input = FsGrepInput

  protected async execute(input: FsGrepInput): Promise<string> {
    const start = await this.resolveSafePath(input.path ?? '.')
    const baseDir = await this.resolveSafePath('.')
    const regex = new RegExp(input.pattern, 'g')
    const matches: Match[] = []
    const budget = { filesScanned: 0, deadline: Date.now() + MAX_WALK_MS }
    // `path` puede ser un archivo: grepear un archivo puntual (`CLAUDE.md`) es lo natural para el
    // modelo, y antes fallaba con ENOTDIR. `lstat`, no `stat`: lo que no es archivo regular ni
    // directorio (un symlink, un FIFO) se descarta igual que en el walk.
    const info = await lstat(start)
    if (info.isFile()) await grepFile(start, baseDir, matches, regex, budget)
    else if (info.isDirectory()) await walk(start, baseDir, matches, regex, budget)
    return JSON.stringify(matches)
  }
}
