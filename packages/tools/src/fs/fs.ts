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
/** Página por defecto que se devuelve de una sola vez. Subir esto por sobre
 *  el tope anterior (30) reduce las vueltas de paginado en el caso común. */
const DEFAULT_GREP_LIMIT = 100
/** Techo interno de matches que se juntan antes de paginar/cortar. Evita
 *  que un patrón demasiado amplio en un monorepo grande cuelgue la tool. */
const GREP_SAFETY_CAP = 2000
/** Igual que `GREP_SAFETY_CAP`, pero para `fs_glob` — ahí el límite es
 *  cuántos paths devolver, no matches. */
const GLOB_MAX_RESULTS = 200

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

async function focusWithHaiku(
  content: string,
  path: string,
  focus: string,
  ctx: ToolContext,
): Promise<string> {
  const partial = content.length > MAX_FOCUS_INPUT_BYTES
  const analysed = partial ? content.slice(0, MAX_FOCUS_INPUT_BYTES) : content
  const user = `File: ${path}\nReader needs: ${focus}\n\n${numberLines(analysed)}`
  // Corre en runs sync (`anthropic-api`) y async (el MCP `ia-flow-tools`), y
  // sólo el primero cuelga un logger por-run de `ctx` — de ahí el fallback a
  // ids sueltos. En los dos casos el `runId`/`taskId`/`agentId` de `ctx` es lo
  // que permite cruzar esta llamada con el resto del log del run.
  const logCtx = {
    runId: ctx.runId,
    agent: ctx.agentId,
    projectId: ctx.projectId,
    taskId: ctx.taskId,
  }
  try {
    const { text } = await askHaiku({
      system: FILE_FOCUS_PROMPT,
      user,
      maxTokens: 8192,
      scope: { tool: 'fs_read', filePath: path, contentBytes: content.length, focus, ...logCtx },
    })
    const coverage = partial
      ? ` — only the first ${analysed.split('\n').length} of ${content.split('\n').length} lines were analysed; use offset to read the rest`
      : ''
    return `[focus: ${focus} — ${content.length}B → ${text.length}B${coverage}]\n${text}`
  } catch (err) {
    // Un focus que no se pudo resolver no debe voltear el run: el agente
    // recibe lo mismo que sin focus, con el motivo, y decide cómo seguir.
    log.warn(
      { filePath: path, ...logCtx, err: err instanceof Error ? err.message : String(err) },
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
      if (isFocusEnabled(ctx)) return focusWithHaiku(content, input.path, focus, ctx)
      return content.length > MAX_FILE_BYTES
        ? headWithNotice(content, input.path, 'focus disabled')
        : content
    }

    return content.length > MAX_FILE_BYTES ? headWithNotice(content, input.path) : content
  },
})

// ─── list_dir ─────────────────────────────────────────────────────────────

/** Excluidos siempre, dotfiles incluidos o no: no aportan nada listarlos y
 *  `node_modules`/`__pycache__` pueden ser enormes. Un `.github/` o un
 *  `.env.example` NO están acá a propósito — ver PRD #138. */
const HARD_EXCLUDED_DIRS = new Set(['.git', 'node_modules', '__pycache__'])

async function listTree(
  abs: string,
  rel: string,
  depth: number,
  ctx: ToolContext,
  out: string[],
): Promise<void> {
  const entries = await readdir(abs, { withFileTypes: true })
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const e of entries) {
    if (HARD_EXCLUDED_DIRS.has(e.name)) continue
    const full = join(abs, e.name)
    if (isIgnored(full, ctx.repoPaths)) continue
    const relPath = rel ? `${rel}/${e.name}` : e.name
    out.push(`${e.isDirectory() ? 'd' : 'f'} ${relPath}`)
    if (e.isDirectory() && depth > 1) {
      await listTree(full, relPath, depth - 1, ctx, out)
    }
  }
}

