import { Hono } from 'hono'
import { cors } from 'hono/cors'
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
import { anthropicApiProvider } from './providers/anthropic-api.js'
import { registerProvider } from './providers/index.js'
import { itermClaudeProvider } from './providers/iterm-claude.js'
import { tmuxClaudeProvider } from './providers/tmux-claude.js'
import { createAgentsRouter } from './routes/agents.js'
import { createEnvVarsRouter } from './routes/env-vars.js'
import { createGithubRouter } from './routes/github.js'
import { createProjectConfigRouter } from './routes/project-config.js'
import { createProjectSourceRouter } from './routes/project-source.js'
import { createProjectsRouter } from './routes/projects.js'
import { createPromptsRouter } from './routes/prompts.js'
import { createProvidersRouter } from './routes/providers.js'
import { createSlackRouter } from './routes/slack.js'
import { createReposRouter, createTasksRouter } from './routes/tasks.js'
import { createToolsRouter } from './routes/tools.js'
import { createVariablesRouter } from './routes/variables.js'

const log = createLogger('server')

// Register all providers (both in the legacy module-level registry and in the new DI registry)
registerProvider(anthropicApiProvider)
registerProvider(tmuxClaudeProvider)
registerProvider(itermClaudeProvider)

providerRegistry.register(
  anthropicApiProvider as unknown as import('./domain/ports/IAgentProvider.js').IAgentProvider,
)
providerRegistry.register(
  tmuxClaudeProvider as unknown as import('./domain/ports/IAgentProvider.js').IAgentProvider,
)
providerRegistry.register(
  itermClaudeProvider as unknown as import('./domain/ports/IAgentProvider.js').IAgentProvider,
)

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
app.route('/api/prompts', createPromptsRouter())
app.route('/api/projects', createProjectsRouter(systemPromptRepo))
app.route('/api/projects/:id/source', createProjectSourceRouter())
app.route('/api/project-config', createProjectConfigRouter())
app.route('/api/github', createGithubRouter())
app.route('/api/tools', createToolsRouter())
app.route('/api/agents', createAgentsRouter(assistWithAiUseCase))
app.route('/api/env-vars', createEnvVarsRouter())
app.route('/api/slack', createSlackRouter())
app.route('/api/variables', createVariablesRouter())

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
