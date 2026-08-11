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

    let { task, manager, onFinish, broadcast } = entry

    try {
      await manager.postComment?.(task, input.summary)

      task = await manager.setAgentWorking(task, false)

      const targetOutcome = input.status ?? onFinish
      if (targetOutcome) {
        task = await applyOutcome(task, targetOutcome, manager)
        broadcast({ type: 'task:updated', task })
      }

      try {
        await entry.killSession?.()
      } catch (e) {
        log.warn({ taskId: input.task_id, err: e }, 'killSession threw on complete_task')
      }
      removePendingTask(input.task_id)
      log.info({ taskId: input.task_id, outcome: targetOutcome }, 'task completed via tool')
      return `Task '${task.title}' completed → ${targetOutcome ?? 'no transition'}`
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

    let { task, manager, onError, broadcast } = entry

    try {
      await manager.postError?.(task, input.error)
      task = await manager.setAgentWorking(task, false)

      if (onError) {
        task = await applyOutcome({ ...task, error: input.error }, onError, manager)
        broadcast({ type: 'task:updated', task })
      }

      try {
        await entry.killSession?.()
      } catch (e) {
        log.warn({ taskId: input.task_id, err: e }, 'killSession threw on fail_task')
      }
      removePendingTask(input.task_id)
      log.warn({ taskId: input.task_id, error: input.error }, 'task failed via tool')
      return `Task '${task.title}' marked as failed`
    } catch (err) {
      log.error({ taskId: input.task_id, err }, 'fail_task errored')
      throw err
    }
  },
})
