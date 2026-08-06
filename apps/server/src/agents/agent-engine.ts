import { join } from 'path'
import { existsSync } from 'fs'
import type { Task, StatusConfig, ProjectConfig, RepoEntry } from '@ia-flow/shared'
import { getProjectConfig } from '../config/project-config.js'
import { resolveVariables } from './variable-resolver.js'
import { gatherContextsForRepos } from './context-gatherer.js'
import { getRepoPaths, listRepos } from '../repos.js'
import { listDbRepos } from '../db.js'
import { getProvider, loadProviderConfig } from '../providers/index.js'
import type { TransitionManager } from '../issue-managers/transition-manager.js'
import { LocalTransitionManager } from '../issue-managers/local/local-transition-manager.js'
import { registerPendingTask } from './pending-tasks.js'
import { createLogger } from '../logger.js'

const log = createLogger('agent-engine')

const HOME = Bun.env.HOME ?? '/Users/julianbuitrago'

type BroadcastFn = (msg: object) => void

export async function runAgent(
  task: Task,
  broadcast: BroadcastFn,
  manager: TransitionManager = new LocalTransitionManager(),
): Promise<boolean> {
  const [config, providerConfig] = await Promise.all([getProjectConfig(), loadProviderConfig()])
  if (!config) return false

  const statusConfig = config.statuses?.find(s => s.name.toLowerCase() === task.status.toLowerCase())
  if (!statusConfig) return false

  // Collect all entries whose conditions match (or have no conditions = always runs)
  const matchingEntries = statusConfig.agents.filter(entry => evalWhen(task as Record<string, unknown>, entry.when))

  if (!matchingEntries.length) {
    if (statusConfig.agents.length > 0) {
      // Agents are configured but none matched — annotate task and leave it in place
      const conditionsSummary = statusConfig.agents
        .filter(e => e.when)
        .map(e => {
          const when = e.when!
          const parts = Array.isArray(when)
            ? when.map((c, i) => `${i > 0 ? ` ${(c.logic ?? 'AND').toUpperCase()} ` : ''}${c.field}${c.op === '=' ? '=' : c.op === '!=' ? '≠' : ` ${c.op}`}${c.value ?? ''}`)
            : Object.entries(when).map(([k, v]) => `${k}=${v}`)
          return `- ${e.agent}: ${parts.join('')}`
        })
        .join('\n')
      const message = [
        `⚠️ Ningún agente tomó esta tarea en el status **${task.status}**.`,
        `Las condiciones evaluadas fueron:`,
        conditionsSummary,
        `Revisa los campos de la tarea o ajusta las condiciones en la configuración.`,
      ].join('\n')
      const warningContent = `${task.description}\n\n---\n${message}`
      task = await manager.saveOutput(task, warningContent)
      broadcast({ type: 'task:updated', task })
    }
    return false
  }

  try {
    const repoEntries = await resolveRepoEntries(statusConfig, task, config)
    const contexts = await gatherContextsForRepos(repoEntries)
    const reposContext = contexts.map(ctx => {
      let block = `=== ${ctx.name} (${ctx.type}) ===\nPath: ${ctx.path}\n`
      if (ctx.claude_md) block += `\nCLAUDE.md:\n${ctx.claude_md}\n`
      if (ctx.directory_tree) block += `\nFile tree:\n${ctx.directory_tree}\n`
      return block
    }).join('\n')

    // Run each matching agent in sequence; each uses its own transitions
    for (const entry of matchingEntries) {
      const agentDef = config.agents?.find(a => a.id === entry.agent)
      if (!agentDef) {
        console.error(`[agent-engine] Agent '${entry.agent}' not found in agents registry`)
        continue
      }

      task = await manager.setAgentWorking(task, true)
      broadcast({ type: 'task:updated', task })

      try {
        const projectContext: Record<string, string> = {
          ...(config.project as Record<string, string> | undefined ?? {}),
          ...(manager.getProjectContext?.() ?? {}),
        }
        const resolvedPrompt = resolveVariables(agentDef.prompt, {
          task,
          variables: agentDef.variables,
          reposContext,
          project: projectContext,
        })

        const systemPromptBlocks = (agentDef.systemPrompts ?? [])
          .map(id => config.systemPrompts?.find(sp => sp.id === id))
          .filter((sp): sp is NonNullable<typeof sp> => sp !== undefined)
          .map(sp => ({ type: 'text' as const, text: sp.text }))

        const provider = getProvider(agentDef.provider)
        const availableCallbacks = providerConfig.providerCallbacks?.[agentDef.provider] ?? []
        const selectedCallbackNames = agentDef.callbacks  // undefined = all
        const callbacksToInject = selectedCallbackNames === undefined
          ? availableCallbacks
          : availableCallbacks.filter(cb => selectedCallbackNames.includes(cb.name))
        const callbackSuffix = callbacksToInject.length
          ? '\n\n---\n\n' + callbacksToInject
              .map(cb => resolveVariables(cb.text, { task, variables: agentDef.variables, project: projectContext }))
              .join('\n\n')
          : ''
        const ghCtx = manager.getGitHubToolContext?.()
        const output = await provider.run({
          step: 'implement',
          taskTitle: task.title,
          taskDescription: task.description,
          taskType: task.type,
          repos: task.repos,
          contexts,
          prompt: resolvedPrompt + callbackSuffix,
          systemPromptBlocks,
          tools: agentDef.tools,
          githubToolContext: ghCtx ? { github: ghCtx } : undefined,
        })

        if (output.mode === 'tmux') {
          // Async session — register so complete_task / fail_task tools can finish it
          registerPendingTask(task.id, { task, manager, onFinish: entry.onFinish, onError: entry.onError, broadcast })
          log.info({ taskId: task.id, session: output.tmuxSession }, 'async session started — awaiting complete_task callback')
        } else {
          if (output.content) {
            task = await manager.saveOutput(task, output.content)
            broadcast({ type: 'task:updated', task })
          }

          task = await manager.setAgentWorking(task, false)

          if (entry.onFinish) {
            task = await applyOutcome(task, entry.onFinish, manager)
            broadcast({ type: 'task:updated', task })
          }
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        console.error(`[agent-engine] Error running agent '${entry.agent}' for task ${task.id}:`, errMsg)
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
  } catch (err) {
    throw err
  }
}

async function resolveRepoEntries(statusConfig: StatusConfig, task: Task, config: ProjectConfig): Promise<RepoEntry[]> {
  const repoFilter = statusConfig.context?.repos ?? 'task'

  // 'all' → union of auto-discovered repos + DB-mapped repos with a valid path
  if (repoFilter === 'all') {
    const [discovered, dbRepos] = await Promise.all([listRepos(), Promise.resolve(listDbRepos())])
    const entries: RepoEntry[] = [...discovered]
    for (const db of dbRepos) {
      if (db.path && !entries.find((e) => e.name === db.name) && existsSync(db.path)) {
        entries.push({ name: db.name, path: db.path, type: 'unknown', hasGit: existsSync(join(db.path, '.git')) })
      }
    }
    return entries
  }

  const repoNames = repoFilter === 'task' ? task.repos : repoFilter
  const registry = config.repos ?? {}
  const entries: RepoEntry[] = []
  const missing: string[] = []

  for (const name of repoNames) {
    const entry = registry[name]
    if (entry) {
      const expandedPath = entry.path.startsWith('~/') ? join(HOME, entry.path.slice(2)) : entry.path
      entries.push({ name, path: expandedPath, type: entry.type })
    } else {
      missing.push(name)
    }
  }

  if (missing.length) entries.push(...await getRepoPaths(missing))
  return entries
}

// Apply an outcome string: either a legacy status transition or "$set:field=val,field=val" assignments.
// When field is "status", delegates to applyTransition so remote managers (GitHub, Linear) sync correctly.
export async function applyOutcome(task: Task, outcome: string, manager: TransitionManager): Promise<Task> {
  if (outcome.startsWith('$set:')) {
    const pairs = outcome.slice(5).split(',').map(pair => {
      const eq = pair.indexOf('=')
      return eq >= 0 ? { field: pair.slice(0, eq), value: pair.slice(eq + 1) } : null
    }).filter((p): p is { field: string; value: string } => p !== null && !!p.field)

    for (const { field, value } of pairs) {
      if (field === 'status') {
        task = await manager.applyTransition(task, value)
      } else {
        task = { ...task, [field]: value } as Task
      }
    }
    return task
  }
  return manager.applyTransition(task, outcome)
}

// GitHub Project field names differ from Task object keys — map the common ones.
const FIELD_ALIASES: Record<string, string> = {
  'task type': 'type',
  'task_type': 'type',
}

// Evaluate a when block: supports both legacy Record<string,string> (all-AND)
// and new array format where each entry carries its own `logic` connector.
// OR has lower precedence: splits the list into AND-groups, any group matching → true.
export function evalWhen(task: Record<string, unknown>, when: unknown): boolean {
  if (!when) return true

  // legacy Record format → all-AND
  if (!Array.isArray(when)) {
    return Object.entries(when as Record<string, string>).every(([key, op]) =>
      evalCondition(task, key, op)
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

  return groups.some(group =>
    group.every(c => evalCondition(task, c.field, condToOp(c)))
  )
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
  if (op === '$null')        return value === ''
  if (op === '$not_null')    return value !== ''
  if (op.startsWith('$ne:')) return value !== op.slice(4)
  return value === op
}