registerTool({
  name: 'fs_list',
  aliases: ['list_dir'],
  description:
    'List files and directories at a path in one of the task repos. Dotfiles and ' +
    'dot-directories are shown (e.g. ".github", ".env.example") — only .git, node_modules ' +
    "and __pycache__ are excluded, plus whatever the repo's .gitignore ignores. Pass `depth` " +
    '> 1 to recurse and get the tree for several levels in one call.',
  input_schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Directory path: "<repo-name>/relative/path" or absolute',
      },
      depth: {
        type: 'number',
        description: 'How many levels deep to recurse (default 1, no recursion)',
      },
    },
    required: ['path'],
  },
  async execute(input: any, ctx: ToolContext): Promise<string> {
    const abs = resolvePath(input.path, ctx.repoPaths)
    if (!existsSync(abs)) return `Path not found: ${input.path}`

    const depth = Math.max(1, Math.trunc(input.depth ?? 1))
    const lines: string[] = []
    await listTree(abs, '', depth, ctx, lines)
    return lines.join('\n') || '(empty directory)'
  },
})

// ─── grep_files ───────────────────────────────────────────────────────────

interface GrepInput {
  pattern: string
  path: string
  glob?: string
  case_insensitive?: boolean
  /** Líneas de contexto antes/después de cada match, como `rg -C`. */
  context_lines?: number
  /** Sólo la lista de archivos con matches, sin contenido, como `rg -l`. */
  files_only?: boolean
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
/**
 * JS-based recursive walk. Kept as fallback for environments without
 * ripgrep installed. Behaviour is identical to the pre-rg implementation:
 * skips node_modules/.git/dist/__pycache__/vendor, honours .gitignore,
 * stops at `GREP_SAFETY_CAP` globally.
 *
 * Each array entry is one self-contained match "block": a single line
 * `<repo>/<rel>:<line>: <content>` when `context_lines` is unset (identical
 * to the pre-context format, so old callers/tests see no change), or that
 * line plus its surrounding `<repo>/<rel>-<line>- <content>` context lines
 * joined with `\n` when `context_lines` is set. With `files_only`, entries
 * are bare `<repo>/<rel>` file labels instead, one per matching file.
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
  const contextLines = Math.max(0, Math.trunc(input.context_lines ?? 0))
  const filesOnly = !!input.files_only

  const results: string[] = []
  const matchedFiles: string[] = []

  async function matchFile(full: string, name: string): Promise<void> {
    if (results.length >= GREP_SAFETY_CAP) return
    if (globRe && !globRe.test(name)) return
    if (isIgnored(full, ctx.repoPaths)) return
    try {
      const content = await readFile(full, 'utf-8')
      const lines = content.split('\n')
      const root = Object.entries(ctx.repoPaths).find(([, p]) => full.startsWith(p))?.[0] ?? ''
      const rel = root ? relative(ctx.repoPaths[root], full) : full
      const label = `${root}/${rel}`
      let hasMatch = false
      for (let i = 0; i < lines.length; i++) {
        if (!regex.test(lines[i])) continue
        hasMatch = true
        if (filesOnly) break
        const start = Math.max(0, i - contextLines)
        const end = Math.min(lines.length - 1, i + contextLines)
        const block: string[] = []
        for (let j = start; j < i; j++) block.push(`${label}-${j + 1}- ${lines[j].trim()}`)
        block.push(`${label}:${i + 1}: ${lines[i].trim()}`)
        for (let j = i + 1; j <= end; j++) block.push(`${label}-${j + 1}- ${lines[j].trim()}`)
        results.push(block.join('\n'))
        if (results.length >= GREP_SAFETY_CAP) return
      }
      if (filesOnly && hasMatch) matchedFiles.push(label)
    } catch {
      /* skip binary files */
    }
  }

  async function search(dir: string): Promise<void> {
    if (results.length >= GREP_SAFETY_CAP && !filesOnly) return
    if (filesOnly && matchedFiles.length >= GREP_SAFETY_CAP) return
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
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
  return filesOnly ? matchedFiles.sort().slice(0, GREP_SAFETY_CAP) : results
}

/**
 * Parsea una línea cruda de `rg` con `--line-number` (y opcionalmente
 * `--context`). rg usa `:` como separador para la línea que matchea y `-`
 * para las líneas de contexto — en ambos casos el mismo separador aparece
 * dos veces (antes y después del número de línea), lo que permite
 * distinguir "path con guiones" de "separador de contexto".
 */
