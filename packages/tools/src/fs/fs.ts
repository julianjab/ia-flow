import { existsSync } from 'node:fs'
// Filesystem tools — scoped to registered repo paths only
import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, join, relative, resolve } from 'node:path'
import type { ToolContext } from '../contract.js'
import { registerTool } from '../engine.js'
import { askHaiku } from '../haiku.js'
import { createLogger } from '../logger.js'
import { FILE_FOCUS_PROMPT } from './focus-prompt.js'
import { isIgnored } from './gitignore.js'

const log = createLogger('tool-fs')

/** Tope de lo que `fs_read` devuelve crudo. Arriba de esto, sin `focus`, va
 *  la cabecera más una nota para paginar o enfocar. */
const MAX_FILE_BYTES = 40_000
/** Debajo de esto un `focus` no vale la vuelta a Haiku: el archivo entra
 *  entero y el agente lo filtra solo. */
const FILE_FOCUS_THRESHOLD = 15_000
/** Lo que Haiku ve como máximo. Más allá, el resultado avisa que la
 *  extracción es parcial. */
const MAX_FOCUS_INPUT_BYTES = 150_000
const MAX_GREP_RESULTS = 30

/**
 * Interruptor global del `focus` con Haiku. `IA_FLOW_FILE_SIMPLIFIER=0`
 * (o `false`/`no`/`off`) lo apaga; ausente = prendido. En el flavor runner
 * lo setea `settings.fileSimplifier` del runner.yaml (`applyRunnerEnv`). Se
 * lee por llamada, no al importar, por la misma razón que la credencial.
 */
export const FILE_SIMPLIFIER_ENV = 'IA_FLOW_FILE_SIMPLIFIER'

