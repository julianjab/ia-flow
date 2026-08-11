import { join } from 'path'
import type { Task } from '@ia-flow/shared'
import { LocalTransitionManager } from '../adapters/local/transition-manager.js'
import { applyOutcome, evalWhen } from '../agents/outcomes.js'
import { getPendingTask, registerPendingTask, removePendingTask } from '../agents/pending-tasks.js'
import { resolveVariables } from '../agents/variable-resolver.js'
import type { IBroadcast } from '../domain/ports/IBroadcast.js'
import type { IProjectConfigRepository } from '../domain/ports/IProjectConfigRepository.js'
import type { IProviderRegistry } from '../domain/ports/IProviderRegistry.js'
import type { IRepoRepository } from '../domain/ports/IRepoRepository.js'
import type { IToolRegistry } from '../domain/ports/IToolRegistry.js'
import type { ITransitionManager } from '../domain/ports/ITransitionManager.js'
import { createLogger } from '../logger.js'

const log = createLogger('agent-orchestrator')

const HOME = Bun.env.HOME ?? ''
function expandHome(p: string): string {
  return p.startsWith('~/') ? join(HOME, p.slice(2)) : p
}

export class AgentOrchestrator {
  constructor(
    private providers: IProviderRegistry,
    private tools: IToolRegistry,
    private configRepo: IProjectConfigRepository,
    private repoRepo: IRepoRepository,
    private broadcast: IBroadcast,
  ) {}

  async runAgent(
    task: Task,
    manager: ITransitionManager = new LocalTransitionManager(),
  ): Promise<boolean> {
    // Scope the config lookup to the task's project when known — matches how
    // TaskDispatcher fetched it. Legacy callers without projectId fall back to
    // the default project (SqliteProjectConfigRepo.getConfig undefined path).
    const config = await this.configRepo.getConfig(task.projectId)
    if (!config) return false

    const statusConfig = config.statuses?.find(
      (s) => s.name.toLowerCase() === task.status.toLowerCase(),
    )
    if (!statusConfig) return false

    // Collect all entries whose conditions match (or have no conditions = always runs)
    const matchingEntries = statusConfig.agents.filter((entry) =>
      evalWhen(task as Record<string, unknown>, entry.when),
    )

    if (!matchingEntries.length) {
      if (statusConfig.agents.length > 0) {
        const conditionsSummary = statusConfig.agents
          .filter((e) => e.when)
          .map((e) => {
            const when = e.when!
            const parts = Array.isArray(when)
              ? when.map(
                  (c, i) =>
                    `${i > 0 ? ` ${(c.logic ?? 'AND').toUpperCase()} ` : ''}${c.field}${c.op === '=' ? '=' : c.op === '!=' ? '≠' : ` ${c.op}`}${c.value ?? ''}`,
                )
              : Object.entries(when).map(([k, v]) => `${k}=${v}`)
            return `${e.agent}: ${parts.join(' ')}`
          })
          .join(' | ')
        log.warn(
          { status: task.status, conditions: conditionsSummary },
          'No agent matched — skipping',
        )
      }
      return false
    }
    // All project repos → name→path map so fs tools can resolve any repo
    // in the project (not just those on the task). The agent learns names
    // via `{{project.repos}}` in its prompt and navigates via read_file /
    // list_dir / grep_files.
    const projectRepos = task.projectId
      ? this.repoRepo.listByProject(task.projectId)
      : this.repoRepo.list()
    const repoPaths: Record<string, string> = {}
    for (const r of projectRepos) {
      if (r.path) repoPaths[r.name] = expandHome(r.path)
    }
    // Primary task repo drives cwd/workflow for terminal providers.
    const primaryTaskRepo = projectRepos.find((r) => task.repos.includes(r.name))
    const primaryPath = primaryTaskRepo?.path ? expandHome(primaryTaskRepo.path) : undefined
    const primaryWorkflow = primaryTaskRepo?.workflow

    // Run each matching agent in sequence
    for (const entry of matchingEntries) {
      const agentDef = config.agents?.find((a) => a.id === entry.agent)
      if (!agentDef) {
        log.error({ agent: entry.agent }, 'Agent not found in agents registry')
        continue
      }

      task = await manager.setAgentWorking(task, true)
      if (entry.onProcess) {
        task = await applyOutcome(task, entry.onProcess, manager)
      }
      this.broadcast.send({ type: 'task:updated', task })

      try {
        const projectContext: Record<string, string> = {
          ...((config.project as Record<string, string> | undefined) ?? {}),
          ...(manager.getProjectContext?.() ?? {}),
        }
        const resolvedPrompt = resolveVariables(agentDef.prompt, {
          task,
          variables: agentDef.variables,
          project: projectContext,
          projectRepos,
        })

        const systemPromptBlocks = (agentDef.systemPrompts ?? [])
          .map((id) => config.systemPrompts?.find((sp) => sp.id === id))
          .filter((sp): sp is NonNullable<typeof sp> => sp !== undefined)
          .map((sp) => ({ type: 'text' as const, text: sp.text }))

        const provider = this.providers.get(agentDef.provider)
        // Tool instructions used to be assembled here and prepended to the
        // prompt. That responsibility now lives in the terminal provider
        // (see terminal-provider-base.buildToolsAppendix) so anthropic-api
        // stays lean and each provider owns its own contract.
        const sourceToolContext = manager.getSourceToolContext?.()

        // Register before run so in-process tools can resolve the manager
        registerPendingTask(task.id, {
          task,
          manager,
          onFinish: entry.onFinish,
          onError: entry.onError,
          broadcast: (msg: object) => this.broadcast.send(msg),
        })

        const output = await provider.run({
          step: 'implement',
          taskId: task.id,
          taskTitle: task.title,
          taskDescription: task.description,
          taskType: task.type,
          repos: task.repos,
          repoPaths,
          prompt: resolvedPrompt,
          systemPromptBlocks,
          tools: agentDef.tools,
          maxIters: agentDef.maxIters,
          providerConfig: agentDef.providerConfig,
          sourceToolContext,
          cwd: primaryPath,
          workflow: primaryWorkflow,
        })

        if (output.mode === 'tmux') {
          log.info(
            { taskId: task.id, session: output.tmuxSession },
            'async session started — awaiting tool callback',
          )
        } else {
          // Sync (API) — pick up any task mutations from in-process tool calls, then clean up
          task = getPendingTask(task.id)?.task ?? task
          removePendingTask(task.id)

          task = await manager.setAgentWorking(task, false)

          if (entry.onFinish) {
            task = await applyOutcome(task, entry.onFinish, manager)
            this.broadcast.send({ type: 'task:updated', task })
          }
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        log.error(
          { event: 'agent.error', taskId: task.id, agent: entry.agent, err: errMsg },
          'Agent run failed',
        )
        task = await manager.setAgentWorking(task, false)
        if (entry.onError) {
          await manager.postError?.(task, errMsg)
          task = await applyOutcome({ ...task, error: errMsg }, entry.onError, manager)
          this.broadcast.send({ type: 'task:updated', task })
        }
        throw err
      }
    }

    return true
  }
}
