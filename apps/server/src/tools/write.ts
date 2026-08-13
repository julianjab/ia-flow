// Write/edit tools — sandboxed to `ToolContext.writePaths` (populated by the
// WorkspaceManager for API-driven providers). Async terminal providers don't
// build that scope and never see these tools; the sync anthropic-api provider
// is currently the only registered caller. Both tools mutate the filesystem,
// so every code path funnels through `resolveWritePath` → `assertInWritePaths`
// before touching disk.
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createLogger } from '../logger.js'
import { type ToolContext, registerTool } from './index.js'

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
  name: 'write_file',
  description:
    'Create or overwrite a file inside the allowed writePaths. Parent directories are created as needed. Use "<repo-name>/relative/path" or an absolute path.',
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
    const content = typeof input.content === 'string' ? input.content : ''
    await mkdir(dirname(abs), { recursive: true })
    await Bun.write(abs, content)
    log.info({ path: input.path, bytes: content.length }, 'write_file')
    return `Archivo escrito: ${input.path}`
  },
})

// ─── edit_file ─────────────────────────────────────────────────────────────

registerTool({
  name: 'edit_file',
  description:
    'Replace an exact substring in an existing file inside writePaths. Fails if old_string is absent, or if it appears more than once and replace_all=false.',
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
    log.info(
      { path: input.path, replacements: replaceAll ? count : 1, replaceAll },
      'edit_file',
    )
    return `Edición aplicada: ${input.path}`
  },
})
