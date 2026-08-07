import type { Task } from '@ia-flow/shared'
import { getAgentVariables } from '@ia-flow/shared'
import { createLogger } from '../logger.js'

const log = createLogger('variable-resolver')

export interface ResolveContext {
  task: Task
  variables?: Record<string, string>
  reposContext?: string
  project?: Record<string, string>
}

const KNOWN_PREFIXES = ['task.', 'project.', 'variables.'] as const
const KNOWN_EXACT_KEYS = new Set(
  getAgentVariables()
    .filter(v => !KNOWN_PREFIXES.some(p => v.key.startsWith(p)))
    .map(v => v.key),
)
const KNOWN_TASK_KEYS = new Set(
  getAgentVariables()
    .filter(v => v.key.startsWith('task.') && !v.key.startsWith('task.sections.'))
    .map(v => v.key.slice('task.'.length)),
)
const KNOWN_PROJECT_KEYS = new Set(
  getAgentVariables()
    .filter(v => v.key.startsWith('project.'))
    .map(v => v.key.slice('project.'.length)),
)

export function resolveVariables(template: string, ctx: ResolveContext): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (match, path: string) => {
    const trimmed = path.trim()

    if (trimmed === 'daemon_url') {
      return `http://localhost:${Bun.env.PORT ?? '3001'}`
    }

    if (trimmed === 'context.repos') {
      return ctx.reposContext ?? ''
    }

    if (trimmed.startsWith('variables.')) {
      const key = trimmed.slice('variables.'.length)
      if (!ctx.variables || !(key in ctx.variables)) {
        log.debug({ variable: trimmed }, 'agent variable not defined')
      }
      return ctx.variables?.[key] ?? ''
    }

    if (trimmed.startsWith('task.')) {
      const rest = trimmed.slice('task.'.length)
      if (!rest.startsWith('sections.') && !KNOWN_TASK_KEYS.has(rest)) {
        log.debug({ variable: trimmed }, 'unknown task.* variable — not in registry')
      }
      return resolvePath(ctx.task as Record<string, unknown>, rest)
    }

    if (trimmed.startsWith('project.')) {
      const key = trimmed.slice('project.'.length)
      if (!KNOWN_PROJECT_KEYS.has(key) && !key.startsWith('field_options.')) {
        log.debug({ variable: trimmed }, 'unknown project.* variable — not in registry')
      }
      return ctx.project?.[key] ?? ''
    }

    if (!KNOWN_EXACT_KEYS.has(trimmed)) {
      log.debug({ variable: trimmed }, 'unknown template variable — left as-is')
    }
    return match
  })
}

function resolvePath(obj: Record<string, unknown>, path: string): string {
  const parts = path.split('.')
  let current: unknown = obj
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return ''
    current = (current as Record<string, unknown>)[part]
  }
  if (typeof current === 'string') return current
  if (Array.isArray(current)) return current.join(', ')
  if (current != null) return String(current)
  return ''
}
