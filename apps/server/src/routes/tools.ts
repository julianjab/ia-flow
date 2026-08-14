import type { ToolCategoryDescriptor } from '@ia-flow/shared'
import { Hono } from 'hono'
import { listPresets } from '../application/policy.js'
import { repoRepo } from '../composition/container.js'
import { createLogger } from '../logger.js'
import {
  type ToolContext,
  getAllTools,
  getTool,
  getToolDefinitions,
  getToolsByCategory,
} from '../tools/index.js'
import '../adapters/github/tools.js'
import '../tools/fs.js'
import '../tools/slack.js'
import '../tools/task.js'
import '../tools/workspace.js'
import '../tools/exec.js'
import '../tools/write.js'

const log = createLogger('tools-route')

function buildToolContext(): ToolContext {
  const repos = repoRepo.list()
  const repoPaths = Object.fromEntries(repos.filter((r) => r.path).map((r) => [r.name, r.path!]))
  return { repoPaths }
}

export function createToolsRouter() {
  const app = new Hono()

  // GET /api/tools — list all registered tools with schemas + category + aliases
  app.get('/', (c) => {
    // We hand-build the payload here (not `getToolDefinitions()`) so callers
    // that render the permission editor can group by category and know which
    // legacy names still resolve to the tool.
    const tools = getAllTools().map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
      category: t.category,
      aliases: t.aliases ?? [],
    }))
    return c.json(tools)
  })

  // GET /api/tools/categories — descriptor tree the UI renders as a
  // checkbox tree in the AgentEditor. Bash gets its sub-scopes expanded
  // inline so the UI can show them as nested nodes under `bash`.
  app.get('/categories', (c) => {
    const bashBins: Record<string, string[]> = {
      bun: ['bun', 'bunx', 'node', 'npm', 'pnpm'],
      gh: ['gh'],
      'git.readonly': ['git'],
      'git.write.task': ['git'],
      'git.write.main': ['git'],
      'git.destructive': ['git'],
      'shell.generic': [
        'cat',
        'ls',
        'head',
        'tail',
        'find',
        'rg',
        'make',
        'go',
        'uv',
        'pytest',
        'ruff',
      ],
    }
    const categories: ToolCategoryDescriptor[] = [
      {
        id: 'fs.read',
        description: 'Lectura de archivos, directorios y búsqueda por patrón.',
        tools: getToolsByCategory('fs.read').map((t) => t.name),
      },
      {
        id: 'fs.write',
        description: 'Escritura y edición de archivos dentro del worktree.',
        tools: getToolsByCategory('fs.write').map((t) => t.name),
      },
      {
        id: 'task.write',
        description: 'Modificar body, campos, labels y comentarios de la tarea.',
        tools: getToolsByCategory('task.write').map((t) => t.name),
      },
      {
        id: 'task.transition',
        description: 'complete_task / fail_task (siempre disponibles como internas).',
        tools: getToolsByCategory('task.transition').map((t) => t.name),
      },
      {
        id: 'workspace',
        description: 'Reset del worktree del task (isolation recovery).',
        tools: getToolsByCategory('workspace').map((t) => t.name),
      },
      {
        id: 'bash',
        description: 'Ejecución sandboxeada. Elegí sub-scopes para acotar bins y git write scope.',
        tools: getToolsByCategory('bash').map((t) => t.name),
        bashScopes: [
          { id: 'bun', description: 'bun / bunx / node / npm / pnpm', bins: bashBins.bun },
          { id: 'gh', description: 'GitHub CLI (PR review, merge, comments)', bins: bashBins.gh },
          {
            id: 'git.readonly',
            description: 'git status / log / diff / fetch',
            bins: bashBins['git.readonly'],
          },
          {
            id: 'git.write.task',
            description: 'git push a HEAD / task/*',
            bins: bashBins['git.write.task'],
          },
          {
            id: 'git.write.main',
            description: 'git push a main / release/* (releaser)',
            bins: bashBins['git.write.main'],
          },
          {
            id: 'git.destructive',
            description: 'checkout / branch -D / reset --hard / worktree remove',
            bins: bashBins['git.destructive'],
          },
          {
            id: 'shell.generic',
            description: 'cat, ls, head, tail, find, rg, make, uv, pytest, ruff',
            bins: bashBins['shell.generic'],
          },
        ],
      },
    ]
    return c.json(categories)
  })

  // POST /api/tools/:name — execute a tool by name
  // Used by async agents (tmux/iterm) to report results and trigger transitions.
  app.post('/:name', async (c) => {
    const name = c.req.param('name')
    const tool = getTool(name)
    if (!tool) return c.json({ error: `Tool '${name}' not found` }, 404)

    let input: unknown
    try {
      input = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    log.debug({ tool: name, input }, 'tool execute via HTTP')

    try {
      const result = await tool.execute(input, buildToolContext())
      return c.json({ result })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.warn({ tool: name, err: msg }, 'tool execute failed')
      return c.json({ error: msg }, 500)
    }
  })

  return app
}

// Separate router mounted at /api/permission-presets — returns the 5 built-in
// preset bundles the UI shows in the AgentEditor dropdown. Kept out of the
// tools router so the URL space (`/api/permission-presets`) matches the AC
// verbatim and the presets can evolve independently.
export function createPermissionPresetsRouter() {
  const app = new Hono()
  app.get('/', (c) => {
    return c.json(
      listPresets().map((p) => ({
        id: p.id,
        description: p.description,
        permissions: [...p.permissions],
      })),
    )
  })
  return app
}

// Kept exported so terminal providers that render the tool catalog verbatim
// (curl appendix) still have a single source of truth. Not consumed inside
// this file after the /api/tools payload builder went inline.
void getToolDefinitions
