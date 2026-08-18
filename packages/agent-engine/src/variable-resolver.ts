import type {
  AgentVariableValue,
  RepoDef,
  Task,
  TemplateContext,
  VariableGroup,
} from '@ia-flow/shared'
import { CONTEXT_ACCESS } from '@ia-flow/shared'
import { createLogger } from './logger.js'

const log = createLogger('variable-resolver')

// Mirrors apps/server's `variables/types.ts::ResolveContext` — kept as its
// own structural definition rather than imported, since the concrete
// variable catalog (variables/{system,task,project,custom}.ts) stays in
// apps/server (it reads live daemon/env state) and is injected here only as
// the `resolve` function below, not as a whole subsystem this package moves.
export interface ResolveContext {
  task: Task
  variables?: Record<string, AgentVariableValue>
  project?: Record<string, string>
  /** All repos configured for this task's project, resolved from IRepoRepository. */
  projectRepos?: RepoDef[]
  tools?: string[]
  context?: TemplateContext
}

/** Central dispatcher for a `{{...}}` path — injected by the host, which owns
 *  the concrete variable catalog (system/task/project/custom groups). */
export type ResolveVariable = (path: string, ctx: ResolveContext) => string | undefined

export function resolveVariables(
  template: string,
  ctx: ResolveContext,
  resolve: ResolveVariable,
): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (match, path: string) => {
    const trimmed = path.trim()
    const value = resolve(trimmed, ctx)

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

function groupForPath(path: string): VariableGroup | undefined {
  const prefix = path.split('.')[0]
  // 'github'/'context' predate VariableGroup's current literal union (pre-
  // existing on main — apps/server's original agents/variable-resolver.ts
  // had the same map). Cast rather than widen the shared type here; this is
  // a mechanical move, not the place to reconcile that drift.
  const map: Record<string, VariableGroup> = {
    daemon_url: 'system',
    system: 'system',
    github: 'github' as VariableGroup,
    context: 'context' as VariableGroup,
    task: 'task',
    project: 'project',
    variables: 'custom',
  }
  return map[prefix]
}
