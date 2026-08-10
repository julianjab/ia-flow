import type { VariableDefinition } from '@ia-flow/shared'
import type { ResolveContext } from './types.js'

export const definitions: VariableDefinition[] = [
  {
    key: 'task.id',
    group: 'task',
    syntax: '{{...}}',
    description: 'ID interno de la tarea (para llamadas a complete_task / fail_task).',
  },
  {
    key: 'task.title',
    group: 'task',
    syntax: '{{...}}',
    description: 'Título del issue.',
  },
  {
    key: 'task.description',
    group: 'task',
    syntax: '{{...}}',
    description: 'Cuerpo completo del issue.',
  },
  {
    key: 'task.repos',
    group: 'task',
    syntax: '{{...}}',
    description: 'Repos seleccionados, separados por coma.',
  },
  {
    key: 'task.issueUrl',
    group: 'task',
    syntax: '{{...}}',
    description: 'URL completa del issue de GitHub.',
  },
  {
    key: 'task.context',
    group: 'task',
    syntax: '{{...}}',
    description: 'CLAUDE.md + árbol de directorios de los repos seleccionados por la tarea.',
    example: '{{task.context}}',
  },
]

export function resolve(
  key: string,
  subpath: string | undefined,
  ctx: ResolveContext,
): string | undefined {
  if (key === 'context') return ctx.reposContext ?? ''

  const task = ctx.task as Record<string, unknown>
  const fullPath = subpath ? `${key}.${subpath}` : key
  return resolvePath(task, fullPath)
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
