import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import type { Task, AgentConfig, AgentStepConfig, RepoEntry, ProjectConfig } from '@ia-flow/shared'
import { getProjectConfig, CONFIG_DIR } from '../config/project-config.js'
import { resolveVariables } from './variable-resolver.js'
import { gatherContextsForRepos } from './context-gatherer.js'
import { getRepoPaths } from '../repos.js'
import { getProvider } from '../providers/index.js'
import { moveTask, updateTask } from '../store.js'

const HOME = Bun.env.HOME ?? '/Users/julianbuitrago'

type BroadcastFn = (msg: object) => void

export async function runAgent(task: Task, broadcast: BroadcastFn): Promise<boolean> {
  const config = await getProjectConfig()
  if (!config) return false

  const agentConfig = config.agents.find((a) => a.onStatus === task.status)
  if (!agentConfig) return false

  // Move to onProcess while running
  if (agentConfig.onProcess) {
    task = await moveTask(task, agentConfig.onProcess)
    broadcast({ type: 'task:updated', task })
  }

  try {
    const stepConfig = resolveVariant(agentConfig, task)
    const repoEntries = await resolveRepoEntries(agentConfig, task, config)
    const contexts = await gatherContextsForRepos(repoEntries)

    // Build repos context string for {{context.repos}}
    const reposContext = contexts
      .map((ctx) => {
        let block = `=== ${ctx.name} (${ctx.type}) ===\nPath: ${ctx.path}\n`
        if (ctx.claude_md) block += `\nCLAUDE.md:\n${ctx.claude_md}\n`
        if (ctx.directory_tree) block += `\nFile tree:\n${ctx.directory_tree}\n`
        return block
      })
      .join('\n')

    const promptTemplate = await loadPrompt(stepConfig.prompt)
    const resolvedPrompt = resolveVariables(promptTemplate, {
      task,
      variables: stepConfig.variables,
      reposContext,
    })

    const provider = getProvider(stepConfig.provider)
    const output = await provider.run({
      step: 'implement',
      taskTitle: task.title,
      taskDescription: task.description,
      taskType: task.type,
      repos: task.repos,
      contexts,
      prompt: resolvedPrompt,
    })

    // Save output to section
    if (stepConfig.output?.section && output.content) {
      task = {
        ...task,
        sections: {
          ...task.sections,
          [stepConfig.output.section]: output.content,
        },
      }
      await updateTask(task)
    }

    // Move to onFinish
    if (agentConfig.onFinish) {
      task = await moveTask(task, agentConfig.onFinish)
      broadcast({ type: 'task:updated', task })
    }

    return true
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    console.error(`[agent-engine] Error running agent for task ${task.id}:`, errMsg)

    if (agentConfig.onError) {
      const errTask: Task = { ...task, error: errMsg }
      const moved = await moveTask(errTask, agentConfig.onError)
      broadcast({ type: 'task:updated', task: moved })
    }
    throw err
  }
}

// Returns the effective step config after applying the first matching variant
function resolveVariant(agentConfig: AgentConfig, task: Task): AgentStepConfig {
  if (!agentConfig.variants?.length) return agentConfig.default

  for (const variant of agentConfig.variants) {
    const { when, ...overrides } = variant
    const matches = Object.entries(when).every(([key, value]) => {
      const taskValue = (task as Record<string, unknown>)[key]
      return String(taskValue) === String(value)
    })
    if (matches) {
      return { ...agentConfig.default, ...overrides }
    }
  }

  return agentConfig.default
}

async function resolveRepoEntries(
  agentConfig: AgentConfig,
  task: Task,
  config: ProjectConfig,
): Promise<RepoEntry[]> {
  const repoFilter = agentConfig.context?.repos ?? 'task'
  const repoNames = repoFilter === 'task' ? task.repos : repoFilter

  const registry = config.repos ?? {}
  const entries: RepoEntry[] = []
  const missing: string[] = []

  for (const name of repoNames) {
    const entry = registry[name]
    if (entry) {
      const expandedPath = entry.path.startsWith('~/')
        ? join(HOME, entry.path.slice(2))
        : entry.path
      entries.push({ name, path: expandedPath, type: entry.type })
    } else {
      missing.push(name)
    }
  }

  // Fall back to auto-discovery for repos not in registry
  if (missing.length > 0) {
    const discovered = await getRepoPaths(missing)
    entries.push(...discovered)
  }

  return entries
}

// Loads prompt content from a file path (./relative or /absolute) or returns it as-is if inline
async function loadPrompt(prompt: string): Promise<string> {
  if (prompt.startsWith('./') || prompt.startsWith('/')) {
    const resolved = prompt.startsWith('/')
      ? prompt
      : join(CONFIG_DIR, prompt.slice(2))

    if (!existsSync(resolved)) {
      throw new Error(`Prompt file not found: ${resolved}`)
    }
    return readFile(resolved, 'utf-8')
  }
  return prompt
}
