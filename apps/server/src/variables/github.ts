import type { VariableDefinition } from '@ia-flow/shared'
import type { ResolveContext } from './types.js'

export const definitions: VariableDefinition[] = [
  {
    key: 'github.issue_number',
    group: 'github',
    syntax: '{{...}}',
    description: 'Número del issue de GitHub en curso.',
    example: '{{github.issue_number}}',
  },
  {
    key: 'github.issue_url',
    group: 'github',
    syntax: '{{...}}',
    description: 'URL completa del issue de GitHub en curso.',
    example: '{{github.issue_url}}',
  },
  {
    key: 'github.labels',
    group: 'github',
    syntax: '{{...}}',
    description: 'Labels del issue, separados por coma.',
    example: '{{github.labels}}',
  },
]

export function resolve(
  key: string,
  _subpath: string | undefined,
  ctx: ResolveContext,
): string | undefined {
  if (key === 'issue_number') return String(ctx.task.issueNumber ?? '')
  if (key === 'issue_url') return ctx.task.issueUrl ?? ''
  if (key === 'labels') {
    const labels = (ctx.task as Record<string, unknown>).labels
    if (Array.isArray(labels)) return labels.join(', ')
    return ''
  }
  return undefined
}
