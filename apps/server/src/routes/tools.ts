import { type ToolContext, getAllTools, getTool, getToolDefinitions } from '@ia-flow/tools'
import { Hono } from 'hono'
import { repoRepo } from '../composition/container.js'
import { createLogger } from '../logger.js'
// Side-effect: importing @ia-flow/tools registers every built-in tool
// (fs, write, exec, workspace, task, github, slack) into the process-wide
// registry — same effect the 7 separate imports here used to have.

const log = createLogger('tools-route')

function buildToolContext(): ToolContext {
  const repos = repoRepo.list()
  const repoPaths = Object.fromEntries(repos.filter((r) => r.path).map((r) => [r.name, r.path!]))
  return { repoPaths }
}

export function createToolsRouter() {
  const app = new Hono()

  // GET /api/tools — catálogo plano de tools registradas. La UI las agrupa
  // visualmente por dominio (fs/task/workspace/github/slack/bash) del lado
  // cliente; el server ya no tiene un concepto de "categoría" — un agente
  // simplemente declara qué nombres de tool tiene en `tools[]`.
  app.get('/', (c) => {
    const tools = getAllTools().map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
      aliases: t.aliases ?? [],
    }))
    return c.json(tools)
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

// Kept exported so terminal providers that render the tool catalog verbatim
// (curl appendix) still have a single source of truth. Not consumed inside
// this file after the /api/tools payload builder went inline.
void getToolDefinitions
