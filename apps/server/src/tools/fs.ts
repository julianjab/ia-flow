// Filesystem tools — scoped to registered repo paths only
import { readFile, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'
import { registerTool, type ToolContext } from './index.js'

const MAX_FILE_BYTES = 40_000   // ~10k tokens per file
const MAX_GREP_RESULTS = 30

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
  // Try repo-name prefix
  for (const [name, root] of Object.entries(repoPaths)) {
    if (path.startsWith(name + '/')) {
      const rel = path.slice(name.length + 1)
      return resolve(root, rel)
    }
    // Also try just relative path inside any repo
  }
  throw new Error(
    `Cannot resolve path '${path}'. Use '<repo-name>/relative/path' or an absolute path.\n` +
    `Available repos: ${Object.keys(repoPaths).join(', ')}`,
  )
}

// ─── read_file ────────────────────────────────────────────────────────────

registerTool({
  name: 'read_file',
  description: 'Read the contents of a file in one of the task repos. Use "<repo-name>/path/to/file" format.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path: "<repo-name>/relative/path" or absolute path' },
      offset: { type: 'number', description: 'Line number to start reading from (1-indexed, optional)' },
      limit: { type: 'number', description: 'Max number of lines to read (optional)' },
    },
    required: ['path'],
  },
  async execute(input: any, ctx: ToolContext): Promise<string> {
    const abs = resolvePath(input.path, ctx.repoPaths)
    if (!existsSync(abs)) return `File not found: ${input.path}`

    const s = await stat(abs)
    if (s.isDirectory()) return `Path is a directory. Use list_dir instead.`

    let content = await readFile(abs, 'utf-8')

    if (input.offset || input.limit) {
      const lines = content.split('\n')
      const start = Math.max(0, (input.offset ?? 1) - 1)
      const end = input.limit ? start + input.limit : lines.length
      content = lines.slice(start, end).map((l, i) => `${start + i + 1}\t${l}`).join('\n')
    } else if (Buffer.byteLength(content) > MAX_FILE_BYTES) {
      const truncated = content.slice(0, MAX_FILE_BYTES)
      content = truncated + `\n\n[... file truncated at ${MAX_FILE_BYTES} bytes. Use offset/limit to read more]`
    }

    return content
  },
})

// ─── list_dir ─────────────────────────────────────────────────────────────

registerTool({
  name: 'list_dir',
  description: 'List files and directories at a path in one of the task repos.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path: "<repo-name>/relative/path" or absolute' },
    },
    required: ['path'],
  },
  async execute(input: any, ctx: ToolContext): Promise<string> {
    const abs = resolvePath(input.path, ctx.repoPaths)
    if (!existsSync(abs)) return `Path not found: ${input.path}`

    const entries = await readdir(abs, { withFileTypes: true })
    const lines = entries
      .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== '__pycache__')
      .map((e) => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`)
    return lines.join('\n') || '(empty directory)'
  },
})

// ─── grep_files ───────────────────────────────────────────────────────────

registerTool({
  name: 'grep_files',
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
    const abs = resolvePath(input.path, ctx.repoPaths)
    const flags = input.case_insensitive ? 'gi' : 'g'
    const regex = new RegExp(input.pattern, flags)

    const results: string[] = []

    async function search(dir: string): Promise<void> {
      if (results.length >= MAX_GREP_RESULTS) return
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const e of entries) {
        if (results.length >= MAX_GREP_RESULTS) return
        const full = join(dir, e.name)
        if (e.isDirectory()) {
          if (!['node_modules', '.git', 'dist', '__pycache__', 'vendor'].includes(e.name)) {
            await search(full)
          }
        } else {
          if (input.glob && !e.name.match(input.glob.replace('*', '.*'))) continue
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
          } catch { /* skip binary files */ }
        }
      }
    }

    const s = await stat(abs).catch(() => null)
    if (s?.isDirectory()) {
      await search(abs)
    } else {
      await search(abs.replace(/\/[^/]+$/, ''))
    }

    if (results.length === 0) return `No matches found for '${input.pattern}'`
    const header = results.length >= MAX_GREP_RESULTS ? `[First ${MAX_GREP_RESULTS} matches]\n` : ''
    return header + results.join('\n')
  },
})
