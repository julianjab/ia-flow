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
    key: 'task.comments',
    group: 'task',
    syntax: '{{...}}',
    description: 'Comentarios del issue formateados con fecha y cuerpo, uno por bloque.',
    example: '{{task.comments}}',
  },
]

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function formatComments(comments: unknown): string {
  if (!Array.isArray(comments) || comments.length === 0) return ''
  return comments
    .map((c) => {
      const created = typeof c?.created_at === 'string' ? formatDate(c.created_at) : ''
      const body = typeof c?.body === 'string' ? c.body.trim() : ''
      return created ? `[${created}]\n${body}` : body
    })
    .filter(Boolean)
    .join('\n\n')
}

export function resolve(
  key: string,
  subpath: string | undefined,
  ctx: ResolveContext,
): string | undefined {
  if (key === 'comments') return formatComments(ctx.task.comments)

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
