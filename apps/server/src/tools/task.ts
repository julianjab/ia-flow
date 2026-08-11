import { applyOutcome } from '../agents/outcomes.js'
import { getPendingTask, removePendingTask } from '../agents/pending-tasks.js'
import { createLogger } from '../logger.js'
// Task lifecycle tools — called via HTTP by async agents (tmux/iterm)
import { registerTool } from './index.js'

const log = createLogger('tool-task')

registerTool({
  name: 'complete_task',
  description:
    'Mark an async task (tmux/iterm session) as complete. Saves the summary as output and applies the configured finish transition. Call this at the end of every tmux/iterm agent session.',
  input_schema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'Task ID — use the value of {{task.id}} from the prompt',
      },
      summary: {
        type: 'string',
        description: 'What was done: files changed, PR url, branch name, etc.',
      },
      status: {
        type: 'string',
        description:
          'Override the target status (optional — defaults to the agent onFinish config)',
      },
    },
    required: ['task_id', 'summary'],
  },
  providers: {
    'tmux-claude': { method: 'POST', path: '/api/tools/complete_task' },
    'iterm-claude': { method: 'POST', path: '/api/tools/complete_task' },
  },
  async execute(input: any): Promise<string> {
    const entry = getPendingTask(input.task_id)
    if (!entry) return `No pending task '${input.task_id}' — already completed or not registered`

    const { manager, onFinish, broadcast, initialStatus } = entry

    try {
      await manager.postComment?.(entry.task, input.summary)

      // Write every mutation back to entry.task so the orchestrator sees the
      // post-transition state when the run returns. Skipping this made the
      // "status changed → skip default onFinish" guard read stale data and
      // clobber tool-driven moves (e.g. epic → Blocked overridden by Build).
      entry.task = await manager.setAgentWorking(entry.task, false)

      // If the prompt already moved the task (e.g. set_task_field → "Blocked"),
      // don't clobber that with the default onFinish. Still honor an explicit
      // input.status override — that's the agent asking for a specific move.
      const statusChangedByPrompt = entry.task.status.toLowerCase() !== initialStatus.toLowerCase()
      const defaultOutcome = statusChangedByPrompt ? undefined : onFinish
      const targetOutcome = input.status ?? defaultOutcome
      if (statusChangedByPrompt && !input.status) {
        log.info(
          {
            taskId: input.task_id,
            from: initialStatus,
            to: entry.task.status,
          },
          'Task already moved by tool call — skipping default onFinish',
        )
      }
      if (targetOutcome) {
        entry.task = await applyOutcome(entry.task, targetOutcome, manager)
        broadcast({ type: 'task:updated', task: entry.task })
      }

      try {
        await entry.killSession?.()
      } catch (e) {
        log.warn({ taskId: input.task_id, err: e }, 'killSession threw on complete_task')
      }
      removePendingTask(input.task_id)
      log.info({ taskId: input.task_id, outcome: targetOutcome }, 'task completed via tool')
      return `Task '${entry.task.title}' completed → ${targetOutcome ?? 'no transition'}`
    } catch (err) {
      log.error({ taskId: input.task_id, err }, 'complete_task failed')
      throw err
    }
  },
})

// ─── update_issue_body ────────────────────────────────────────────────────────

registerTool({
  name: 'update_issue_body',
  description:
    'Guarda el resultado del análisis en el issue activo. Funciona para tareas locales y conectadas a GitHub.',
  input_schema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'ID de la tarea — usar el valor de {{task.id}} del prompt.',
      },
      body: {
        type: 'string',
        description: 'Contenido completo en markdown. Reemplaza el body actual del issue.',
      },
    },
    required: ['task_id', 'body'],
  },
  providers: {
    'tmux-claude': { method: 'POST', path: '/api/tools/update_issue_body' },
    'iterm-claude': { method: 'POST', path: '/api/tools/update_issue_body' },
  },
  async execute(input: any): Promise<string> {
    const pending = getPendingTask(input.task_id)
    if (!pending) throw new Error(`No hay tarea activa con id '${input.task_id}'`)
    pending.task = await pending.manager.saveOutput(pending.task, input.body)
    pending.broadcast({ type: 'task:updated', task: pending.task })
    return 'Contenido guardado correctamente.'
  },
})

// ─── add_task_comment ─────────────────────────────────────────────────────────

registerTool({
  name: 'add_task_comment',
  description:
    'Publica un comentario en la tarea activa. Funciona para tareas locales y conectadas a GitHub.',
  input_schema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'ID de la tarea — usar el valor de {{task.id}} del prompt.',
      },
      body: { type: 'string', description: 'Cuerpo del comentario en markdown.' },
    },
    required: ['task_id', 'body'],
  },
  providers: {
    'tmux-claude': { method: 'POST', path: '/api/tools/add_task_comment' },
    'iterm-claude': { method: 'POST', path: '/api/tools/add_task_comment' },
  },
  async execute(input: any): Promise<string> {
    const pending = getPendingTask(input.task_id)
    if (!pending) throw new Error(`No hay tarea activa con id '${input.task_id}'`)
    if (!pending.manager.postComment) {
      throw new Error("El source de esta tarea no soporta 'postComment'")
    }
    await pending.manager.postComment(pending.task, input.body)
    return 'Comentario publicado.'
  },
})

// ─── set_task_field ───────────────────────────────────────────────────────────

