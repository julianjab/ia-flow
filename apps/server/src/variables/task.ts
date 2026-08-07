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
    key: 'task.type',
    group: 'task',
    syntax: '{{...}}',
    description: '"functional" | "technical".',
  },
  {
    key: 'task.status',
    group: 'task',
    syntax: '{{...}}',
    description: 'Status actual de la tarea en el pipeline.',
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
    key: 'task.issueNumber',
    group: 'task',
    syntax: '{{...}}',
    description: 'Número del issue.',
  },
  {
    key: 'task.sections.NAME',
    group: 'task',
    syntax: '{{...}}',
    description: 'Sección nombrada del output de un agente previo en el pipeline.',
    example: '{{task.sections.technical_prd}}',
  },

  // ─── Phase-prompt variables ({...} syntax) ───────────────────────────────────
  {
    key: 'task_title',
    group: 'task',
    syntax: '{...}',
    description: 'Título del issue.',
    phases: ['refine-functional', 'refine-technical'],
  },
  {
    key: 'task_description',
    group: 'task',
    syntax: '{...}',
    description: 'Descripción / cuerpo del issue.',
    phases: ['refine-functional', 'refine-technical'],
  },
  {
    key: 'task_type',
    group: 'task',
    syntax: '{...}',
    description: '"functional" | "technical".',
    phases: ['refine-functional', 'refine-technical'],
  },
  {
    key: 'repos',
    group: 'task',
    syntax: '{...}',
    description: 'Repos seleccionados, separados por coma.',
    phases: ['refine-functional', 'refine-technical'],
  },
  {
    key: 'issue_url',
    group: 'task',
    syntax: '{...}',
    description: 'URL completa del issue de GitHub.',
    phases: ['implement'],
  },
  {
    key: 'repo',
    group: 'task',
    syntax: '{...}',
    description: 'Nombre del repo destino.',
    phases: ['implement'],
  },
  {
    key: 'git_context',
    group: 'task',
    syntax: '{...}',
    description: 'Contexto de git (branch / worktree / setup ya aplicado).',
    phases: ['implement'],
  },
]

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

export function resolve(
  key: string,
  subpath: string | undefined,
  ctx: ResolveContext,
): string | undefined {
  const task = ctx.task as Record<string, unknown>
  const fullPath = subpath ? `${key}.${subpath}` : key
  return resolvePath(task, fullPath)
}
