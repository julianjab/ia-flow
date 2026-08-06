import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { createTasksRouter, createReposRouter } from './routes/tasks.js'
import { createProvidersRouter } from './routes/providers.js'
import { createPromptsRouter } from './routes/prompts.js'
import { createProjectConfigRouter } from './routes/project-config.js'
import { createGithubRouter } from './routes/github.js'
import { createToolsRouter } from './routes/tools.js'
import { createAgentsRouter } from './routes/agents.js'
import { startDaemon, setBroadcast } from './daemon.js'
import { registerProvider } from './providers/index.js'
import { anthropicApiProvider } from './providers/anthropic-api.js'
import { tmuxClaudeProvider } from './providers/tmux-claude.js'
import { itermClaudeProvider } from './providers/iterm-claude.js'
import { createLogger } from './logger.js'

const log = createLogger('server')

// Register all providers
registerProvider(anthropicApiProvider)
registerProvider(tmuxClaudeProvider)
registerProvider(itermClaudeProvider)

const app = new Hono()
app.use('*', cors({ origin: '*' }))

// WebSocket clients
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const wsSet = new Set<{ send(data: string): void }>()

function broadcast(msg: object) {
  const payload = JSON.stringify(msg)
  for (const ws of wsSet) {
    try { ws.send(payload) } catch { wsSet.delete(ws) }
  }
}

// Wire daemon broadcast
setBroadcast(broadcast)

// Routes
app.route('/api/tasks', createTasksRouter(broadcast))
app.route('/api/repos', createReposRouter())
app.route('/api/providers', createProvidersRouter())
app.route('/api/prompts', createPromptsRouter())
app.route('/api/project-config', createProjectConfigRouter())
app.route('/api/github', createGithubRouter())
app.route('/api/tools', createToolsRouter())
app.route('/api/agents', createAgentsRouter())

app.get('/health', (c) => c.json({ ok: true, ts: new Date().toISOString() }))

// Start daemon (includes GitHub if GITHUB_PROJECT_URL is set)
startDaemon()

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
    message() { /* no client→server messages needed */ },
  },
})

log.info({ port: server.port, ws: `ws://localhost:${server.port}/ws` }, 'Server ready')
