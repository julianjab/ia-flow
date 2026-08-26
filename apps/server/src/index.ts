import { listPendingTasks } from '@ia-flow/agent-engine'
import { onRateLimitChange } from '@ia-flow/issue-sources'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { createGithubRouter } from './adapters/github/routes.js'
import { reconcileOrphanedRuns } from './adapters/pending-task-rehydrator.js'
import {
  anthropicApiProvider,
  assistWithAiUseCase,
  broadcast,
  envRepo,
  executionLogRepo,
  itermClaudeProvider,
  providerRegistry,
  remoteProviderHealth,
  systemPromptRepo,
  tmuxClaudeProvider,
} from './composition/container.js'
import { setBroadcast, startDaemon } from './daemon.js'
import { createLogger, flushOtel, setLogBroadcast } from './logger.js'
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
import { createProviderRegistrationsRouter } from './routes/provider-registrations.js'
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
import { resolveServerPort } from './server-port.js'

const log = createLogger('server')

providerRegistry.register(anthropicApiProvider)
providerRegistry.register(tmuxClaudeProvider)
providerRegistry.register(itermClaudeProvider)
// Los providers remotos persistidos NO se re-registran a ciegas acá: los da
// de alta el health monitor cuando su gateway contesta, y los da de baja
// apenas deja de hacerlo (ver adapters/remote-provider/
// RemoteProviderHealthMonitor.ts). Se arranca más abajo, después de cablear
// el broadcast, para que el primer cambio de estado ya viaje a la web.

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
app.route('/api/provider-registrations', createProviderRegistrationsRouter())
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

// Reconcilia las filas que quedaron abiertas del proceso anterior.
//
// Antes esto era una barrida ciega (`sweepOrphaned`) apoyada en que "las
// filas en vuelo sólo existen mientras el proceso vive". Es falso justo para
// los runs que más importan: una sesión de tmux o una tab de iTerm —local o
// en un gateway de otra máquina— sobrevive al reinicio del daemon y su
// agente sigue trabajando. Cerrarles la fila los dejaba sin forma de
// cerrarse después: el `complete_task` llegaba a un proceso que ya no sabía
// nada de ese run.
//
// Ahora un run con sesión async registrada se deja ABIERTO. Cuando su agente
// aparezca con el cierre, el rehidratador (adapters/pending-task-rehydrator)
// reconstruye la entrada desde su fila y lo aplica.
{
  const { closed, kept } = await reconcileOrphanedRuns({
    executionLogRepo,
    reason: 'orphaned: server restart before finalize',
  })
  if (closed > 0) {
    log.warn({ closed }, 'Closed orphaned execution_logs rows from previous run')
  }
  if (kept.length > 0) {
    log.warn(
      { kept: kept.map((r) => ({ id: r.id, taskId: r.taskId, session: r.sessionId })) },
      'Runs con sesión async del proceso anterior: se dejan abiertos para que su agente pueda cerrarlos',
    )
  }
}

// Apply env vars stored in DB (uses the new repo from the container)
envRepo.loadIntoProcess()

// Sondea los gateways remotos y sincroniza el registry con su salud: un
// `remote:<name>` sólo está registrado —y por lo tanto es elegible— mientras
// conteste. Después de `loadIntoProcess()` para que el intervalo guardado en
// la DB valga, y antes del daemon para que el primer scan no despache contra
// un gateway que ya no está. No se espera la primera ronda: un gateway lento
// no debe demorar el boot.
void remoteProviderHealth.start()

// Start daemon (webhook-driven by default, polling when configured — see
// @ia-flow/issue-sources dispatch/daemon-mode.ts)
await startDaemon()

const PORT = resolveServerPort()
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
  // Un run async no muere con este proceso: su sesión vive en el SO (acá o en
  // el gateway de otra máquina) y el agente sigue trabajando. Cancelarlo en
  // el apagado mataba esa sesión y tiraba a la basura trabajo ya hecho —
  // justo lo que un `docker restart` no debería costar. Se lo deja correr:
  // su fila queda abierta, y cuando cierre, el rehidratador aplica el
  // resultado aunque haya sido otro proceso el que lanzó el run.
  const detachable = pending.filter(([, entry]) => entry.killSession != null)
  const cancellable = pending.filter(([, entry]) => entry.killSession == null)
  log.warn(
    { signal, cancelling: cancellable.length, detaching: detachable.length },
    'Shutdown requested — cancelling in-flight runs',
  )
  if (detachable.length > 0) {
    log.warn(
      { tasks: detachable.map(([taskId]) => taskId) },
      'Sesiones async: se sueltan vivas, cierran contra el próximo proceso',
    )
  }

  await Promise.allSettled(
    cancellable.map(async ([taskId, entry]) => {
      try {
        await entry.cancel?.()
      } catch (err) {
        log.warn({ taskId, err }, 'Cancel handler threw during shutdown')
      }
    }),
  )

  // Lo que quedó abierto de los runs sync (donde el abort no llegó al sitio
  // de finalize) se cierra acá. Los async NO: su fila se deja abierta a
  // propósito, es la que va a permitir que el agente cierre contra el próximo
  // proceso.
  try {
    const { closed } = await reconcileOrphanedRuns({
      executionLogRepo,
      reason: `orphaned: server ${signal} before finalize`,
      // Sin sondear: estamos dentro del handler de la señal, con un grace
      // limitado antes del SIGKILL, y cada sonda local cuesta hasta 5s de
      // `osascript`/`tmux` — varias filas huérfanas nos comerían el tiempo
      // que necesita el `flush()` de abajo para que el daemon remoto se
      // entere de los cierres. Acá se cierra sólo lo que no tiene sesión; lo
      // demás lo sondea el arranque, que sí tiene tiempo.
      probe: async () => 'unknown',
    })
    if (closed > 0)
      log.warn({ closed }, 'Closed remaining orphaned execution_logs rows on shutdown')
  } catch (err) {
    log.warn({ err }, 'Sweep during shutdown failed')
  }

  // Those closures may still be an in-flight POST to the main daemon (this
  // process is a headless container forwarding its rows). The 200ms grace
  // below is for pino, not for a 3s fetch — without this await the remote
  // side never learns the run ended, and the next boot has nothing left to
  // forward because the row is already closed locally.
  try {
    await executionLogRepo.flush?.()
  } catch (err) {
    log.warn({ err }, 'Execution log flush during shutdown failed')
  }

  try {
    server.stop()
  } catch {}

  // The OTel sink batches asynchronously on the MAIN thread, so the 200ms
  // grace below (which is for pino's transport worker) does not cover it: a
  // batch still queued when process.exit fires is lost. Measured with a local
  // OTLP receiver — see the PR of #65. No-op when the sink is off, and capped
  // internally so an unreachable collector can't eat the SIGTERM grace.
  await flushOtel()

  // Give pino's transport worker a beat to flush buffered lines to disk
  // before we exit, otherwise the last few log entries can be lost.
  setTimeout(() => process.exit(0), 200)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