function parseRgLine(
  rawLine: string,
  repoName: string,
): { type: 'match' | 'context'; label: string; line: number; content: string } | null {
  const m = /^(.*?)([:-])(\d+)\2(.*)$/.exec(rawLine)
  if (!m) return null
  const [, path, sep, linenoStr, content] = m
  return {
    type: sep === ':' ? 'match' : 'context',
    label: `${repoName}/${path}`,
    line: Number(linenoStr),
    content: content.trim(),
  }
}

/**
 * Reconstruye bloques por match a partir de la salida cruda de `rg -C`. Cada
 * línea de match ancla un bloque; las líneas de contexto contiguas (mismo
 * archivo, número de línea consecutivo) se le suman antes/después. Un `--`
 * (separador de grupo de rg) no matchea el regex de `parseRgLine` y por eso
 * ya corta la contigüidad — no hace falta tratarlo aparte.
 */
function groupRgContext(stdout: string, repoName: string): string[] {
  const entries = stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => parseRgLine(l, repoName))
    .filter((e): e is NonNullable<typeof e> => e !== null)

  const blocks: string[] = []
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!
    if (e.type !== 'match') continue
    const before: string[] = []
    for (let j = i - 1; j >= 0; j--) {
      const c = entries[j]!
      if (c.type !== 'context' || c.label !== e.label || c.line !== e.line - (i - j)) break
      before.unshift(`${c.label}-${c.line}- ${c.content}`)
    }
    const after: string[] = []
    for (let j = i + 1; j < entries.length; j++) {
      const c = entries[j]!
      if (c.type !== 'context' || c.label !== e.label || c.line !== e.line + (j - i)) break
      after.push(`${c.label}-${c.line}- ${c.content}`)
    }
    blocks.push([...before, `${e.label}:${e.line}: ${e.content}`, ...after].join('\n'))
  }
  return blocks
}

/**
 * ripgrep-backed grep. Spawns `rg` with the mapped flags and cwd rooted at
 * the owning repo, then normalises its output into the canonical
 * `<repo>/<rel>:<line>: <match>` shape (or `<repo>/<rel>` bare labels when
 * `files_only` is set).
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
  const contextLines = Math.max(0, Math.trunc(input.context_lines ?? 0))
  const filesOnly = !!input.files_only

  const args = ['--regexp', input.pattern, '--no-heading', '--color', 'never']
  if (filesOnly) {
    args.push('--files-with-matches')
  } else {
    args.push('--line-number')
    if (contextLines > 0) args.push('--context', String(contextLines))
  }
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

  if (filesOnly) {
    return stdout
      .split('\n')
      .filter(Boolean)
      .map((path) => `${repoName}/${path}`)
      .slice(0, GREP_SAFETY_CAP)
  }

  return groupRgContext(stdout, repoName).slice(0, GREP_SAFETY_CAP)
}

// Exported for parity tests.
export { grepWithJs, grepWithRg }

/** `cursor` es el offset (en matches, no líneas) de la próxima página a
 *  pedir — lo que la respuesta anterior devolvió como `Pass cursor: "N"`. */
function parseGrepCursor(cursor: unknown): number {
  const n = typeof cursor === 'string' ? Number.parseInt(cursor, 10) : 0
  return Number.isFinite(n) && n > 0 ? n : 0
}

