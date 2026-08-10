import { CONTEXT_ACCESS, type TemplateContext, type VariableDefinition } from '@ia-flow/shared'
import * as customVars from './custom.js'
import * as projectVars from './project.js'
import * as systemVars from './system.js'
import * as taskVars from './task.js'
import type { ResolveContext } from './types.js'

export type { ResolveContext } from './types.js'

export const ALL_DEFINITIONS: VariableDefinition[] = [
  ...systemVars.definitions,
  ...taskVars.definitions,
  ...projectVars.definitions,
  ...customVars.definitions,
]

export function getVariableDefinitions(ctx?: TemplateContext): VariableDefinition[] {
  if (!ctx) return ALL_DEFINITIONS
  const allowed = CONTEXT_ACCESS[ctx]
  return ALL_DEFINITIONS.filter((v) => allowed.includes(v.group))
}

export function formatVariableCatalog(ctx: TemplateContext): string {
  const defs = getVariableDefinitions(ctx)
  const byGroup = new Map<string, VariableDefinition[]>()
  for (const d of defs) {
    if (!byGroup.has(d.group)) byGroup.set(d.group, [])
    byGroup.get(d.group)!.push(d)
  }

  return [...byGroup.entries()]
    .map(([group, vars]) => {
      const lines = vars.flatMap((v) => {
        const main = `- \`{{${v.key}}}\` — ${v.description}`
        const sub = v.subfields
          ? Object.entries(v.subfields).map(([sf, meta]) => {
              const sfKey = v.key.replace(/\.KEY$/, `.KEY.${sf}`).replace(/\.\w+$/, `.${sf}`)
              return `  - \`{{${sfKey}}}\` — ${meta.description}${meta.example ? ` (ej: ${meta.example})` : ''}`
            })
          : []
        return [main, ...sub]
      })
      return `### ${group}\n${lines.join('\n')}`
    })
    .join('\n\n')
}

/** Central dispatcher: resolves any {{...}} path to its value given a ResolveContext. */
export function resolveVariable(path: string, ctx: ResolveContext): string | undefined {
  const [prefix, second, ...rest] = path.split('.')
  const subpath = rest.length ? rest.join('.') : undefined

  switch (prefix) {
    case 'daemon_url':
      return systemVars.resolve('daemon_url', undefined, ctx)
    case 'system':
      if (second === 'variables_catalog') return formatVariableCatalog('agent-prompt')
      return systemVars.resolve(second ?? '', subpath, ctx)
    case 'task':
      return taskVars.resolve(second ?? '', subpath, ctx)
    case 'project':
      return projectVars.resolve(second ?? '', subpath, ctx)
    case 'variables':
      return customVars.resolve(second ?? '', rest[0], ctx)
    default:
      return undefined
  }
}
