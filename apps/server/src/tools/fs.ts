import { existsSync } from 'node:fs'
// Filesystem tools — scoped to registered repo paths only
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { createLogger } from '../logger.js'
import { isIgnored } from './gitignore.js'
import { type ToolContext, registerTool } from './index.js'

const log = createLogger('tool-fs')

const MAX_FILE_BYTES = 40_000
const FILE_SIMPLIFIER_THRESHOLD = 15_000 // bytes — above this, summarize with Haiku
const MAX_GREP_RESULTS = 30

const HAIKU_MODEL = 'claude-haiku-4-5-20251001'

const FILE_SIMPLIFIER_PROMPT_ID = 'fileSimplifier'

async function simplifyWithHaiku(content: string, filePath: string): Promise<string> {
  const { systemPromptRepo } = await import('../composition/container.js')

  const oauthToken = Bun.env.CLAUDE_CODE_OAUTH_TOKEN
  const apiKey = Bun.env.ANTHROPIC_API_KEY
  const authHeader: Record<string, string> | null = oauthToken
    ? { Authorization: `Bearer ${oauthToken}` }
    : apiKey
      ? { 'x-api-key': apiKey }
      : null

  if (!authHeader) {
    log.warn({ filePath, contentBytes: content.length }, 'haiku simplifier skipped: no auth')
    return content.slice(0, MAX_FILE_BYTES) + '\n[truncated — no auth for simplifier]'
  }

  const prompt = systemPromptRepo.getById(FILE_SIMPLIFIER_PROMPT_ID)
  if (!prompt) {
    log.warn(
      { filePath, promptId: FILE_SIMPLIFIER_PROMPT_ID },
      'haiku simplifier skipped: system prompt not seeded',
    )
    return content.slice(0, MAX_FILE_BYTES) + '\n[truncated — simplifier prompt missing]'
  }
  const systemPrompt = prompt.text
  const userMessage = `File: ${filePath}\n\n${content.slice(0, 80_000)}`

  log.info(
    {
      model: HAIKU_MODEL,
      filePath,
      contentBytes: content.length,
      userBytes: userMessage.length,
      systemBytes: systemPrompt.length,
    },
    'haiku simplifier request',
  )

  const t0 = Date.now()
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        ...authHeader,
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
    })

    const ms = Date.now() - t0
    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      log.warn(
        { filePath, status: res.status, ms, err: errBody.slice(0, 500) },
        'haiku simplifier failed',
      )
      return content.slice(0, MAX_FILE_BYTES) + '\n[simplifier unavailable]'
    }

    const data = (await res.json()) as any
    const text = (data.content as any[])
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text as string)
      .join('')

    log.info(
      {
        filePath,
        status: res.status,
        ms,
        inBytes: content.length,
        outBytes: text.length,
        ratio: text.length / Math.max(content.length, 1),
        usage: data.usage,
      },
      'haiku simplifier response',
    )
    return `[simplified — ${content.length}B → ${text.length}B]\n${text}`
  } catch (err) {
    log.warn(
      { filePath, ms: Date.now() - t0, err: err instanceof Error ? err.message : String(err) },
      'haiku simplifier threw',
    )
    return content.slice(0, MAX_FILE_BYTES) + '\n[simplifier failed — truncated]'
  }
}

async function isSimplifierEnabled(ctx: ToolContext): Promise<boolean> {
  if (ctx.fileSimplifierEnabled !== undefined) return ctx.fileSimplifierEnabled
  const { loadProviderConfig } = await import('../application/provider-config.js')
  const config = await loadProviderConfig()
  return config.fileSimplifierEnabled ?? true
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
  name: 'read_file',
  description:
    'Read the contents of a file in one of the task repos. Use "<repo-name>/path/to/file" format.',
  input_schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path: "<repo-name>/relative/path" or absolute path',
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

    let content = await readFile(abs, 'utf-8')

    if (input.offset || input.limit) {
      const lines = content.split('\n')
      const start = Math.max(0, (input.offset ?? 1) - 1)
      const end = input.limit ? start + input.limit : lines.length
      content = lines
        .slice(start, end)
        .map((l, i) => `${start + i + 1}\t${l}`)
        .join('\n')
    } else if (Buffer.byteLength(content) > FILE_SIMPLIFIER_THRESHOLD) {
      const enabled = await isSimplifierEnabled(ctx)
      if (enabled) {
        content = await simplifyWithHaiku(content, input.path)
      } else {
        content = content.slice(0, MAX_FILE_BYTES) + '\n[truncated — simplifier disabled]'
      }
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
          if (['node_modules', '.git', 'dist', '__pycache__', 'vendor'].includes(e.name)) continue
          if (isIgnored(full, ctx.repoPaths)) continue
          await search(full)
        } else {
          if (input.glob && !e.name.match(input.glob.replace('*', '.*'))) continue
          if (isIgnored(full, ctx.repoPaths)) continue
          try {
            const content = await readFile(full, 'utf-8')
            const lines = content.split('\n')
            for (let i = 0; i < lines.length; i++) {
              if (regex.test(lines[i])) {
                const root =
                  Object.entries(ctx.repoPaths).find(([, p]) => full.startsWith(p))?.[0] ?? ''
                const rel = root ? relative(ctx.repoPaths[root], full) : full
                results.push(`${root}/${rel}:${i + 1}: ${lines[i].trim()}`)
                if (results.length >= MAX_GREP_RESULTS) return
              }
            }
          } catch {
            /* skip binary files */
          }
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
