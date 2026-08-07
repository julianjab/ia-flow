import { CONTEXT_ACCESS } from '@ia-flow/shared'
import { createLogger } from '../logger.js'
import { resolveVariable } from '../variables/index.js'
import type { ResolveContext } from '../variables/types.js'

export type { ResolveContext } from '../variables/types.js'

const log = createLogger('variable-resolver')

export function resolveVariables(template: string, ctx: ResolveContext): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (match, path: string) => {
    const trimmed = path.trim()
    const value = resolveVariable(trimmed, ctx)

    if (value === undefined) {
      log.debug({ variable: trimmed }, 'unknown template variable — left as-is')
      return match
    }

    if (ctx.context) {
      const group = groupForPath(trimmed)
      if (group && !CONTEXT_ACCESS[ctx.context].includes(group)) {
        log.warn(
          { variable: trimmed, group, context: ctx.context },
          'variable used outside its allowed context',
        )
      }
    }

    return value
  })
}

function groupForPath(path: string): import('@ia-flow/shared').VariableGroup | undefined {
  const prefix = path.split('.')[0]
  const map: Record<string, import('@ia-flow/shared').VariableGroup> = {
    daemon_url: 'system',
    system: 'system',
    github: 'github',
    context: 'context',
    task: 'task',
    project: 'project',
    variables: 'custom',
  }
  return map[prefix]
}
