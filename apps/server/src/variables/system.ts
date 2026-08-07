import type { VariableDefinition } from '@ia-flow/shared'
import type { ResolveContext } from './types.js'

export const definitions: VariableDefinition[] = [
  {
    key: 'daemon_url',
    group: 'system',
    syntax: '{{...}}',
    description: 'URL base del daemon ia-flow (e.g. http://localhost:3001).',
    example: '{{daemon_url}}',
  },
  {
    key: 'system.date',
    group: 'system',
    syntax: '{{...}}',
    description: 'Fecha actual en formato ISO (YYYY-MM-DD).',
    example: '{{system.date}}',
  },
  {
    key: 'system.tools',
    group: 'system',
    syntax: '{{...}}',
    description: 'Herramientas disponibles para este agente, separadas por coma.',
    example: '{{system.tools}}',
  },
  {
    key: 'system.variables_catalog',
    group: 'system',
    syntax: '{{...}}',
    description:
      'Catálogo completo de variables disponibles para agent-prompt. Úsalo en el system prompt del agente refiner para que sepa qué puede inyectar.',
    example: '{{system.variables_catalog}}',
  },
]

export function resolve(
  key: string,
  _subpath: string | undefined,
  ctx: ResolveContext,
): string | undefined {
  if (key === 'daemon_url') return `http://localhost:${Bun.env.PORT ?? '3001'}`
  if (key === 'date') return new Date().toISOString().split('T')[0]
  if (key === 'tools') return (ctx.tools ?? []).join(', ')
  // system.variables_catalog is resolved by index.ts (avoids circular dep)
  return undefined
}
