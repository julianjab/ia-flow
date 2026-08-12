import { ExecutionLogFiltersSchema } from '@ia-flow/shared'
import { Hono } from 'hono'
import { getPendingTask, removePendingTask } from '../agents/pending-tasks.js'
import { executionLogRepo } from '../composition/container.js'
import { createLogger } from '../logger.js'

const log = createLogger('executions-route')

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500

export function createExecutionsRouter() {
  const app = new Hono()

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
      projectId: q.projectId,
      taskId: q.taskId,
      agentId: many('agentId'),
      providerId: many('providerId'),
      outcome: many('outcome'),
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
      const { closeItermSession } = await import('../adapters/iterm/provider.js')
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
