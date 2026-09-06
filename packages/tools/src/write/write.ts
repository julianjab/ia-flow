// Write/edit tools — sandboxed to `ToolContext.writePaths` (populated by the
// WorkspaceManager for API-driven providers). Async terminal providers don't
// build that scope and never see these tools; the sync anthropic-api provider
// is currently the only registered caller. Both tools mutate the filesystem,
// so every code path funnels through `resolveWritePath` → `assertInWritePaths`
// before touching disk.
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { ToolContext } from '../contract.js'
import { registerTool } from '../engine.js'
import { createLogger } from '../logger.js'

const log = createLogger('tool-write')

/**
 * Refuses writes when no writePaths are configured, or when the resolved
 * absolute path falls outside every configured writePath prefix. The two
 * error messages are stable, machine-parseable strings — tests and callers
 * match on them, so change with care.
 */
function assertInWritePaths(absPath: string, writePaths: string[] | undefined): void {
  if (!writePaths || writePaths.length === 0) {
    throw new Error('writePaths vacío: escritura no permitida en fase actual')
  }
  const ok = writePaths.some((root) => {
    const rootAbs = resolve(root)
    return absPath === rootAbs || absPath.startsWith(rootAbs + '/')
  })
  if (!ok) throw new Error('escritura no permitida en fase actual')
}

/**
 * Local resolver: turns the tool input (`<repo>/rel/path` or absolute) into
 * an absolute path and validates it against `ctx.writePaths`. Kept private
 * to `write.ts` rather than reusing `resolvePath` from `fs.ts` — that helper
 * validates against `repoPaths`, which is a strictly wider scope than
 * `writePaths` and would let writes escape the sandbox.
 */
function resolveWritePath(input: string, ctx: ToolContext): string {
  const abs = toAbsolute(input, ctx.repoPaths)
  assertInWritePaths(abs, ctx.writePaths)
  return abs
}

/**
 * Si el agente declaró una política DSL (`ctx.policy`, compilada por
 * `compilePolicy`), el gate sólo tiene sentido cuando `fs_read` está entre
 * sus tools — exigirle leer una tool que no tiene es un callejón sin salida:
 * un agente con `fs_write`/`fs_edit` pero sin `fs_read` en su `tools[]`
 * (combinación válida hoy — son opt-in independientes) quedaría incapaz de
 * sobrescribir CUALQUIER archivo existente para siempre. Sin política (un
 * agente legacy sin DSL, o un test que arma `ctx` a mano) no hay forma de
 * saber qué tools tiene el agente, así que el gate se mantiene activo — el
 * comportamiento por default, más conservador.
 */
function fsReadAvailable(ctx: ToolContext): boolean {
  return !ctx.policy || ctx.policy.toolNames.has('fs_read')
}

/**
 * Exige que `fs_read` haya leído este path en el run actual antes de tocarlo.
 * Sólo se activa cuando `ctx.readPaths` está seteado — `undefined` significa
 * que el gate no aplica acá (el MCP async, o un test viejo sin el campo) — y
 * cuando el agente puede efectivamente satisfacerlo (`fsReadAvailable`). Un
 * archivo nuevo no pasa por acá: crear no tiene memoria previa que exigir.
 */
function assertReadBeforeEdit(abs: string, ctx: ToolContext, inputPath: string): void {
  if (ctx.readPaths && fsReadAvailable(ctx) && !ctx.readPaths.has(abs)) {
    throw new Error(`leé ${inputPath} antes de editarlo`)
  }
}

/**
 * Detecta `content` que arrastra los prefijos "N\t" que `fs_read` agrega
 * como display. `fs_write` no valida nada más allá del sandbox (a diferencia
 * de `fs_edit`, que falla ruidosamente si `old_string` no matchea), así que
 * un agente que copia el output numerado de un `fs_read` y lo pasa tal cual
 * como `content` corrompe el archivo en silencio — cada línea real queda
 * corrida por su propio número. Rechazar cuando la MAYORÍA de las líneas no
 * vacías matchean el patrón evita eso sin falsos positivos: código real casi
 * nunca arranca sus líneas con "dígitos + tab".
 */
function looksLikeNumberedOutput(content: string): boolean {
  const lines = content.split('\n').filter((l) => l.length > 0)
  if (lines.length < 3) return false
  const numbered = lines.filter((l) => /^\d+\t/.test(l)).length
  return numbered / lines.length > 0.5
}

function assertNotNumberedOutput(content: string, inputPath: string): void {
  if (looksLikeNumberedOutput(content)) {
    throw new Error(
      `el content de ${inputPath} parece traer los prefijos "N\\t" de fs_read — sacalos antes de escribir`,
    )
  }
}

function toAbsolute(path: string, repoPaths: Record<string, string>): string {
  if (path.startsWith('/')) return resolve(path)
  for (const [name, root] of Object.entries(repoPaths)) {
    if (path === name || path.startsWith(name + '/')) {
      const rel = path === name ? '' : path.slice(name.length + 1)
      return resolve(root, rel)
    }
  }
  throw new Error(
    `Cannot resolve path '${path}'. Use '<repo-name>/relative/path' or an absolute path.`,
  )
}