registerTool({
  name: 'set_task_field',
  description:
    'Actualiza un campo del proyecto para la tarea activa (e.g. Status, Task Type, Priority, Size, Repos). Agnóstico al source.',
  input_schema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'ID de la tarea — usar el valor de {{task.id}} del prompt.',
      },
      field_name: {
        type: 'string',
        description: 'Nombre del campo tal como aparece en el proyecto (e.g. "Task Type").',
      },
      value: { type: 'string', description: 'Valor a asignar.' },
    },
    required: ['task_id', 'field_name', 'value'],
  },
  providers: {
    'tmux-claude': { method: 'POST', path: '/api/tools/set_task_field' },
    'iterm-claude': { method: 'POST', path: '/api/tools/set_task_field' },
  },
  async execute(input: any): Promise<string> {
    const pending = getPendingTask(input.task_id)
    if (!pending) throw new Error(`No hay tarea activa con id '${input.task_id}'`)
    if (!pending.manager.setFields) {
      throw new Error("El source de esta tarea no soporta 'setFields'")
    }
    pending.task = await pending.manager.setFields(pending.task, {
      [input.field_name]: input.value,
    })
    pending.broadcast({ type: 'task:updated', task: pending.task })
    return `Campo '${input.field_name}' actualizado a '${input.value}'.`
  },
})

// ─── set_task_labels ──────────────────────────────────────────────────────────

registerTool({
  name: 'set_task_labels',
  description:
    'Aplica labels a la tarea activa. En sources sin soporte nativo de labels (local) el llamado se ignora.',
  input_schema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'ID de la tarea — usar el valor de {{task.id}} del prompt.',
      },
      labels: {
        type: 'array',
        items: { type: 'string' },
        description: 'Nombres de labels a aplicar.',
      },
    },
    required: ['task_id', 'labels'],
  },
  providers: {
    'tmux-claude': { method: 'POST', path: '/api/tools/set_task_labels' },
    'iterm-claude': { method: 'POST', path: '/api/tools/set_task_labels' },
  },
  async execute(input: any): Promise<string> {
    const pending = getPendingTask(input.task_id)
    if (!pending) throw new Error(`No hay tarea activa con id '${input.task_id}'`)
    if (!pending.manager.setLabels) {
      throw new Error("El source de esta tarea no soporta 'setLabels'")
    }
    pending.task = await pending.manager.setLabels(pending.task, input.labels)
    return `Labels aplicados: ${input.labels.join(', ')}`
  },
})

// ─── mark_blocked_by ──────────────────────────────────────────────────────────

registerTool({
  name: 'mark_blocked_by',
  description:
    'Marca una relación de bloqueo entre dos issues del mismo source de la tarea activa. Útil al splitear en sub-issues: cada hijo dependiente se marca como blocked_by su(s) prerrequisito(s). GitHub: los IDs son node IDs devueltos por create_github_issue (campo issueId). Local: los IDs son task IDs; el bloqueo se persiste como una sección `## Blocked by` en el body del issue bloqueado.',
  input_schema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description:
          'ID de la tarea activa — usar {{task.id}} del prompt. Sirve para enrutar al source correcto; los issues bloqueado/bloqueante no tienen que ser la tarea activa.',
      },
      blocked_issue_id: {
        type: 'string',
        description: 'ID del issue que quedará marcado como bloqueado (node ID en GitHub).',
      },
      blocking_issue_id: {
        type: 'string',
        description: 'ID del issue que bloquea (el prerrequisito) (node ID en GitHub).',
      },
    },
    required: ['task_id', 'blocked_issue_id', 'blocking_issue_id'],
  },
  providers: {
    'tmux-claude': { method: 'POST', path: '/api/tools/mark_blocked_by' },
    'iterm-claude': { method: 'POST', path: '/api/tools/mark_blocked_by' },
  },
  async execute(input: any): Promise<string> {
    const pending = getPendingTask(input.task_id)
    if (!pending) throw new Error(`No hay tarea activa con id '${input.task_id}'`)
    if (!pending.manager.markBlockedBy) {
      throw new Error("El source de esta tarea no soporta 'markBlockedBy'")
    }
    await pending.manager.markBlockedBy(
      pending.task,
      input.blocked_issue_id,
      input.blocking_issue_id,
    )
    return `Dependencia creada: ${input.blocked_issue_id} blocked by ${input.blocking_issue_id}`
  },
})

registerTool({
  name: 'fail_task',
  description:
    'Mark an async task as failed. Posts the error and applies the configured error transition.',
  input_schema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'Task ID — use the value of {{task.id}} from the prompt',
      },
      error: { type: 'string', description: 'Description of what went wrong' },
    },
    required: ['task_id', 'error'],
  },
  providers: {
    'tmux-claude': { method: 'POST', path: '/api/tools/fail_task' },
    'iterm-claude': { method: 'POST', path: '/api/tools/fail_task' },
  },
  async execute(input: any): Promise<string> {
    const entry = getPendingTask(input.task_id)
    if (!entry) return `No pending task '${input.task_id}'`

    const { manager, onError, broadcast } = entry

    try {
      await manager.postError?.(entry.task, input.error)
      // Same story as complete_task: mutations must land on entry.task so the
      // orchestrator's post-run guard reads the current status.
      entry.task = await manager.setAgentWorking(entry.task, false)

      if (onError) {
        entry.task = await applyOutcome({ ...entry.task, error: input.error }, onError, manager)
        broadcast({ type: 'task:updated', task: entry.task })
      }

      try {
        await entry.killSession?.()
      } catch (e) {
        log.warn({ taskId: input.task_id, err: e }, 'killSession threw on fail_task')
      }
      removePendingTask(input.task_id)
      log.warn({ taskId: input.task_id, error: input.error }, 'task failed via tool')
      return `Task '${entry.task.title}' marked as failed`
    } catch (err) {
      log.error({ taskId: input.task_id, err }, 'fail_task errored')
      throw err
    }
  },
})
