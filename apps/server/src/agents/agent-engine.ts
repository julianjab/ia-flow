import { existsSync } from 'fs'
import { join } from 'path'
import type { ProjectConfig, RepoEntry, StatusConfig, Task } from '@ia-flow/shared'
import { LocalTransitionManager } from '../adapters/local/transition-manager.js'
import { repoRepo } from '../composition/container.js'
import { getProjectConfig } from '../config/project-config.js'
import type { TransitionManager } from '../issue-managers/transition-manager.js'
import { createLogger } from '../logger.js'
import { getProvider } from '../providers/index.js'
import { getRepoPaths } from '../repos.js'
import { gatherContextsForRepos } from './context-gatherer.js'
import { getPendingTask, registerPendingTask, removePendingTask } from './pending-tasks.js'
import { resolveVariables } from './variable-resolver.js'

const log = createLogger('agent-engine')

const HOME = Bun.env.HOME ?? '/Users/julianbuitrago'

type BroadcastFn = (msg: object) => void

export async function runAgent(
  task: Task,
  broadcast: BroadcastFn,
  manager: TransitionManager = new LocalTransitionManager(),
): Promise<boolean> {
  const config = await getProjectConfig()
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
  const repoEntries = await resolveRepoEntries(statusConfig, task, config)
  const contexts = await gatherContextsForRepos(repoEntries)
  const reposContext = contexts
    .map((ctx) => {
      let block = `=== ${ctx.name} (${ctx.type}) ===\nPath: ${ctx.path}\nWorkflow: ${ctx.workflow ?? 'branch'}\n`
      if (ctx.claude_md) block += `\nCLAUDE.md:\n${ctx.claude_md}\n`
      if (ctx.directory_tree) block += `\nFile tree:\n${ctx.directory_tree}\n`
      return block
    })
    .join('\n')

  // Run each matching agent in sequence; each uses its own transitions
  for (const entry of matchingEntries) {
    const agentDef = config.agents?.find((a) => a.id === entry.agent)
    if (!agentDef) {
      console.error(`[agent-engine] Agent '${entry.agent}' not found in agents registry`)
      continue
    }

    task = await manager.setAgentWorking(task, true)
    if (entry.onProcess) {
      task = await applyOutcome(task, entry.onProcess, manager)
    }
    broadcast({ type: 'task:updated', task })

    try {
      const projectContext: Record<string, string> = {
        ...((config.project as Record<string, string> | undefined) ?? {}),
        ...(manager.getProjectContext?.() ?? {}),
      }
      const resolvedPrompt = resolveVariables(agentDef.prompt, {
        task,
        variables: agentDef.variables,
        reposContext,
        repos: contexts,
        project: projectContext,
        tools: agentDef.tools,
        context: 'agent-prompt',
      })

      const systemPromptBlocks = (agentDef.systemPrompts ?? [])
        .map((id) => config.systemPrompts?.find((sp) => sp.id === id))
        .filter((sp): sp is NonNullable<typeof sp> => sp !== undefined)
        .map((sp) => ({
          type: 'text' as const,
          text: resolveVariables(sp.text, {
            task,
            variables: agentDef.variables,
            tools: agentDef.tools,
            context: 'system-prompt',
          }),
        }))

      const provider = getProvider(agentDef.provider)
      const sourceToolContext = manager.getSourceToolContext?.()

      // Register before run so in-process tools (update_issue_body, etc.) can resolve the manager
      registerPendingTask(task.id, {
        task,
        manager,
        onFinish: entry.onFinish,
        onError: entry.onError,
        broadcast,
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
        prompt: resolvedPrompt,
        systemPromptBlocks,
        tools: agentDef.tools,
        maxIters: agentDef.maxIters,
        providerConfig: agentDef.providerConfig,
        sourceToolContext,
        cwd: primaryContext?.path,
        workflow: primaryContext?.workflow,
      })

      if (output.mode === 'tmux') {
        // Async session — stays registered until complete_task / fail_task clears it
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
          broadcast({ type: 'task:updated', task })
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
        broadcast({ type: 'task:updated', task })
      }
      throw err
    }
  }

  return true
}

async function resolveRepoEntries(
  statusConfig: StatusConfig,
  task: Task,
  _config: ProjectConfig,
): Promise<RepoEntry[]> {
  const repoFilter = statusConfig.context?.repos ?? 'task'

  // 'all' → only explicitly registered repos in the DB (scan roots are for autocomplete only)
  if (repoFilter === 'all') {
    const dbRepos = repoRepo.list()
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

// Apply an outcome string: either a legacy status transition or "$set:field=val,field=val" assignments.
// When field is "status", delegates to applyTransition so remote managers (GitHub, Linear) sync correctly.
export async function applyOutcome(
  task: Task,
  outcome: string,
  manager: TransitionManager,
): Promise<Task> {
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
const FIELD_ALIASES: Record<string, string> = {
  'task type': 'type',
  task_type: 'type',
}

// Evaluate a when block: supports both legacy Record<string,string> (all-AND)
// and new array format where each entry carries its own `logic` connector.
// OR has lower precedence: splits the list into AND-groups, any group matching → true.
export function evalWhen(task: Record<string, unknown>, when: unknown): boolean {
  if (!when) return true

  // legacy Record format → all-AND
  if (!Array.isArray(when)) {
    return Object.entries(when as Record<string, string>).every(([key, op]) =>
      evalCondition(task, key, op),
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

  return groups.some((group) => group.every((c) => evalCondition(task, c.field, condToOp(c))))
}

export function condToOp(c: { op: string; value?: string }): string {
  if (c.op === '$null' || c.op === '$not_null') return c.op
  if (c.op === '!=') return `$ne:${c.value ?? ''}`
  return c.value ?? ''
}

function evalCondition(task: Record<string, unknown>, key: string, op: string): boolean {
  // Try: exact → lowercase → snake_case → known alias
  const lower = key.toLowerCase()
  const snake = lower.replace(/\s+/g, '_')
  const alias = FIELD_ALIASES[lower] ?? FIELD_ALIASES[snake]
  const raw = task[key] ?? task[lower] ?? task[snake] ?? (alias ? task[alias] : undefined)
  const value = raw == null ? '' : Array.isArray(raw) ? raw.join(', ') : String(raw)
  if (op === '$null') return value === ''
  if (op === '$not_null') return value !== ''
  if (op.startsWith('$ne:')) return value !== op.slice(4)
  return value === op
}
