import type { RepoContext, VariableDefinition } from '@ia-flow/shared'
import type { ResolveContext } from './types.js'

export const definitions: VariableDefinition[] = [
  {
    key: 'context.repos',
    group: 'context',
    syntax: '{{...}}',
    description: 'CLAUDE.md + árbol de directorios de todos los repos seleccionados.',
    example: '{{context.repos}}',
  },
  {
    key: 'context.repo',
    group: 'context',
    syntax: '{{...}}',
    description: 'Información del repo principal seleccionado (resumen completo).',
    example: '{{context.repo}}',
    subfields: {
      name: { description: 'Nombre del repo.', example: 'backend' },
      type: {
        description: 'Tipo de repo detectado.',
        example: 'golang | python | frontend | mobile | agent | unknown',
      },
      git_flow: {
        description: 'Flujo de trabajo git configurado.',
        example: 'worktree | branch | main',
      },
      path: { description: 'Ruta absoluta al repo en el filesystem.' },
      claude_md: { description: 'Contenido del CLAUDE.md del repo.' },
      manifest: { description: 'Contenido del manifiesto del repo (package.json, go.mod, etc.).' },
    },
  },
]

function formatRepoSummary(repo: RepoContext): string {
  const lines = [
    `Repo: ${repo.name}`,
    `Type: ${repo.type}`,
    `Workflow: ${repo.workflow ?? 'branch'}`,
    `Path: ${repo.path}`,
  ]
  if (repo.claude_md) lines.push(`\nCLAUDE.md:\n${repo.claude_md}`)
  if (repo.directory_tree) lines.push(`\nFile tree:\n${repo.directory_tree}`)
  return lines.join('\n')
}

export function resolve(
  key: string,
  subpath: string | undefined,
  ctx: ResolveContext,
): string | undefined {
  if (key === 'repos') return ctx.reposContext ?? ''

  if (key === 'repo') {
    const repo = ctx.repos?.[0]
    if (!repo) return ''
    if (!subpath) return formatRepoSummary(repo)
    if (subpath === 'name') return repo.name
    if (subpath === 'type') return repo.type
    if (subpath === 'git_flow') return repo.workflow ?? ''
    if (subpath === 'path') return repo.path
    if (subpath === 'claude_md') return repo.claude_md ?? ''
    if (subpath === 'manifest') return repo.manifest ?? ''
    return ''
  }

  return undefined
}
