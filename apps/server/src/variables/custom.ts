import type { AgentVariableValue, VariableDefinition } from '@ia-flow/shared'
import type { ResolveContext } from './types.js'

export const definitions: VariableDefinition[] = [
  {
    key: 'variables.KEY',
    group: 'custom',
    syntax: '{{...}}',
    description: 'Valor de la variable KEY definida en el agente (reemplaza KEY con el nombre).',
    example: '{{variables.repo_url}}',
    subfields: {
      full: {
        description: 'Detalle completo de la variable ({{variables.KEY.full}}).',
        example: '{{variables.repo_url.full}}',
      },
    },
  },
]

function extractValue(raw: AgentVariableValue, subpath: string | undefined): string {
  if (typeof raw === 'string') return raw
  if (subpath === 'full') return raw.full ?? raw.value
  return raw.value
}

export function resolve(
  key: string,
  subpath: string | undefined,
  ctx: ResolveContext,
): string | undefined {
  if (!ctx.variables || !(key in ctx.variables)) return ''
  return extractValue(ctx.variables[key], subpath)
}
