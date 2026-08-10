import type { VariableDefinition } from '@ia-flow/shared'
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
]

export function resolve(
  key: string,
  subpath: string | undefined,
  ctx: ResolveContext,
): string | undefined {
  if (!ctx.project) return ''
  const fullKey = subpath ? `${key}.${subpath}` : key
  return ctx.project[fullKey] ?? ''
}
