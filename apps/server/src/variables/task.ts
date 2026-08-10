import type { VariableDefinition } from '@ia-flow/shared'
import { branchNameFor } from '../application/WorkspaceManager.js'
import { resolveRepoField } from './project.js'
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
    key: 'task.branch',
    group: 'task',
    syntax: '{{...}}',
    description:
      'Nombre canónico de la branch git para esta task (`task/<taskId>`). Usalo en prompts para referenciar la branch que el engine preparó.',
    example: '{{task.branch}}',
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
  {
    key: 'task.repo',
    group: 'task',
    syntax: '{{...}}',
    description:
      'Repo actual de la tarea (el único elemento de task.repos cuando tiene 1). Vacío si task.repos está vacío (sin refinar) o tiene múltiples (épica).',
    example: '{{task.repo}}',
    subfields: {
      name: { description: 'Nombre del repo actual.', example: '{{task.repo.name}}' },
      path: { description: 'Path local del repo actual.', example: '{{task.repo.path}}' },
      github: {
        description: 'owner/repo GitHub del repo actual.',
        example: '{{task.repo.github}}',
      },
      workflow: {
        description: 'Workflow del repo actual (worktree | branch | main).',
        example: '{{task.repo.workflow}}',
      },
      context: {
        description:
          'Contexto completo del repo actual (name/path_local/github/workflow/description).',
        example: '{{task.repo.context}}',
      },
      tree: {
        description:
          'Árbol de archivos del repo actual (default depth 2; override con {{task.repo.tree.N}}).',
        example: '{{task.repo.tree.3}}',
      },
    },
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

  if (key === 'branch') {
    const id = (ctx.task as { id?: string }).id
    return id ? branchNameFor(id) : ''
  }

  if (key === 'repo') {
    const repoName = resolveCurrentRepoName(ctx)
    if (!repoName) return ''
    const repo = ctx.projectRepos?.find((r) => r.name === repoName)
    if (!repo) return ''
    if (subpath === 'name') return repo.name
    return resolveRepoField(repo, subpath)
  }

  const task = ctx.task as Record<string, unknown>
  const fullPath = subpath ? `${key}.${subpath}` : key
  return resolvePath(task, fullPath)
}

function resolveCurrentRepoName(ctx: ResolveContext): string | undefined {
  const t = ctx.task as { repos?: string[] }
  if (Array.isArray(t.repos) && t.repos.length === 1) return t.repos[0]
  return undefined
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
