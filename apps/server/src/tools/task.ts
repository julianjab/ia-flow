// Task lifecycle tools — called via HTTP by async agents (tmux/iterm)
import { registerTool } from './index.js'
import { getPendingTask, removePendingTask } from '../agents/pending-tasks.js'
import { createLogger } from '../logger.js'

const log = createLogger('tool-task')

registerTool({
  name: 'complete_task',
  description: 'Mark an async task (tmux/iterm session) as complete. Saves the summary as output and applies the configured finish transition. Call this at the end of every tmux/iterm agent session.',
  input_schema: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'Task ID — use the value of {{task.id}} from the prompt' },
      summary: { type: 'string', description: 'What was done: files changed, PR url, branch name, etc.' },
      status: { type: 'string', description: 'Override the target status (optional — defaults to the agent onFinish config)' },
    },
    required: ['task_id', 'summary'],
  },
  async execute(input: any): Promise<string> {
    const entry = getPendingTask(input.task_id)
    if (!entry) return `No pending task '${input.task_id}' — already completed or not registered`

    let { task, manager, onFinish, broadcast } = entry

    try {
      task = await manager.saveOutput(task, input.summary)
      broadcast({ type: 'task:updated', task })

      task = await manager.setAgentWorking(task, false)

      const targetStatus = input.status ?? onFinish
      if (targetStatus) {
        task = await manager.applyTransition(task, targetStatus)
        broadcast({ type: 'task:updated', task })
      }

      removePendingTask(input.task_id)
      log.info({ taskId: input.task_id, status: targetStatus }, 'task completed via tool')
      return `Task '${task.title}' completed → ${targetStatus ?? 'no transition'}`
    } catch (err) {
      log.error({ taskId: input.task_id, err }, 'complete_task failed')
      throw err
    }
  },
})

registerTool({
  name: 'fail_task',
  description: 'Mark an async task as failed. Posts the error and applies the configured error transition.',
  input_schema: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'Task ID — use the value of {{task.id}} from the prompt' },
      error: { type: 'string', description: 'Description of what went wrong' },
    },
    required: ['task_id', 'error'],
  },
  async execute(input: any): Promise<string> {
    const entry = getPendingTask(input.task_id)
    if (!entry) return `No pending task '${input.task_id}'`

    let { task, manager, onError, broadcast } = entry

    try {
      await manager.postError?.(task, input.error)
      task = await manager.setAgentWorking(task, false)

      if (onError) {
        task = await manager.applyTransition({ ...task, error: input.error }, onError)
        broadcast({ type: 'task:updated', task })
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