function isFocusEnabled(ctx: ToolContext): boolean {
  if (ctx.fileSimplifierEnabled !== undefined) return ctx.fileSimplifierEnabled
  const raw = Bun.env[FILE_SIMPLIFIER_ENV]
  if (raw === undefined || raw === '') return true
  return !['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase())
}

function numberLines(content: string): string {
  return content
    .split('\n')
    .map((l, i) => `${i + 1}\t${l}`)
    .join('\n')
}

/** Sin `focus` y arriba del tope: la cabecera hasta `MAX_FILE_BYTES` y una
 *  nota con el tamaño real, para que el agente pagine o enfoque. */
function headWithNotice(content: string, path: string, reason?: string): string {
  const total = content.split('\n').length
  const head = content.slice(0, MAX_FILE_BYTES)
  const shown = head.split('\n').length
  const why = reason ? ` (${reason})` : ''
  return (
    head +
    `\n\n[${path}: ${content.length} bytes, ${total} lines — showing lines 1-${shown}${why}. ` +
    'Use offset/limit to page, or pass focus to get only the parts you need.]'
  )
}

async function focusWithHaiku(content: string, path: string, focus: string): Promise<string> {
  const partial = content.length > MAX_FOCUS_INPUT_BYTES
  const analysed = partial ? content.slice(0, MAX_FOCUS_INPUT_BYTES) : content
  const user = `File: ${path}\nReader needs: ${focus}\n\n${numberLines(analysed)}`
  try {
    const { text } = await askHaiku({
      system: FILE_FOCUS_PROMPT,
      user,
      maxTokens: 8192,
      scope: { tool: 'fs_read', filePath: path, contentBytes: content.length, focus },
    })
    const coverage = partial
      ? ` — only the first ${analysed.split('\n').length} of ${content.split('\n').length} lines were analysed; use offset to read the rest`
      : ''
    return `[focus: ${focus} — ${content.length}B → ${text.length}B${coverage}]\n${text}`
  } catch (err) {
    // Un focus que no se pudo resolver no debe voltear el run: el agente
    // recibe lo mismo que sin focus, con el motivo, y decide cómo seguir.
    log.warn(
      { filePath: path, err: err instanceof Error ? err.message : String(err) },
      'fs_read focus failed, returning head',
    )
    return headWithNotice(content, path, 'focus unavailable')
  }
}

function resolveRepoPaths(repoPaths: Record<string, string>): string[] {
  return Object.values(repoPaths).map((p) => resolve(p))
}

function assertInRepo(absPath: string, repoPaths: Record<string, string>): void {
  const roots = resolveRepoPaths(repoPaths)
  const safe = roots.some((root) => absPath.startsWith(root + '/') || absPath === root)
  if (!safe) throw new Error(`Access denied: path is outside registered repos`)
}

function resolvePath(path: string, repoPaths: Record<string, string>): string {
  // Accept: absolute path, or "repo-name/relative/path"
  if (path.startsWith('/')) {
    const abs = resolve(path)
    assertInRepo(abs, repoPaths)
    return abs
  }
  // Try repo-name prefix. Accept both `<repo>` (bare) and `<repo>/<subpath>` —
  // bare form resolves to the repo root, which agents commonly want when
  // starting exploration ("list the top of the repo").
  for (const [name, root] of Object.entries(repoPaths)) {
    if (path === name || path.startsWith(name + '/')) {
      const rel = path === name ? '' : path.slice(name.length + 1)
      return resolve(root, rel)
    }
  }
  throw new Error(
    `Cannot resolve path '${path}'. Use '<repo-name>/relative/path' or an absolute path.\n` +
      `Available repos: ${Object.keys(repoPaths).join(', ')}`,
  )
}

// ─── read_file ────────────────────────────────────────────────────────────

registerTool({
  name: 'fs_read',
  aliases: ['read_file'],
  description:
    'Read a file in one of the task repos. Use "<repo-name>/path/to/file" format. ' +
    'Small files come back whole. For a large file, pass `focus` describing what you need ' +
    '(e.g. "the test conventions and the package layout") and you get only the matching ' +
    'parts, quoted verbatim with their line ranges; without `focus`, a large file is cut at ' +
    `${MAX_FILE_BYTES} bytes and you are told how to page with offset/limit.`,
  input_schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path: "<repo-name>/relative/path" or absolute path',
      },
      focus: {
        type: 'string',
        description:
          'What you need from the file, in one sentence. Only the parts that answer it are ' +
          'returned, verbatim, with line ranges. Omit to read the file as-is.',
      },
      offset: {
        type: 'number',
        description: 'Line number to start reading from (1-indexed, optional)',
      },
      limit: { type: 'number', description: 'Max number of lines to read (optional)' },
    },
    required: ['path'],
  },
  async execute(input: any, ctx: ToolContext): Promise<string> {
    const abs = resolvePath(input.path, ctx.repoPaths)
    if (!existsSync(abs)) return `File not found: ${input.path}`

    const s = await stat(abs)
    if (s.isDirectory()) return `Path is a directory. Use list_dir instead.`

    const content = await readFile(abs, 'utf-8')

    if (input.offset || input.limit) {
      const lines = content.split('\n')
      const start = Math.max(0, (input.offset ?? 1) - 1)
      const end = input.limit ? start + input.limit : lines.length
      return lines
        .slice(start, end)
        .map((l, i) => `${start + i + 1}\t${l}`)
        .join('\n')
    }

    const focus = typeof input.focus === 'string' ? input.focus.trim() : ''
    if (focus && Buffer.byteLength(content) > FILE_FOCUS_THRESHOLD) {
      if (isFocusEnabled(ctx)) return focusWithHaiku(content, input.path, focus)
      return content.length > MAX_FILE_BYTES
        ? headWithNotice(content, input.path, 'focus disabled')
        : content
    }

    return content.length > MAX_FILE_BYTES ? headWithNotice(content, input.path) : content
  },
})

// ─── list_dir ─────────────────────────────────────────────────────────────

