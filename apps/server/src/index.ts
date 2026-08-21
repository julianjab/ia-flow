import { listPendingTasks } from '@ia-flow/agent-engine'
import { onRateLimitChange } from '@ia-flow/issue-sources'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { createGithubRouter } from './adapters/github/routes.js'
import {
  anthropicApiProvider,
  assistWithAiUseCase,
  broadcast,
  envRepo,
  executionLogRepo,
  itermClaudeProvider,
  providerRegistry,
  systemPromptRepo,
  tmuxClaudeProvider,
} from './composition/container.js'
import { setBroadcast, startDaemon } from './daemon.js'
import { createLogger, setLogBroadcast } from './logger.js'
import { runMigrations } from './migrations/runner.js'
import { createAgentsCrudRouter } from './routes/agents-crud.js'
import { createAgentsRouter } from './routes/agents.js'
import { createEnvVarsRouter } from './routes/env-vars.js'
import { createExecutionsRouter } from './routes/executions.js'
import { createHookEventsRouter } from './routes/hook-events.js'
import { createMcpCatalogRouter } from './routes/mcp-catalog.js'
import { createMcpRouter } from './routes/mcp.js'
import { createProjectConfigRouter } from './routes/project-config.js'
import { createProjectSourceRouter } from './routes/project-source.js'
import { createProjectsRouter } from './routes/projects.js'
import { createProvidersRouter } from './routes/providers.js'
import { createRemoteExecutionsRouter } from './routes/remote-executions.js'
import { createRemoteLogsRouter } from './routes/remote-logs.js'
import { createServerLogsRouter } from './routes/server-logs.js'
import { createSlackRouter } from './routes/slack.js'
import { createStatusesRouter } from './routes/statuses.js'
import { createSystemPromptsRouter } from './routes/system-prompts.js'
import { createReposRouter, createTasksRouter } from './routes/tasks.js'
import { createToolsRouter } from './routes/tools.js'
import { createVariablesRouter } from './routes/variables.js'
import { createWebhooksRouter } from './routes/webhooks.js'

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
// Mirror every server log entry to WS clients so the web can render them
// live in the executions drawer. Called *after* the WS set is set up so
// early boot logs still hit the file first.
setLogBroadcast(broadcastFn)

// Push GitHub rate-limit state changes to every connected client so the web
// can render a banner without polling. Fires on enter/exit of the limited
// state — see adapters/github/api/rate-limit.ts.
onRateLimitChange((snap) => broadcastFn({ type: 'github:rate-limit', ...snap }))

// Routes
app.route('/api/tasks', createTasksRouter(broadcastFn))
app.route('/api/repos', createReposRouter())
app.route('/api/providers', createProvidersRouter())
app.route('/api/projects', createProjectsRouter(systemPromptRepo))
app.route('/api/projects/:id/source', createProjectSourceRouter())
app.route('/api/project-config', createProjectConfigRouter())
app.route('/api/github', createGithubRouter())
app.route('/api/tools', createToolsRouter())
app.route('/api/mcp', createMcpRouter())
app.route('/api/agents', createAgentsRouter(assistWithAiUseCase))
app.route('/api/agents-crud', createAgentsCrudRouter())
app.route('/api/system-prompts', createSystemPromptsRouter())
app.route('/api/statuses', createStatusesRouter())
app.route('/api/env-vars', createEnvVarsRouter())
app.route('/api/slack', createSlackRouter())
app.route('/api/variables', createVariablesRouter())
app.route('/api/mcp-catalog', createMcpCatalogRouter())
app.route('/api/executions', createExecutionsRouter())
app.route('/api/server-logs', createServerLogsRouter())
app.route('/api/hook-events', createHookEventsRouter())
app.route('/api/remote-logs', createRemoteLogsRouter())
app.route('/api/remote-executions', createRemoteExecutionsRouter())
app.route('/api/webhooks', createWebhooksRouter())

app.get('/health', (c) => c.json({ ok: true, ts: new Date().toISOString() }))

// Run pending DB migrations before starting the daemon
await runMigrations()

// Close any execution_logs row still marked open — the previous process
// died before it could write the final outcome. Safe to run on every boot
// because in-flight rows only exist while a process is up; a fresh start
// means whatever was open is gone.
{
  const swept = executionLogRepo.sweepOrphaned('orphaned: server restart before finalize')
  if (swept > 0) {
    log.warn({ swept }, 'Closed orphaned execution_logs rows from previous run')
  }
}

// Apply env vars stored in DB (uses the new repo from the container)
envRepo.loadIntoProcess()

// Start daemon (webhook-driven by default, polling when configured — see
// @ia-flow/issue-sources dispatch/daemon-mode.ts)
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

// ─── Graceful shutdown ──────────────────────────────────────────────────
// On SIGINT/SIGTERM: cancel every in-flight agent run (aborts the fetch,
// kills tmux/iterm sessions, clears working flags), then sweep the log
// table so their rows don't linger as `pending` forever. Guarded with a
// flag so a double signal doesn't fire everything twice.
let shuttingDown = false
async function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true

  const pending = listPendingTasks()
  log.warn({ signal, pending: pending.length }, 'Shutdown requested — cancelling in-flight runs')

  await Promise.allSettled(
    pending.map(async ([taskId, entry]) => {
      try {
        await entry.cancel?.()
      } catch (err) {
        log.warn({ taskId, err }, 'Cancel handler threw during shutdown')
      }
    }),
  )

  // Some cancel paths update the log row themselves (async cancel branch);
  // sweepOrphaned uses COALESCE so it won't overwrite those. Anything left
  // open — synchronous runs where the abort didn't reach the finalize site —
  // gets closed here.
  try {
    const swept = executionLogRepo.sweepOrphaned(`orphaned: server ${signal} before finalize`)
    if (swept > 0) log.warn({ swept }, 'Closed remaining orphaned execution_logs rows on shutdown')
  } catch (err) {
    log.warn({ err }, 'Sweep during shutdown failed')
  }

  try {
    server.stop()
  } catch {}

  // Give pino's transport worker a beat to flush buffered lines to disk
  // before we exit, otherwise the last few log entries can be lost.
  setTimeout(() => process.exit(0), 200)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
