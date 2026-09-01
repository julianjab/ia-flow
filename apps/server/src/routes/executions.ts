import { getPendingTask, removePendingTask } from '@ia-flow/agent-engine'
import { ExecutionLogFiltersSchema, ExecutionStatsFiltersSchema } from '@ia-flow/shared'
import { Hono } from 'hono'
import { INSTANCE_ID, executionLogRepo, executionStatsRepo } from '../composition/container.js'
import { createLogger } from '../logger.js'

const log = createLogger('executions-route')

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500

export function createExecutionsRouter() {
  const app = new Hono()

  app.get('/sources', (c) => {
    return c.json({ sources: executionLogRepo.listDistinctSources() })
  })

  // Declared before `/:id` — Hono matches in registration order, so a later
  // `/stats` would be swallowed by the id param route.
  app.get('/stats', (c) => {
    const q = c.req.query()
    const many = (key: string): string | string[] | undefined => {
      const values = c.req.queries(key) ?? []
      if (values.length > 1) return values
      if (values.length === 1) return values[0]
      return q[key]
    }
    const parsed = ExecutionStatsFiltersSchema.safeParse({
      projectId: many('projectId'),
      agentId: many('agentId'),
      source: many('source'),
      from: q.from,
      to: q.to,
    })
    if (!parsed.success) {
      return c.json({ error: 'Invalid query params', issues: parsed.error.issues }, 400)
    }
    return c.json(executionStatsRepo.stats(parsed.data))
  })

  // Drill-down for one agent. Also before `/:id` — `/stats/:agentId` would
  // otherwise be read as an execution id of "stats".
  app.get('/stats/:agentId', (c) => {
    const q = c.req.query()
    const parsed = ExecutionStatsFiltersSchema.safeParse({
      projectId: c.req.queries('projectId')?.length ? c.req.queries('projectId') : q.projectId,
      source: c.req.queries('source')?.length ? c.req.queries('source') : q.source,
      from: q.from,
      to: q.to,
    })
    if (!parsed.success) {
      return c.json({ error: 'Invalid query params', issues: parsed.error.issues }, 400)
    }
    const detail = executionStatsRepo.agentDetail(c.req.param('agentId'), parsed.data)
    if (!detail) return c.json({ error: 'No finished runs for this agent in the window' }, 404)
    return c.json(detail)
  })

  app.get('/', (c) => {
    const q = c.req.query()
    const rawLimit = q.limit !== undefined ? Number(q.limit) : undefined
    // Collect repeated ?agentId=a&agentId=b etc. as arrays so the UI can
    // pass a multi-select set. Falls back to the single-value form when the
    // key appears once.
    const many = (key: string): string | string[] | undefined => {
      const values = c.req.queries(key) ?? []
      if (values.length > 1) return values
      if (values.length === 1) return values[0]
      return q[key]
    }
    const parsed = ExecutionLogFiltersSchema.safeParse({
      projectId: many('projectId'),
      taskId: q.taskId,
      agentId: many('agentId'),
      providerId: many('providerId'),
      outcome: many('outcome'),
      source: many('source'),
      failureClass: many('failureClass'),
      assignee: many('assignee'),
      // Los tres los resolvían el schema y el repo desde la migración 065, pero
      // la ruta no los leía: eran filtros inalcanzables por HTTP.
      kind: many('kind'),
      ruleId: many('ruleId'),
      eventId: q.eventId,
      from: q.from,
      to: q.to,
      limit: Number.isNaN(rawLimit) ? undefined : rawLimit,
    })
    if (!parsed.success) {
      return c.json({ error: 'Invalid query params', issues: parsed.error.issues }, 400)
    }

    const filters = parsed.data
    filters.limit = Math.min(filters.limit ?? DEFAULT_LIMIT, MAX_LIMIT)

    const executions = executionLogRepo.list(filters)
    return c.json({ executions })
  })

  // Live board / topbar chip use this to render "N corriendo". Returns just
  // the rows where finished_at IS NULL — cheap enough to hit on every WS
  // reconnect without pagination.
  app.get('/active', (c) => {
    const executions = executionLogRepo.listActive()
    return c.json({ executions })
  })

  app.get('/:id', (c) => {
    const execution = executionLogRepo.getById(c.req.param('id'))
    if (!execution) return c.json({ error: 'Not found' }, 404)
    return c.json({ execution })
  })

  // Manual cancel. Two code paths depending on whether the run is still
  // in-flight:
  //   • in-flight (pending entry exists): trigger the same cancel plumbing
  //     as the polling divergence gate — kills the backing session, clears
  //     the working flag, resolves the async waiter with cancelled=true.
  //   • orphaned (no pending entry, `finished_at IS NULL`): just close the
  //     DB row so the dispatcher stops treating it as running. The tab may
  //     already be dead; if it isn't, we still try to close it via the
  //     stored session metadata so nothing leaks.
  app.post('/:id/cancel', async (c) => {
    const execution = executionLogRepo.getById(c.req.param('id'))
    if (!execution) return c.json({ error: 'Not found' }, 404)
    if (execution.finishedAt) {
      return c.json({ ok: true, alreadyFinished: true, execution })
    }
    if (execution.source && execution.source !== INSTANCE_ID) {
      // Forwarded row (source = OTHER process's IA_FLOW_INSTANCE_ID) — this
      // daemon has no `pendingTask` for it, so the orphan branch below would
      // close it as cancelled while the agent keeps running in the OTHER
      // process, and the next forwarded update would silently overwrite that
      // lie. There's also no safe network path to reach into that container
      // and actually stop it (its public port only proxies the webhook route
      // — see scripts/webhook-proxy.ts — the full API has no auth of its
      // own). So this only stamps an advisory marker instead of lying that
      // the run stopped; the container keeps running until it finishes or
      // someone stops it there.
      //
      // A row whose `source` equals THIS process's own INSTANCE_ID isn't
      // forwarded from anywhere — every row this daemon inserts is
      // self-tagged (SourceTaggingExecutionLogRepository), restart after
      // restart, so a same-instance row falls through instead: it's either
      // still live (pendingTask branch) or truly orphaned from a previous
      // life of THIS process (orphan branch below can actually close it).
      executionLogRepo.update(execution.id, { cancelRequestedAt: new Date().toISOString() })
      log.info(
        { id: execution.id, source: execution.source },
        'Cancel requested on remote-owned execution (advisory only, not actually stopped)',
      )
      return c.json({
        ok: true,
        cancelRequested: true,
        execution: executionLogRepo.getById(execution.id),
      })
    }

    const pending = getPendingTask(execution.taskId)
    if (pending) {
      try {
        await pending.cancel?.()
      } catch (err) {
        log.warn({ err, id: execution.id }, 'pending.cancel threw — continuing cleanup')
      }
      // Async provider: cancel() doesn't unblock waitForFinish on its own,
      // so we resolve it explicitly. Sync provider: the AbortController
      // triggered inside cancel() will make the provider throw and the
      // orchestrator will removePendingTask itself; calling it here is
      // still safe (map lookup → no-op).
      removePendingTask(execution.taskId, { cancelled: true })
      log.info({ id: execution.id, taskId: execution.taskId }, 'Execution cancelled via HTTP')
      return c.json({ ok: true, execution: executionLogRepo.getById(execution.id) })
    }

    // Orphan branch — best-effort tab close by kind + session id.
    if (execution.sessionKind === 'iterm' && execution.sessionId) {
      const { closeItermSession } = await import('@ia-flow/ai-providers')
      await closeItermSession(execution.sessionId).catch(() => {})
    } else if (execution.sessionKind === 'tmux' && execution.sessionId) {
      const { spawn } = await import('node:child_process')
      try {
        spawn('tmux', ['kill-session', '-t', execution.sessionId], {
          detached: true,
          stdio: 'ignore',
        }).unref()
      } catch {
        /* nothing to kill */
      }
    }
    executionLogRepo.update(execution.id, {
      finishedAt: new Date().toISOString(),
      outcome: 'cancelled',
      errorMsg: 'cancelled: manual (orphaned)',
    })
    log.warn(
      { id: execution.id, taskId: execution.taskId },
      'Orphaned execution finalized as cancelled',
    )
    return c.json({ ok: true, orphaned: true, execution: executionLogRepo.getById(execution.id) })
  })

  return app
}