registerTool({
  name: 'fs_list',
  aliases: ['list_dir'],
  description: 'List files and directories at a path in one of the task repos.',
  input_schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Directory path: "<repo-name>/relative/path" or absolute',
      },
    },
    required: ['path'],
  },
  async execute(input: any, ctx: ToolContext): Promise<string> {
    const abs = resolvePath(input.path, ctx.repoPaths)
    if (!existsSync(abs)) return `Path not found: ${input.path}`

    const entries = await readdir(abs, { withFileTypes: true })
    const lines = entries
      .filter((e) => {
        if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '__pycache__') {
          return false
        }
        return !isIgnored(join(abs, e.name), ctx.repoPaths)
      })
      .map((e) => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`)
    return lines.join('\n') || '(empty directory)'
  },
})

// ─── grep_files ───────────────────────────────────────────────────────────

interface GrepInput {
  pattern: string
  path: string
  glob?: string
  case_insensitive?: boolean
}

/**
 * Test-only seam. Overriding `which` in tests lets us simulate rg being
 * missing on PATH (ENOENT) without touching global Bun state. In production
 * this delegates to `Bun.which`.
 */
export const _grepInternals: { which: (cmd: string) => string | null } = {
  which: (cmd: string) => Bun.which(cmd),
}

/**
 * Convert a filename glob into an anchored RegExp. Escapes regex
 * metacharacters, translates `*` → `.*` and `?` → `.`, and anchors with
 * `^…$` so `*.ts` matches `foo.ts` but not `foo.tsx` nor any name that
 * happens to contain the substring `ts`. Best-effort parity with the
 * simple globs ripgrep receives from agents (`*.ts`, `*.test.ts`, `*.py`).
 */
function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const pattern = escaped.replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp('^' + pattern + '$')
}

/**
 * JS-based recursive walk. Kept as fallback for environments without
 * ripgrep installed. Behaviour is identical to the pre-rg implementation:
 * skips node_modules/.git/dist/__pycache__/vendor, honours .gitignore,
 * stops at MAX_GREP_RESULTS globally.
 *
 * When `path` points to a single file, only that file is searched (parity
 * with `grepWithRg`, which passes the file as the search target to rg).
 */
async function grepWithJs(input: GrepInput, ctx: ToolContext): Promise<string[]> {
  const abs = resolvePath(input.path, ctx.repoPaths)
  // No `g` flag: `regex.test(line)` in a loop with `g` is stateful —
  // `lastIndex` carries between calls and can silently skip matches on
  // subsequent lines when the previous match's end position is beyond the
  // next line's length. We never use exec/matchAll on this RegExp, so `g`
  // buys us nothing and is actively harmful for correctness.
  const flags = input.case_insensitive ? 'i' : ''
  const regex = new RegExp(input.pattern, flags)
  const globRe = input.glob ? globToRegex(input.glob) : null

  const results: string[] = []

  async function matchFile(full: string, name: string): Promise<void> {
    if (results.length >= MAX_GREP_RESULTS) return
    if (globRe && !globRe.test(name)) return
    if (isIgnored(full, ctx.repoPaths)) return
    try {
      const content = await readFile(full, 'utf-8')
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          const root = Object.entries(ctx.repoPaths).find(([, p]) => full.startsWith(p))?.[0] ?? ''
          const rel = root ? relative(ctx.repoPaths[root], full) : full
          results.push(`${root}/${rel}:${i + 1}: ${lines[i].trim()}`)
          if (results.length >= MAX_GREP_RESULTS) return
        }
      }
    } catch {
      /* skip binary files */
    }
  }

  async function search(dir: string): Promise<void> {
    if (results.length >= MAX_GREP_RESULTS) return
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (results.length >= MAX_GREP_RESULTS) return
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (['node_modules', '.git', 'dist', '__pycache__', 'vendor'].includes(e.name)) continue
        if (isIgnored(full, ctx.repoPaths)) continue
        await search(full)
      } else {
        await matchFile(full, e.name)
      }
    }
  }

  const s = await stat(abs).catch(() => null)
  if (s?.isDirectory()) {
    await search(abs)
  } else if (s?.isFile()) {
    // Parity with rg: when a file path is provided, search only that file.
    await matchFile(abs, basename(abs))
  }
  return results
}

/**
 * ripgrep-backed grep. Spawns `rg` with the mapped flags and cwd rooted at
 * the owning repo, then normalises `<rel>:<line>:<match>` output into the
 * canonical `<repo>/<rel>:<line>: <match>` shape.
 *
 * Returns `null` to signal the caller should fall back to `grepWithJs`:
 *   - rg not on PATH (Bun.which → null)
 *   - Bun.spawn threw synchronously (ENOENT and friends)
 *   - rg exited with an error code (not 0 = matches, not 1 = no matches)
 *   - the owning repo could not be determined
 */
async function grepWithRg(input: GrepInput, ctx: ToolContext): Promise<string[] | null> {
  const rgPath = _grepInternals.which('rg')
  if (!rgPath) return null

  const abs = resolvePath(input.path, ctx.repoPaths)
  const owner = Object.entries(ctx.repoPaths).find(([, p]) => abs === p || abs.startsWith(p + '/'))
  if (!owner) return null
  const [repoName, repoRoot] = owner
  const searchTarget = relative(repoRoot, abs) || '.'

  const args = [
    '--regexp',
    input.pattern,
    '--line-number',
    '--no-heading',
    '--color',
    'never',
    '--max-count',
    String(MAX_GREP_RESULTS),
  ]
  if (input.case_insensitive) args.push('--ignore-case')
  if (input.glob) args.push('--glob', input.glob)
  // Parity with the JS walk's explicit directory exclusions. rg already
  // respects .gitignore, but many repos don't ignore build/vendor dirs.
  for (const dir of ['node_modules', 'dist', '__pycache__', 'vendor']) {
    args.push('--glob', `!${dir}`)
  }
  args.push(searchTarget)

  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn([rgPath, ...args], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch (err) {
    log.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'rg spawn failed, falling back to JS walk',
    )
    return null
  }

  const stdout = await new Response(proc.stdout as ReadableStream<Uint8Array>).text()
  const exitCode = await proc.exited
  // rg exit codes: 0 = matches, 1 = no matches, 2 = error
  if (exitCode !== 0 && exitCode !== 1) {
    log.debug({ exitCode }, 'rg errored, falling back to JS walk')
    return null
  }

  const results: string[] = []
  for (const rawLine of stdout.split('\n')) {
    if (!rawLine) continue
    // rg output shape: <path>:<lineno>:<content>
    const idx1 = rawLine.indexOf(':')
    if (idx1 === -1) continue
    const idx2 = rawLine.indexOf(':', idx1 + 1)
    if (idx2 === -1) continue
    const path = rawLine.slice(0, idx1)
    const lineno = rawLine.slice(idx1 + 1, idx2)
    const content = rawLine.slice(idx2 + 1)
    if (!/^\d+$/.test(lineno)) continue
    results.push(`${repoName}/${path}:${lineno}: ${content.trim()}`)
    if (results.length >= MAX_GREP_RESULTS) break
  }
  return results
}

// Exported for parity tests.
export { grepWithJs, grepWithRg }

registerTool({
  name: 'fs_grep',
  aliases: ['grep_files'],
  description: 'Search for a pattern (regex or literal string) in files within a repo path.',
  input_schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Search pattern (regex)' },
      path: { type: 'string', description: 'Directory or file to search in: "<repo-name>/path"' },
      glob: { type: 'string', description: 'File glob filter, e.g. "*.ts" (optional)' },
      case_insensitive: { type: 'boolean', description: 'Case-insensitive search (default false)' },
    },
    required: ['pattern', 'path'],
  },
  async execute(input: any, ctx: ToolContext): Promise<string> {
    let results: string[] | null = null
    try {
      results = await grepWithRg(input as GrepInput, ctx)
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'rg backend threw, falling back to JS walk',
      )
      results = null
    }
    if (results === null) {
      results = await grepWithJs(input as GrepInput, ctx)
    }

    if (results.length === 0) return `No matches found for '${input.pattern}'`
    const header = results.length >= MAX_GREP_RESULTS ? `[First ${MAX_GREP_RESULTS} matches]\n` : ''
    return header + results.join('\n')
  },
})