/**
 * Count non-overlapping occurrences of `needle` in `haystack`. Preferred
 * over `haystack.split(needle).length - 1` because that allocates the full
 * split array; the manual loop is O(n) time and O(1) extra space, which
 * matters for large source files.
 */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let idx = 0
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++
    idx += needle.length
  }
  return count
}

// ─── write_file ────────────────────────────────────────────────────────────

registerTool({
  name: 'fs_write',
  aliases: ['write_file'],
  description:
    'Create or overwrite a file inside the allowed writePaths. Parent directories are created ' +
    'as needed. Use "<repo-name>/relative/path" or an absolute path. Overwriting an existing ' +
    'file requires having read it first with fs_read in this same run — and if you did, strip ' +
    'the "N\\t" line-number prefixes fs_read added before passing the content back here; they ' +
    'are a display, not part of the file, and writing them in corrupts it.',
  apiOnly: true,
  input_schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path: "<repo-name>/relative/path" or absolute',
      },
      content: {
        type: 'string',
        description: 'Full file contents to write (any existing file is overwritten)',
      },
    },
    required: ['path', 'content'],
  },
  async execute(input: any, ctx: ToolContext): Promise<string> {
    const abs = resolveWritePath(input.path, ctx)
    if (existsSync(abs)) assertReadBeforeEdit(abs, ctx, input.path)
    const content = typeof input.content === 'string' ? input.content : ''
    assertNotNumberedOutput(content, input.path)
    await mkdir(dirname(abs), { recursive: true })
    await Bun.write(abs, content)
    // El propio run acaba de escribir este contenido — cuenta como lectura,
    // así que un fs_edit/fs_write posterior sobre el mismo path (corrigiendo
    // un typo, por ejemplo) no exige releerlo primero.
    ctx.readPaths?.add(abs)
    log.info(
      {
        path: input.path,
        bytes: content.length,
        runId: ctx.runId,
        agent: ctx.agentId,
        taskId: ctx.taskId,
      },
      'write_file',
    )
    return `Archivo escrito: ${input.path}`
  },
})

// ─── edit_file ─────────────────────────────────────────────────────────────

registerTool({
  name: 'fs_edit',
  aliases: ['edit_file'],
  description:
    'Replace an exact substring in an existing file inside writePaths. Fails if old_string is ' +
    'absent, or if it appears more than once and replace_all=false. Requires having read the ' +
    'file first with fs_read in this same run.',
  apiOnly: true,
  input_schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path: "<repo-name>/relative/path" or absolute',
      },
      old_string: { type: 'string', description: 'Exact substring to replace' },
      new_string: { type: 'string', description: 'Replacement string' },
      replace_all: {
        type: 'boolean',
        description: 'When true, replace every occurrence (default false)',
      },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  async execute(input: any, ctx: ToolContext): Promise<string> {
    const abs = resolveWritePath(input.path, ctx)
    // Chequeo de existencia ANTES del gate de lectura: si el path no existe,
    // el motivo real es "no existe" y no "no lo leíste" — reportar el gate
    // acá manda al agente a un fs_read que le va a devolver "File not
    // found", y de vuelta a fs_edit, en un loop sin salida.
    if (!existsSync(abs)) {
      throw new Error(`${input.path} no existe — usá fs_write para crear un archivo nuevo`)
    }
    assertReadBeforeEdit(abs, ctx, input.path)
    const oldStr = String(input.old_string ?? '')
    const newStr = String(input.new_string ?? '')
    const replaceAll = input.replace_all === true

    // No MAX_FILE_BYTES ceiling here — edit_file writes back what it read, so
    // the tokens-into-context concern that motivates read_file's cap doesn't
    // apply. If we ever want to bound edit_file memory, cap it here explicitly.
    const current = await readFile(abs, 'utf-8')
    const count = countOccurrences(current, oldStr)
    if (count === 0) {
      throw new Error(`old_string no encontrado en ${input.path}`)
    }
    if (count > 1 && !replaceAll) {
      throw new Error(
        `old_string aparece ${count} veces en ${input.path}; usar replace_all=true para reemplazar todas`,
      )
    }

    // `String.prototype.replace` with a string arg only replaces the first
    // occurrence (no `g` flag semantics). For the "replace every" branch we
    // use `split`/`join`, which handles overlapping-free replacement without
    // a RegExp allocation.
    const updated = replaceAll
      ? current.split(oldStr).join(newStr)
      : current.replace(oldStr, newStr)
    await Bun.write(abs, updated)
    // Ya pasó el gate y este run tiene el contenido actualizado en mano — un
    // segundo fs_edit sobre el mismo path (otra corrección seguida) no
    // debería exigir un fs_read intermedio que sólo releería lo que ya sabe.
    ctx.readPaths?.add(abs)
    log.info(
      {
        path: input.path,
        replacements: replaceAll ? count : 1,
        replaceAll,
        runId: ctx.runId,
        agent: ctx.agentId,
        taskId: ctx.taskId,
      },
      'edit_file',
    )
    return `Edición aplicada: ${input.path}`
  },
})
