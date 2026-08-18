import type {
  AgentToolEntry,
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

// A resolved variable value that contains whitespace or "*" changes the
// TOKEN structure `matchesBashPattern` parses (packages/tools/src/exec/
// pattern.ts) — e.g. {{task.branch}} resolving to "* --force" would widen
// "git push origin {{task.branch}}" into "git push origin *". Unlike the
// prompt (free text, injection is harmless), a pattern's safety depends on
// its exact tokens, so this is stricter than `resolveVariables`: it throws
// instead of degrading silently.
const UNSAFE_PATTERN_VALUE = /[\s*]/

function resolveBashPattern(
  pattern: string,
  ctx: ResolveContext,
  resolve: ResolveVariable,
): string {
  return pattern.replace(/\{\{([^}]+)\}\}/g, (_match, path: string) => {
    const trimmed = path.trim()
    const value = resolve(trimmed, ctx)
    if (value === undefined) {
      // Unlike the prompt, leaving this as a literal "{{...}}" is NOT safe
      // to fall back on: in an `allow` pattern the entry just never matches
      // (annoying but closed), but in `deny` it silently stops blocking
      // whatever the operator meant to block — a security regression with
      // no visible error. Refuse the whole run instead.
      throw new Error(
        `bash_run pattern "${pattern}" references unknown variable {{${trimmed}}} — refusing to dispatch with an unresolved allow/deny pattern`,
      )
    }
    if (UNSAFE_PATTERN_VALUE.test(value)) {
      throw new Error(
        `bash_run pattern "${pattern}": {{${trimmed}}} resolved to "${value}", which contains whitespace or "*" — refusing to let a resolved value change the pattern's token structure`,
      )
    }
    return value
  })
}

/** Resuelve {{...}} dentro de los patrones allow/deny de la entry bash_run,
 *  si existe. Las entries string (nombres de tool planos) pasan sin tocar —
 *  nunca contienen variables. No muta `tools`; devuelve un array nuevo.
 *  Lanza si una variable no resuelve o si el valor resuelto podría alterar
 *  la semántica del patrón (ver `resolveBashPattern`) — un patrón bash es
 *  seguridad, no texto libre como el prompt. */
export function resolveBashRunPatterns(
  tools: AgentToolEntry[] | undefined,
  ctx: ResolveContext,
  resolve: ResolveVariable,
): AgentToolEntry[] | undefined {
  if (!tools) return tools
  return tools.map((t) =>
    typeof t === 'string'
      ? t
      : {
          ...t,
          allow: t.allow.map((p) => resolveBashPattern(p, ctx, resolve)),
          deny: t.deny.map((p) => resolveBashPattern(p, ctx, resolve)),
        },
  )
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
