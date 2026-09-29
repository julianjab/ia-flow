/**
 * `fs_*` y `bash_run`: las tools de disco, sobre el worktree de la corrida (el de la task del
 * evento: `_lib/workspaceTarget.ts`). `bash_run` lleva sus OPCIONES del YAML: allow/deny,
 * githubAuth, timeout, maxTimeout.
 */

import { type ActionContext, defineAction } from '@ia-flow/runner-v2/actions'
import type { Action } from '@ia-tools/agent-engine'
import {
  WORKSPACE_TOOLS,
  type WorkspaceManager,
  WorkspaceSession,
  workspaceAction,
} from '@ia-tools/workspace'
import { z } from 'zod'
import { workspaceTargetFor } from './_lib/workspaceTarget.js'

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
})

/** Una sesión por manager: el worktree de cada corrida se resuelve del evento. */
const sessions = new WeakMap<WorkspaceManager, WorkspaceSession>()
function sessionOf(manager: WorkspaceManager): WorkspaceSession {
  let session = sessions.get(manager)
  if (!session) {
    session = new WorkspaceSession(manager, workspaceTargetFor)
    sessions.set(manager, session)
  }
  return session
}

function diskTool(name: string, ctx: ActionContext): Action {
  const parsed = DiskToolOptions.safeParse(ctx.options)
  if (!parsed.success)
    throw new Error(`${name}: options inválidas\n${z.prettifyError(parsed.error)}`)
  const { allow, deny, githubAuth, timeout, maxTimeout } = parsed.data
  const { workspace, gitCredential } = ctx.services
  const publish = githubAuth ? gitCredential : undefined
  return workspaceAction(
    name,
    sessionOf(workspace),
    { ...(allow ? { allow } : {}), deny: deny ?? [] },
    {
      ...(publish ? { gitCredential: publish } : {}),
      ...(timeout ? { timeoutMs: durationMs(timeout) } : {}),
      ...(maxTimeout ? { maxTimeoutMs: durationMs(maxTimeout) } : {}),
    },
  )
}

export default [...WORKSPACE_TOOLS].map((name) =>
  defineAction({ id: name, create: (ctx) => diskTool(name, ctx) }),
)