registerTool({
  name: 'fs_grep',
  aliases: ['grep_files'],
  description:
    `Search for a pattern (regex or literal string) in files within a repo path. Returns up ` +
    `to ${DEFAULT_GREP_LIMIT} matches at a time — when there are more, the result tells you ` +
    'the total and the cursor to pass for the next page. Pass `context_lines` for the lines ' +
    'around each match (like `rg -C`), or `files_only` for just the list of matching files ' +
    '(like `rg -l`).',
  input_schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Search pattern (regex)' },
      path: { type: 'string', description: 'Directory or file to search in: "<repo-name>/path"' },
      glob: { type: 'string', description: 'File glob filter, e.g. "*.ts" (optional)' },
      case_insensitive: { type: 'boolean', description: 'Case-insensitive search (default false)' },
      context_lines: {
        type: 'number',
        description: 'Lines of context to include before and after each match (optional)',
      },
      files_only: {
        type: 'boolean',
        description: 'Return only matching file paths, no line content (optional)',
      },
      cursor: {
        type: 'string',
        description: 'Cursor from a previous response, to fetch the next page of matches',
      },
    },
    required: ['pattern', 'path'],
  },
  async execute(input: any, ctx: ToolContext): Promise<string> {
    const grepInput = input as GrepInput
    let results: string[] | null = null
    try {
      results = await grepWithRg(grepInput, ctx)
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'rg backend threw, falling back to JS walk',
      )
      results = null
    }
    if (results === null) {
      results = await grepWithJs(grepInput, ctx)
    }

    if (results.length === 0) return `No matches found for '${input.pattern}'`

    const offset = parseGrepCursor(input.cursor)
    const total = results.length
    const page = results.slice(offset, offset + DEFAULT_GREP_LIMIT)
    const end = offset + page.length
    const kind = grepInput.files_only ? 'files' : 'matches'
    const capped = total >= GREP_SAFETY_CAP
    const hasMore = end < total
    const header =
      offset > 0 || hasMore || capped
        ? `[Showing ${kind} ${offset + 1}-${end} of ${total}` +
          (capped ? ` (search capped at ${GREP_SAFETY_CAP}, there may be more)` : '') +
          (hasMore ? `. Pass cursor: "${end}" for the next page` : '') +
          '.]\n\n'
        : ''
    const sep = grepInput.context_lines ? '\n--\n' : '\n'
    return header + page.join(sep)
  },
})

// ─── glob_files ───────────────────────────────────────────────────────────

interface GlobInput {
  pattern: string
  path: string
}

/**
 * Convierte un glob de PATH (no sólo de nombre de archivo) a RegExp: `*`
 * matchea dentro de un segmento, `**` cruza directorios (incluyendo cero),
 * `?` es un carácter. Es lo que permite `**\/*.test.ts` — `globToRegex` de
 * más arriba sólo sirve para nombres de archivo sueltos (el filtro de
 * `fs_grep`).
 */
function globToPathRegex(glob: string): RegExp {
  const normalized = glob.replace(/\\/g, '/')
  let re = ''
  for (let i = 0; i < normalized.length; i++) {
    const c = normalized[i]
    if (c === '*' && normalized[i + 1] === '*') {
      i++
      if (normalized[i + 1] === '/') {
        i++
        re += '(?:.*/)?'
      } else {
        re += '.*'
      }
    } else if (c === '*') {
      re += '[^/]*'
    } else if (c === '?') {
      re += '[^/]'
    } else if ('.+^${}()|[]\\'.includes(c!)) {
      re += `\\${c}`
    } else {
      re += c
    }
  }
  return new RegExp(`^${re}$`)
}

function resolveOwningRepo(
  abs: string,
  repoPaths: Record<string, string>,
): [string, string] | null {
  const owner = Object.entries(repoPaths).find(([, p]) => abs === p || abs.startsWith(p + '/'))
  return owner ?? null
}

/**
 * JS-based recursive glob walk, fallback for environments without ripgrep.
 * The pattern matches against the path relative to the given `path` (the
 * search root), same as `globWithRg`'s cwd-rooted search — a pattern like
 * "**\/*.test.ts" scoped to a subdirectory matches within that subdirectory,
 * not the whole repo.
 */
async function globWithJs(input: GlobInput, ctx: ToolContext): Promise<string[]> {
  const abs = resolvePath(input.path, ctx.repoPaths)
  const owner = resolveOwningRepo(abs, ctx.repoPaths)
  const [repoName, repoRoot] = owner ?? ['', abs]
  const regex = globToPathRegex(input.pattern)
  const results: Array<{ label: string; mtime: number }> = []

  async function walk(dir: string, rel: string): Promise<void> {
    if (results.length >= GLOB_MAX_RESULTS * 10) return
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      const full = join(dir, e.name)
      const relPath = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (['node_modules', '.git', 'dist', '__pycache__', 'vendor'].includes(e.name)) continue
        if (isIgnored(full, ctx.repoPaths)) continue
        await walk(full, relPath)
      } else {
        if (isIgnored(full, ctx.repoPaths)) continue
        if (!regex.test(relPath)) continue
        const s = await stat(full).catch(() => null)
        results.push({ label: `${repoName}/${relative(repoRoot, full)}`, mtime: s?.mtimeMs ?? 0 })
      }
    }
  }

  const s = await stat(abs).catch(() => null)
  if (s?.isDirectory()) {
    await walk(abs, '')
  } else if (s?.isFile() && regex.test(basename(abs))) {
    results.push({ label: `${repoName}/${relative(repoRoot, abs)}`, mtime: s.mtimeMs })
  }

  results.sort((a, b) => b.mtime - a.mtime)
  return results.slice(0, GLOB_MAX_RESULTS).map((f) => f.label)
}

