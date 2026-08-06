import { join } from 'path'
import { existsSync } from 'fs'
import type { Task, StatusConfig, ProjectConfig, RepoEntry } from '@ia-flow/shared'
import { getProjectConfig } from '../config/project-config.js'
import { resolveVariables } from './variable-resolver.js'
import { gatherContextsForRepos } from './context-gatherer.js'
import { getRepoPaths, listRepos } from '../repos.js'
import { listDbRepos } from '../db.js'
import { getProvider } from '../providers/index.js'
import type { TransitionManager } from '../issue-managers/transition-manager.js'
import { LocalTransitionManager } from '../issue-managers/local/local-transition-manager.js'

const HOME = Bun.env.HOME ?? '/Users/julianbuitrago'

type BroadcastFn = (msg: object) => void

export async function runAgent(
  task: Task,
  broadcast: BroadcastFn,
  manager: TransitionManager = new LocalTransitionManager(),
): Promise<boolean> {
  const config = await getProjectConfig()
  if (!config) return false

  const statusConfig = config.statuses?.find(s => s.name.toLowerCase() === task.status.toLowerCase())
  if (!statusConfig) return false

  // Collect all entries whose conditions match (or have no conditions = always runs)
  const matchingEntries = statusConfig.agents.filter(entry => {
    if (!entry.when) return true
    return Object.entries(entry.when).every(([key, value]) =>
      evalCondition(task as Record<string, unknown>, key, value)
    )
  })

  if (!matchingEntries.length) {
    if (statusConfig.agents.length > 0) {
      // Agents are configured but none matched — annotate task and leave it in place
      const conditionsSummary = statusConfig.agents
        .filter(e => e.when)
        .map(e => `- ${e.agent}: ${Object.entries(e.when!).map(([k, v]) => `${k}=${v}`).join(', ')}`)
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
        const ghCtx = manager.getGitHubToolContext?.()
        const output = await provider.run({
          step: 'implement',
          taskTitle: task.title,
          taskDescription: task.description,
          taskType: task.type,
          repos: task.repos,
          contexts,
          prompt: resolvedPrompt,
          systemPromptBlocks,
          tools: agentDef.tools,
          githubToolContext: ghCtx ? { github: ghCtx } : undefined,
        })

        if (output.content) {
          task = await manager.saveOutput(task, output.content)
          broadcast({ type: 'task:updated', task })
        }

        task = await manager.setAgentWorking(task, false)

        if (entry.onFinish) {
          task = await manager.applyTransition(task, entry.onFinish)
          broadcast({ type: 'task:updated', task })
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        console.error(`[agent-engine] Error running agent '${entry.agent}' for task ${task.id}:`, errMsg)
        task = await manager.setAgentWorking(task, false)
        if (entry.onError) {
          await manager.postError?.(task, errMsg)
          task = await manager.applyTransition({ ...task, error: errMsg }, entry.onError)
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

// GitHub Project field names differ from Task object keys — map the common ones.
const FIELD_ALIASES: Record<string, string> = {
  'task type': 'type',
  'task_type': 'type',
}

function evalCondition(task: Record<string, unknown>, key: string, op: string): boolean {
  // Try: exact → lowercase → snake_case → known alias
  const lower = key.toLowerCase()
  const snake = lower.replace(/\s+/g, '_')
  const alias = FIELD_ALIASES[lower] ?? FIELD_ALIASES[snake]
  const raw = task[key] ?? task[lower] ?? task[snake] ?? (alias ? task[alias] : undefined)
  const value = raw == null ? '' : Array.isArray(raw) ? raw.join(', ') : String(raw)
  if (op === '$null')     return value === ''
  if (op === '$not_null') return value !== ''
  return value === op
}
