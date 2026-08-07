import { type TemplateContext } from '@ia-flow/shared'
import { Hono } from 'hono'
import { getVariableDefinitions } from '../variables/index.js'

export function createVariablesRouter() {
  const app = new Hono()

  app.get('/', (c) => {
    const ctx = c.req.query('context') as TemplateContext | undefined
    const validContexts: TemplateContext[] = ['system-prompt', 'agent-prompt', 'phase-prompt']
    const resolvedCtx = ctx && validContexts.includes(ctx) ? ctx : undefined
    return c.json(getVariableDefinitions(resolvedCtx))
  })

  return app
}
