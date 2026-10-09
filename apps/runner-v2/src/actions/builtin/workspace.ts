/**
 * `fs_*` y `bash_run`: las tools de disco, sobre el worktree de la corrida (el de la task del
 * evento: `src/workspace/workspaceTarget.ts`, la `session` de los servicios). `bash_run` lleva sus OPCIONES del YAML: allow/deny,
 * githubAuth, timeout, maxTimeout, maxMemoryMb.
 *
 * `workspace_reset`: el agente descarta su worktree y lo recrea limpio. `cleanup_workspace`: paso
 * de pipeline que suelta el worktree si no tiene trabajo en riesgo.
 *
 * `run_agent`: delega en un sub-agente del repo (`.claude/agents/*.md` del worktree). Sus
 * opciones: `provider` (default `anthropic-api`), `write` (si sus sub-agentes escriben: entonces
 * la entrada necesita `allowWrite`), `models` (alias → id), `providerConfig`, y las de
 * `bash_run` para el `bash_run` de sus sub-agentes.
 */

import type { Action } from '@ia-flow/agent-engine'
import {
  CleanupWorkspaceAction,
  ResetWorkspaceAction,
  RunAgentAction,
  WORKSPACE_TOOLS,
  workspaceAction,
} from '@ia-flow/workspace'
import { z } from 'zod'
import { type ActionContext, defineAction, type RunnerServices } from '../defineAction.js'

const Duration = z.string().regex(/^\d+(s|m|h)$/, 'una duración: `30s`, `45m`, `2h`')
const DURATION_MS = { s: 1_000, m: 60_000, h: 3_600_000 } as const
const durationMs = (duration: string) =>
  Number(duration.slice(0, -1)) * DURATION_MS[duration.at(-1) as keyof typeof DURATION_MS]

const DiskToolOptions = z.strictObject({
  allow: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional(),
  /** Sólo `bash_run`: los `git` de red reciben la credencial de la App — el agente publica su
   *  branch. */
  githubAuth: z.boolean().optional(),
  /** Sólo `bash_run`: cuánto corre un comando si el agente no pide otra cosa. */
  timeout: Duration.optional(),
  /** Sólo `bash_run`: lo máximo que el agente puede pedir por comando. */
  maxTimeout: Duration.optional(),
  // Tope de memoria por comando de `bash_run`, en MB. Sin esto, 2048.
  maxMemoryMb: z.number().int().positive().optional(),
})

/** Lo que una tool de workspace necesita de quien la arma: el worktree de cada corrida y la
 *  credencial de los `git` de red. El runner le da los suyos; un host remoto, los de su máquina. */
export type WorkspaceToolDeps = Pick<RunnerServices, 'session' | 'gitCredential'>

/** Las tools de workspace que un host remoto puede rearmar sobre su worktree (ver
 *  `Tool.origin`). `run_agent` no: delega en un provider del runner. */
export const HOST_WORKSPACE_TOOLS: ReadonlySet<string> = new Set([
  ...WORKSPACE_TOOLS,
  'workspace_reset',
])

/** Una tool de workspace con sus `options` del YAML, armada sobre `deps`. */
export function workspaceTool(
  name: string,
  options: Record<string, unknown>,
  deps: WorkspaceToolDeps,
): Action {
  if (name === 'workspace_reset') return new ResetWorkspaceAction(deps.session)
  if (!WORKSPACE_TOOLS.has(name)) throw new Error(`${name}: no es una tool de workspace`)
  return diskTool(name, options, deps)
}

function diskTool(name: string, options: Record<string, unknown>, deps: WorkspaceToolDeps): Action {
  const parsed = DiskToolOptions.safeParse(options)
  if (!parsed.success)
    throw new Error(`${name}: options inválidas\n${z.prettifyError(parsed.error)}`)
  const { allow, deny, githubAuth, timeout, maxTimeout, maxMemoryMb } = parsed.data
  const publish = githubAuth ? deps.gitCredential : undefined
  return workspaceAction(
    name,
    deps.session,
    { ...(allow ? { allow } : {}), deny: deny ?? [] },
    {
      ...(publish ? { gitCredential: publish } : {}),
      ...(timeout ? { timeoutMs: durationMs(timeout) } : {}),
      ...(maxTimeout ? { maxTimeoutMs: durationMs(maxTimeout) } : {}),
      ...(maxMemoryMb ? { maxMemoryBytes: maxMemoryMb * 1024 ** 2 } : {}),
    },
  )
}

const RunAgentOptions = DiskToolOptions.extend({
  provider: z.string().min(1).default('anthropic-api'),
  write: z.boolean().optional(),
  models: z.record(z.string(), z.string()).optional(),
  providerConfig: z.record(z.string(), z.unknown()).optional(),
})

function runAgent(ctx: ActionContext): Action {
  const parsed = RunAgentOptions.safeParse(ctx.options)
  if (!parsed.success)
    throw new Error(`run_agent: options inválidas\n${z.prettifyError(parsed.error)}`)
  const {
    provider,
    write,
    models,
    providerConfig,
    allow,
    deny,
    githubAuth,
    timeout,
    maxTimeout,
    maxMemoryMb,
  } = parsed.data
  const publish = githubAuth ? ctx.services.gitCredential : undefined
  return new RunAgentAction(ctx.services.session, {
    provider,
    ...(write ? { write } : {}),
    ...(models ? { models } : {}),
    ...(providerConfig ? { providerConfig } : {}),
    policy: { ...(allow ? { allow } : {}), deny: deny ?? [] },
    bash: {
      ...(publish ? { gitCredential: publish } : {}),
      ...(timeout ? { timeoutMs: durationMs(timeout) } : {}),
      ...(maxTimeout ? { maxTimeoutMs: durationMs(maxTimeout) } : {}),
      ...(maxMemoryMb ? { maxMemoryBytes: maxMemoryMb * 1024 ** 2 } : {}),
    },
  })
}

export default [
  ...[...WORKSPACE_TOOLS].map((name) =>
    defineAction({ id: name, create: (ctx) => diskTool(name, ctx.options, ctx.services) }),
  ),
  defineAction({ id: 'run_agent', create: runAgent }),
  // El agente descarta su worktree y arranca de nuevo (escribe: necesita `allowWrite`).
  defineAction({
    id: 'workspace_reset',
    create: (ctx) => new ResetWorkspaceAction(ctx.services.session),
  }),
  // Paso de pipeline: suelta el worktree si no tiene trabajo en riesgo.
  defineAction({
    id: 'cleanup_workspace',
    create: (ctx) => new CleanupWorkspaceAction(ctx.services.session),
  }),
]