/**
 * ripgrep-backed glob (`rg --files --glob`), cwd rooted at the given `path`
 * so the pattern's directory semantics match `globWithJs`. Results are
 * stat'd and sorted by mtime (most recently modified first), same
 * convention Claude Code's own file-search uses.
 *
 * Returns `null` under the same conditions as `grepWithRg` (rg missing,
 * spawn failure, error exit code, or unresolvable owning repo).
 */
async function globWithRg(input: GlobInput, ctx: ToolContext): Promise<string[] | null> {
  const rgPath = _grepInternals.which('rg')
  if (!rgPath) return null

  const abs = resolvePath(input.path, ctx.repoPaths)
  const owner = resolveOwningRepo(abs, ctx.repoPaths)
  if (!owner) return null
  const [repoName, repoRoot] = owner
  const prefix = relative(repoRoot, abs)

  const args = ['--files', '--glob', input.pattern, '--color', 'never']
  for (const dir of ['node_modules', 'dist', '__pycache__', 'vendor']) {
    args.push('--glob', `!${dir}`)
  }

  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn([rgPath, ...args], { cwd: abs, stdout: 'pipe', stderr: 'pipe' })
  } catch (err) {
    log.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'rg spawn failed, falling back to JS walk',
    )
    return null
  }

  const stdout = await new Response(proc.stdout as ReadableStream<Uint8Array>).text()
  const exitCode = await proc.exited
  if (exitCode !== 0 && exitCode !== 1) {
    log.debug({ exitCode }, 'rg errored, falling back to JS walk')
    return null
  }

  const files = stdout.split('\n').filter(Boolean)
  const withMtime = await Promise.all(
    files.map(async (rel) => {
      const full = join(abs, rel)
      const s = await stat(full).catch(() => null)
      const label = prefix ? `${repoName}/${prefix}/${rel}` : `${repoName}/${rel}`
      return { label, mtime: s?.mtimeMs ?? 0 }
    }),
  )
  withMtime.sort((a, b) => b.mtime - a.mtime)
  return withMtime.slice(0, GLOB_MAX_RESULTS).map((f) => f.label)
}

// Exported for parity tests.
export { globWithJs, globWithRg }

registerTool({
  name: 'fs_glob',
  description:
    'Find files by name pattern within a repo path, e.g. "**/*.test.ts". Supports `*` (any ' +
    'chars within a path segment), `**` (any number of directories) and `?` (one char). ' +
    `Results are sorted by most-recently-modified first, capped at ${GLOB_MAX_RESULTS}.`,
  input_schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern, e.g. "**/*.test.ts"' },
      path: {
        type: 'string',
        description:
          'Base directory for the glob: "<repo-name>/relative/path" or absolute, or just ' +
          '"<repo-name>" for the whole repo',
      },
    },
    required: ['pattern', 'path'],
  },
  async execute(input: any, ctx: ToolContext): Promise<string> {
    const abs = resolvePath(input.path, ctx.repoPaths)
    if (!existsSync(abs)) return `Path not found: ${input.path}`

    let results: string[] | null = null
    try {
      results = await globWithRg(input as GlobInput, ctx)
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'rg backend threw, falling back to JS walk',
      )
      results = null
    }
    if (results === null) results = await globWithJs(input as GlobInput, ctx)

    if (results.length === 0) return `No files matching '${input.pattern}'`
    return results.join('\n')
  },
})
