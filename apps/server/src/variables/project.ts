import type { RepoDef, VariableDefinition } from '@ia-flow/shared'
import type { ResolveContext } from './types.js'

export const definitions: VariableDefinition[] = [
  {
    key: 'project.name',
    group: 'project',
    syntax: '{{...}}',
    description: 'Nombre del proyecto.',
  },
  {
    key: 'project.language',
    group: 'project',
    syntax: '{{...}}',
    description: 'Idioma configurado (e.g. "español").',
  },
  {
    key: 'project.fields.FIELD',
    group: 'project',
    syntax: '{{...}}',
    description:
      'Opciones del campo FIELD del proyecto GitHub (reemplaza FIELD con el nombre del campo).',
    example: '{{project.fields.priority}}',
  },
  {
    key: 'project.repos',
    group: 'project',
    syntax: '{{...}}',
    description:
      'Repos del proyecto, como lista markdown "- name — description" (fallback al path o al nombre solo).',
    example: '{{project.repos}}',
  },
  {
    key: 'project.repos.names',
    group: 'project',
    syntax: '{{...}}',
    description: 'Nombres de los repos del proyecto, separados por coma.',
    example: '{{project.repos.names}}',
  },
  {
    key: 'project.repos.NAME',
    group: 'project',
    syntax: '{{...}}',
    description: 'Descripción del repo NAME dentro del proyecto (vacío si no tiene o no existe).',
    example: '{{project.repos.backend}}',
    subfields: {
      path: {
        description: 'Path local del repo NAME.',
        example: '{{project.repos.backend.path}}',
      },
      github: {
        description: 'owner/repo de GitHub del repo NAME (vacío si falta alguno).',
        example: '{{project.repos.backend.github}}',
      },
      workflow: {
        description:
          'Modo de trabajo del repo NAME: "worktree" | "branch" | "main" (vacío si no está configurado).',
        example: '{{project.repos.backend.workflow}}',
      },
      context: {
        description:
          'Contexto completo del repo NAME en formato "clave: valor" por línea (name, path_local, github, workflow, description). Omite claves sin valor.',
        example: '{{project.repos.backend.context}}',
      },
    },
  },
]

function formatRepoList(repos: RepoDef[]): string {
  if (repos.length === 0) return ''
  return repos
    .map((r) => {
      const label = r.description?.trim() || r.path?.trim() || null
      return label ? `- ${r.name} — ${label}` : `- ${r.name}`
    })
    .join('\n')
}

function findRepo(repos: RepoDef[] | undefined, name: string): RepoDef | undefined {
  return repos?.find((r) => r.name === name)
}

function formatRepoContext(repo: RepoDef): string {
  const lines: string[] = [`name: ${repo.name}`]
  if (repo.path?.trim()) lines.push(`path_local: ${repo.path}`)
  if (repo.githubOwner && repo.githubRepo) {
    lines.push(`github: ${repo.githubOwner}/${repo.githubRepo}`)
  }
  if (repo.workflow) lines.push(`workflow: ${repo.workflow}`)
  if (repo.description?.trim()) lines.push(`description: ${repo.description}`)
  return lines.join('\n')
}

export function resolve(
  key: string,
  subpath: string | undefined,
  ctx: ResolveContext,
): string | undefined {
  if (key === 'repos') {
    const repos = ctx.projectRepos ?? []
    if (!subpath) return formatRepoList(repos)
    if (subpath === 'names') return repos.map((r) => r.name).join(', ')

    // subpath is either "NAME" or "NAME.field"
    const dot = subpath.indexOf('.')
    const repoName = dot === -1 ? subpath : subpath.slice(0, dot)
    const field = dot === -1 ? undefined : subpath.slice(dot + 1)
    const repo = findRepo(repos, repoName)
    if (!repo) return ''
    if (!field) return repo.description ?? ''
    if (field === 'path') return repo.path ?? ''
    if (field === 'github') {
      return repo.githubOwner && repo.githubRepo ? `${repo.githubOwner}/${repo.githubRepo}` : ''
    }
    if (field === 'workflow') return repo.workflow ?? ''
    if (field === 'context') return formatRepoContext(repo)
    return ''
  }

  if (!ctx.project) return ''
  const fullKey = subpath ? `${key}.${subpath}` : key
  return ctx.project[fullKey] ?? ''
}
