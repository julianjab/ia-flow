/**
 * El workspace de una máquina: clones persistentes en `<root>/repos` y un worktree por task en
 * `<root>/worktrees`, con la identidad de GitHub de esa máquina para clonar y traer. Lo arman el
 * runner (`boot.ts`) y el host de providers (`--host`, `providers/providerHost.ts`): cada uno el
 * suyo, en su disco.
 */
import { join } from 'node:path'
import {
  NodeShellRunner,
  type WorkspaceLogger,
  WorkspaceManager,
  WorkspaceSession,
} from '@ia-flow/workspace'
import { defaultWorkspaceRoot } from '../config/runnerHome.js'
import { workspaceTargetFor } from './workspaceTarget.js'

/** Los logs del `WorkspaceManager` por el log del runner: `[workspace] <mensaje> <contexto>`. */
function workspaceLogger(log: (line: string) => void): WorkspaceLogger {
  const line = (level: string) => (obj: object, msg?: string) =>
    log(`[workspace${level === 'info' ? '' : ` ${level}`}] ${msg ?? ''} ${JSON.stringify(obj)}`)
  return { info: line('info'), debug: () => {}, warn: line('warn'), error: line('error') }
}

export function mountWorkspace(opts: {
  root?: string
  githubToken: () => Promise<string>
  log: (line: string) => void
}): { workspace: WorkspaceManager; session: WorkspaceSession; root: string } {
  // Sin `WORKSPACE_DIR`: <IA_FLOW_HOME>/workspaces.
  const root = opts.root ?? defaultWorkspaceRoot()
  const workspace = new WorkspaceManager(new NodeShellRunner(), {
    reposBase: join(root, 'repos'),
    worktreeBase: join(root, 'worktrees'),
    githubToken: opts.githubToken,
    // Un PR lo puede pushear otro (un humano, otra máquina): el reviewer tiene que ver el
    // último commit, no el que quedó en el worktree de una corrida anterior.
    syncBranchWithRemote: true,
    log: workspaceLogger(opts.log),
  })
  return { workspace, session: new WorkspaceSession(workspace, workspaceTargetFor), root }
}
