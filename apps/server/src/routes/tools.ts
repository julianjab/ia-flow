import { Hono } from 'hono'
import { listDbRepos } from '../db.js'
import { createLogger } from '../logger.js'
import { type ToolContext, getTool, getToolDefinitions } from '../tools/index.js'
import '../tools/fs.js'
import '../tools/github.js'
import '../tools/task.js'
import '../tools/slack.js'

const log = createLogger('tools-route')

function buildToolContext(): ToolContext {
  const repos = listDbRepos()
  const repoPaths = Object.fromEntries(repos.filter((r) => r.path).map((r) => [r.name, r.path!]))
  return { repoPaths }
}

export function createToolsRouter() {
  const app = new Hono()

  // GET /api/tools — list all registered tools with schemas
  app.get('/', (c) => {
    const tools = getToolDefinitions()
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
