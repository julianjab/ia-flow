import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { anthropicApiProvider } from './adapters/anthropic/provider.js'
import { createGithubRouter } from './adapters/github/routes.js'
import { itermClaudeProvider } from './adapters/iterm/provider.js'
import { tmuxClaudeProvider } from './adapters/tmux/provider.js'
import {
  assistWithAiUseCase,
  broadcast,
  envRepo,
  providerRegistry,
  systemPromptRepo,
} from './composition/container.js'
import { setBroadcast, startDaemon } from './daemon.js'
import { createLogger } from './logger.js'
import { runMigrations } from './migrations/runner.js'
import { createAgentsCrudRouter } from './routes/agents-crud.js'
import { createAgentsRouter } from './routes/agents.js'
import { createEnvVarsRouter } from './routes/env-vars.js'
import { createExecutionsRouter } from './routes/executions.js'
import { createMcpCatalogRouter } from './routes/mcp-catalog.js'
import { createProjectConfigRouter } from './routes/project-config.js'
import { createProjectSourceRouter } from './routes/project-source.js'
import { createProjectsRouter } from './routes/projects.js'
import { createProvidersRouter } from './routes/providers.js'
import { createSlackRouter } from './routes/slack.js'
import { createStatusesRouter } from './routes/statuses.js'
import { createSystemPromptsRouter } from './routes/system-prompts.js'
import { createReposRouter, createTasksRouter } from './routes/tasks.js'
import { createToolsRouter } from './routes/tools.js'
import { createVariablesRouter } from './routes/variables.js'

const log = createLogger('server')

providerRegistry.register(anthropicApiProvider)
providerRegistry.register(tmuxClaudeProvider)
providerRegistry.register(itermClaudeProvider)

const app = new Hono()
app.use('*', cors({ origin: '*' }))

// WebSocket clients
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const wsSet = new Set<{ send(data: string): void }>()

function broadcastFn(msg: object) {
  const payload = JSON.stringify(msg)
  for (const ws of wsSet) {
    try {
      ws.send(payload)
    } catch {
      wsSet.delete(ws)
    }
  }
}

// Wire broadcast — both legacy daemon and new container
setBroadcast(broadcastFn)
broadcast.setFn(broadcastFn)

// Routes
app.route('/api/tasks', createTasksRouter(broadcastFn))
app.route('/api/repos', createReposRouter())
app.route('/api/providers', createProvidersRouter())
app.route('/api/projects', createProjectsRouter(systemPromptRepo))
app.route('/api/projects/:id/source', createProjectSourceRouter())
app.route('/api/project-config', createProjectConfigRouter())
app.route('/api/github', createGithubRouter())
app.route('/api/tools', createToolsRouter())
app.route('/api/agents', createAgentsRouter(assistWithAiUseCase))
app.route('/api/agents-crud', createAgentsCrudRouter())
app.route('/api/system-prompts', createSystemPromptsRouter())
app.route('/api/statuses', createStatusesRouter())
app.route('/api/env-vars', createEnvVarsRouter())
app.route('/api/slack', createSlackRouter())
app.route('/api/variables', createVariablesRouter())
app.route('/api/mcp-catalog', createMcpCatalogRouter())
app.route('/api/executions', createExecutionsRouter())

app.get('/health', (c) => c.json({ ok: true, ts: new Date().toISOString() }))

// Run pending DB migrations before starting the daemon
await runMigrations()

// Apply env vars stored in DB (uses the new repo from the container)
envRepo.loadIntoProcess()

// Start daemon (polls each project's configured source)
await startDaemon()

const PORT = parseInt(Bun.env.PORT ?? '3001', 10)
log.info({ port: PORT }, 'ia-flow starting')

const server = Bun.serve({
  port: PORT,
  fetch(req, srv) {
    if (req.url.endsWith('/ws')) {
      const ok = srv.upgrade(req)
      if (!ok) return new Response('WebSocket upgrade failed', { status: 400 })
      return undefined
    }
    return app.fetch(req)
  },
  websocket: {
    open(ws) {
      wsSet.add(ws as any)
      ws.send(JSON.stringify({ type: 'connected' }))
    },
    close(ws) {
      wsSet.delete(ws as any)
    },
    message() {
      /* no client→server messages needed */
    },
  },
})

log.info({ port: server.port, ws: `ws://localhost:${server.port}/ws` }, 'Server ready')
