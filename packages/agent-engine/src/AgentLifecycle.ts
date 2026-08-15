// AgentLifecycle: the 3 transitions an agent dispatch drives against a
// task-source, plus the config-driven updates each one carries:
//   - start — marks the task as working + applies onProcess/onProcessLabels.
//   - end   — applies onFinish/onFinishLabels (a successful/normal finish).
//   - fail  — applies onError/onErrorLabels (an unsuccessful finish).
// `end`/`fail` intentionally do NOT call `setAgentWorking(false)` or
// post the completion/error comment themselves — both `Agent.run` and the
// complete_task/fail_task tools already do those in a specific order
// relative to their own concerns (drift detection, comment formatting) that
// isn't identical between the two callers. Baking a single order into this
// class would silently change one of them. Callers keep owning that
// ordering; this class owns only "which outcome applies, and apply it."
import type { ITaskSource } from '@ia-flow/issue-sources'
import type { StatusAgentEntry, Task } from '@ia-flow/shared'
import type { IBroadcast } from './contract.js'
import { applyOutcome } from './outcomes.js'
import { type OutcomeEntry, applyErrorOutcome, applySuccessOutcome } from './run-outcome.js'

export class AgentLifecycle {
  constructor(
    private taskSource: ITaskSource,
    private broadcast: IBroadcast,
  ) {}

  /** onStart: setAgentWorking(true) + onProcess/onProcessLabels + broadcast. */
  async start(
    task: Task,
    entry: Pick<StatusAgentEntry, 'onProcess' | 'onProcessLabels'>,
  ): Promise<Task> {
    task = await this.taskSource.setAgentWorking(task, true)
    if (entry.onProcess) {
      task = await applyOutcome(task, entry.onProcess, this.taskSource)
    }
    if (entry.onProcessLabels) {
      task = await applyOutcome(task, entry.onProcessLabels, this.taskSource)
    }
    this.broadcast.send({ type: 'task:updated', task })
    return task
  }

  /** onEnd: applies onFinish/onFinishLabels + broadcast. */
  async end(task: Task, entry: OutcomeEntry): Promise<Task> {
    return applySuccessOutcome(task, entry, this.taskSource, (msg) => this.broadcast.send(msg))
  }

  /** onFail: applies onError/onErrorLabels (with `errMsg` on `task.error`) + broadcast. */
  async fail(task: Task, entry: OutcomeEntry, errMsg?: string): Promise<Task> {
    return applyErrorOutcome(
      task,
      entry,
      this.taskSource,
      (msg) => this.broadcast.send(msg),
      errMsg,
    )
  }
}
