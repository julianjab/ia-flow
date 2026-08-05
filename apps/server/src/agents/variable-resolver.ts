import type { Task } from '@ia-flow/shared'

interface ResolveContext {
  task: Task
  variables?: Record<string, string>
  reposContext?: string
}

export function resolveVariables(template: string, ctx: ResolveContext): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (match, path: string) => {
    const trimmed = path.trim()

    if (trimmed === 'context.repos') {
      return ctx.reposContext ?? ''
    }

    if (trimmed.startsWith('variables.')) {
      const key = trimmed.slice('variables.'.length)
      return ctx.variables?.[key] ?? ''
    }

    if (trimmed.startsWith('task.')) {
      return resolvePath(ctx.task as Record<string, unknown>, trimmed.slice('task.'.length))
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
