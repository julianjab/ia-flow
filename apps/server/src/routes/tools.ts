import { Hono } from 'hono'
import { getToolDefinitions } from '../tools/index.js'
import '../tools/fs.js'
import '../tools/github.js'

export function createToolsRouter() {
  const app = new Hono()

  app.get('/', (c) => {
    const tools = getToolDefinitions().map(t => ({ name: t.name, description: t.description }))
    return c.json(tools)
  })

  return app
}
