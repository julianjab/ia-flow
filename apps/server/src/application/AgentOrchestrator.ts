import { existsSync } from 'fs'
import { join } from 'path'
import type { RepoEntry, StatusConfig, Task } from '@ia-flow/shared'
import { gatherContextsForRepos } from '../agents/context-gatherer.js'
import { getPendingTask, registerPendingTask, removePendingTask } from '../agents/pending-tasks.js'
import { resolveVariables } from '../agents/variable-resolver.js'
import type { IBroadcast } from '../domain/ports/IBroadcast.js'
import type { IProjectConfigRepository } from '../domain/ports/IProjectConfigRepository.js'
import type { IProviderRegistry } from '../domain/ports/IProviderRegistry.js'
import type { IRepoRepository } from '../domain/ports/IRepoRepository.js'
import type { IToolRegistry } from '../domain/ports/IToolRegistry.js'
import type { ITransitionManager } from '../domain/ports/ITransitionManager.js'
import { LocalTransitionManager } from '../issue-managers/local/local-transition-manager.js'
import { createLogger } from '../logger.js'
import { getRepoPaths } from '../repos.js'

const log = createLogger('agent-orchestrator')

const HOME = Bun.env.HOME ?? '/Users/julianbuitrago'

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
    const config = await this.configRepo.getConfig()
    if (!config) return false

    const statusConfig = config.statuses?.find(
      (s) => s.name.toLowerCase() === task.status.toLowerCase(),
    )
    if (!statusConfig) return false

    // Collect all entries whose conditions match (or have no conditions = always runs)
    const matchingEntries = statusConfig.agents.filter((entry) =>
      this.evalWhen(task as Record<string, unknown>, entry.when),
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

    try {
      const repoEntries = await this.resolveRepoEntries(statusConfig, task)
      const contexts = await gatherContextsForRepos(repoEntries)
      const reposContext = contexts
        .map((ctx) => {
          let block = `=== ${ctx.name} (${ctx.type}) ===\nPath: ${ctx.path}\nWorkflow: ${ctx.workflow ?? 'branch'}\n`
          if (ctx.claude_md) block += `\nCLAUDE.md:\n${ctx.claude_md}\n`
          if (ctx.directory_tree) block += `\nFile tree:\n${ctx.directory_tree}\n`
          return block
        })
        .join('\n')

      // Run each matching agent in sequence
      for (const entry of matchingEntries) {
        const agentDef = config.agents?.find((a) => a.id === entry.agent)
        if (!agentDef) {
          log.error({ agent: entry.agent }, 'Agent not found in agents registry')
          continue
        }

        task = await manager.setAgentWorking(task, true)
        if (entry.onProcess) {
          task = await this.applyOutcome(task, entry.onProcess, manager)
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
            reposContext,
            project: projectContext,
          })

          const systemPromptBlocks = (agentDef.systemPrompts ?? [])
            .map((id) => config.systemPrompts?.find((sp) => sp.id === id))
            .filter((sp): sp is NonNullable<typeof sp> => sp !== undefined)
            .map((sp) => ({ type: 'text' as const, text: sp.text }))

          const provider = this.providers.get(agentDef.provider)
          const daemonUrl = `http://localhost:${Bun.env.PORT ?? '3001'}`
          const toolSuffix = this.tools.buildToolInstructions(
            agentDef.tools,
            agentDef.provider,
            daemonUrl,
            task.id,
          )
          const ghCtx = manager.getGitHubToolContext?.()

          // Register before run so in-process tools can resolve the manager
          registerPendingTask(task.id, {
            task,
            manager,
            onFinish: entry.onFinish,
            onError: entry.onError,
            broadcast: (msg: object) => this.broadcast.send(msg),
          })

          const primaryContext = contexts[0]
          const output = await provider.run({
            step: 'implement',
            taskId: task.id,
            taskTitle: task.title,
            taskDescription: task.description,
            taskType: task.type,
            repos: task.repos,
            contexts,
            prompt: resolvedPrompt + (toolSuffix ? '\n\n---\n\n' + toolSuffix : ''),
            systemPromptBlocks,
            tools: agentDef.tools,
            maxIters: agentDef.maxIters,
            providerConfig: agentDef.providerConfig,
            githubToolContext: ghCtx ? { github: ghCtx } : undefined,
            cwd: primaryContext?.path,
            workflow: primaryContext?.workflow,
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
              task = await this.applyOutcome(task, entry.onFinish, manager)
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
            task = await this.applyOutcome({ ...task, error: errMsg }, entry.onError, manager)
            this.broadcast.send({ type: 'task:updated', task })
          }
          throw err
        }
      }

      return true
    } catch (err) {
      throw err
    }
  }

  async applyOutcome(task: Task, outcome: string, manager: ITransitionManager): Promise<Task> {
    if (outcome.startsWith('$set:')) {
      const pairs = outcome
        .slice(5)
        .split(',')
        .map((pair) => {
          const eq = pair.indexOf('=')
          return eq >= 0 ? { field: pair.slice(0, eq), value: pair.slice(eq + 1) } : null
        })
        .filter((p): p is { field: string; value: string } => p !== null && !!p.field)

      const extraFields: Record<string, string> = {}
      for (const { field, value } of pairs) {
        if (field.toLowerCase() === 'status') {
          task = await manager.applyTransition(task, value)
        } else {
          extraFields[field] = value
        }
      }
      if (Object.keys(extraFields).length > 0) {
        task = manager.setFields
          ? await manager.setFields(task, extraFields)
          : ({ ...task, ...extraFields } as Task)
      }
      return task
    }
    return manager.applyTransition(task, outcome)
  }

  // GitHub Project field names differ from Task object keys — map the common ones.
  private readonly FIELD_ALIASES: Record<string, string> = {
    'task type': 'type',
    task_type: 'type',
  }

  evalWhen(task: Record<string, unknown>, when: unknown): boolean {
    if (!when) return true

    // legacy Record format → all-AND
    if (!Array.isArray(when)) {
      return Object.entries(when as Record<string, string>).every(([key, op]) =>
        this.evalCondition(task, key, op),
      )
    }

    // new array format: build OR-groups separated by logic='or'
    type Cond = { field: string; op: string; value?: string; logic?: string }
    const conds = when as Cond[]
    if (!conds.length) return true

    const groups: Cond[][] = [[]]
    for (const cond of conds) {
      if (cond.logic === 'or') groups.push([cond])
      else groups[groups.length - 1].push(cond)
    }

    return groups.some((group) =>
      group.every((c) => this.evalCondition(task, c.field, this.condToOp(c))),
    )
  }

  condToOp(c: { op: string; value?: string }): string {
    if (c.op === '$null' || c.op === '$not_null') return c.op
    if (c.op === '!=') return `$ne:${c.value ?? ''}`
    return c.value ?? ''
  }

  private evalCondition(task: Record<string, unknown>, key: string, op: string): boolean {
    const lower = key.toLowerCase()
    const snake = lower.replace(/\s+/g, '_')
    const alias = this.FIELD_ALIASES[lower] ?? this.FIELD_ALIASES[snake]
    const raw = task[key] ?? task[lower] ?? task[snake] ?? (alias ? task[alias] : undefined)
    const value = raw == null ? '' : Array.isArray(raw) ? raw.join(', ') : String(raw)
    if (op === '$null') return value === ''
    if (op === '$not_null') return value !== ''
    if (op.startsWith('$ne:')) return value !== op.slice(4)
    return value === op
  }

  private async resolveRepoEntries(statusConfig: StatusConfig, task: Task): Promise<RepoEntry[]> {
    const repoFilter = statusConfig.context?.repos ?? 'task'

    // 'all' → only explicitly registered repos in the DB
    if (repoFilter === 'all') {
      const dbRepos = this.repoRepo.list()
      const entries: RepoEntry[] = []
      for (const db of dbRepos) {
        if (!db.path) continue
        const expandedPath = db.path.startsWith('~/') ? join(HOME, db.path.slice(2)) : db.path
        if (existsSync(expandedPath)) {
          entries.push({
            name: db.name,
            path: expandedPath,
            type: 'unknown',
            hasGit: existsSync(join(expandedPath, '.git')),
            workflow: db.workflow,
          })
        }
      }
      return entries
    }

    const repoNames = repoFilter === 'task' ? task.repos : repoFilter
    return getRepoPaths(repoNames)
  }
}
