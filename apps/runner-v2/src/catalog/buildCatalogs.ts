/**
 * Lo que la definición de `.config/projects/` nombra y el runner implementa: el catálogo que
 * recibe `@ia-tools/agent-pipeline-yaml`. Casi todo depende de dónde se usa, así que son
 * `ActionProvider`s:
 *
 *   update_issue, <tools del board>   el board del PROYECTO (cada uno tiene el suyo)
 *   post_comment                       firmado con el id del AGENTE que cierra el turno
 *   fs_*, bash_run                     sobre el worktree de la corrida; bash_run con sus OPCIONES
 *                                      (allow/deny, githubAuth, timeout, maxTimeout)
 *   issue_body                         las tools del body que el agente puede tocar (write/check)
 *   resolve_task                       el intake: de un webhook crudo al evento de su task, en
 *                                      el board del PROYECTO (`intake/ResolveTaskAction.ts`)
 *
 * Una tool de disco sin workspace (dry-run) no se ofrece: arma cero acciones y queda en
 * `missingTools` para avisarlo una vez.
 */
import type { Action, McpServerRef, ProviderRegistry } from '@ia-tools/agent-pipeline'
import type { ActionProvider, ActionRequest, YamlCatalogs } from '@ia-tools/agent-pipeline-yaml'
import { WORKSPACE_TOOLS, type WorkspaceSession, workspaceAction } from '@ia-tools/workspace'
import { z } from 'zod'
import type { BoardActions } from '../actions/board.js'
import { issueBodyActions } from '../issue-body.js'

/** Sin `--live` las escrituras a GitHub se simulan: publicar la branch tampoco puede ser real. */
const PUBLISH_WITHOUT_LIVE = ['git push *']

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

const IssueBodyOptions = z.strictObject({
  /** Bloques que el agente reescribe completos. */
  write: z.array(z.string()).default([]),
  /** Checklists (`<bloque>.<campo>`) en los que sólo puede tildar. */
  check: z.array(z.string()).default([]),
})

export interface CatalogDeps {
  /** El board de cada proyecto montado, por id. */
  boards: Map<string, BoardActions>
  providers: ProviderRegistry
  mcpServers: Record<string, McpServerRef>
  /** El worktree de cada corrida para `fs_*` y `bash_run`. Sin esto (dry-run), no se ofrecen. */
  workspace?: WorkspaceSession
  /** La credencial de los `git` de red de un `bash_run` con `githubAuth`. Sin esto (sin `--live`),
   *  publicar queda denegado con un motivo que el agente puede leer. */
  gitCredential?: () => Promise<string | undefined>
  /** Lo que la definición pide y este runner no puede dar — se avisa una vez. */
  missingTools: Set<string>
  /** El `resolve_task` de cada proyecto montado, por id. */
  intake: Map<string, Action>
}

function options<T extends z.ZodType>(schema: T, request: ActionRequest, name: string): z.infer<T> {
  const parsed = schema.safeParse(request.options)
  if (!parsed.success) {
    throw new Error(`${name}: options inválidas\n${z.prettifyError(parsed.error)}`)
  }
  return parsed.data
}

/** Una tool de disco sobre el worktree de la corrida, con sus opciones. Sin workspace (dry-run) no
 *  hay qué ofrecer: arma cero acciones y queda en `missingTools`. */
function diskTool(name: string, request: ActionRequest, deps: CatalogDeps): Action[] {
  const { allow, deny, githubAuth, timeout, maxTimeout } = options(DiskToolOptions, request, name)
  if (!deps.workspace) {
    deps.missingTools.add(`${name} (sin workspace)`)
    return []
  }
  // `githubAuth` sin credencial (sin `--live`): publicar queda denegado con un motivo legible.
  const publish = githubAuth ? deps.gitCredential : undefined
  const offline = githubAuth && !publish ? PUBLISH_WITHOUT_LIVE : []
  return [
    workspaceAction(
      name,
      deps.workspace,
      { ...(allow ? { allow } : {}), deny: [...(deny ?? []), ...offline] },
      {
        ...(publish ? { gitCredential: publish } : {}),
        ...(timeout ? { timeoutMs: durationMs(timeout) } : {}),
        ...(maxTimeout ? { maxTimeoutMs: durationMs(maxTimeout) } : {}),
      },
    ),
  ]
}

export function buildCatalogs(deps: CatalogDeps): YamlCatalogs {
  const board = ({ projectId }: ActionRequest): BoardActions => {
    const found = deps.boards.get(projectId)
    if (!found) throw new Error(`el proyecto "${projectId}" no tiene board montado`)
    return found
  }

  const actions: Record<string, ActionProvider> = {
    update_issue: (request) => board(request).updateIssue,
    post_comment: (request) => {
      if (!request.agentId)
        throw new Error('post_comment firma con el agente: sólo va en un agente')
      return board(request).postComment(request.agentId)
    },
    resolve_task: ({ projectId }) => {
      const found = deps.intake.get(projectId)
      if (!found) throw new Error(`el proyecto "${projectId}" no tiene intake montado`)
      return found
    },
    issue_body: (request) => {
      if (!request.agentId) throw new Error('issue_body es de un agente')
      const permission = options(IssueBodyOptions, request, 'issue_body')
      return issueBodyActions(request.agentId, permission, board(request).client)
    },
  }

  // Las tools del board: las mismas en todos los proyectos, cada una sobre el suyo.
  const sample = deps.boards.values().next().value as BoardActions | undefined
  for (const name of sample?.tools.keys() ?? []) {
    actions[name] = (request) => board(request).tools.get(name) as Action
  }

  for (const name of WORKSPACE_TOOLS) {
    actions[name] = (request) => diskTool(name, request, deps)
  }

  return {
    providers: deps.providers,
    actions,
    mcpServers: deps.mcpServers,
    mappers: {
      /** El reporte de una corrida que falló: el motivo, para el `report` del agente. */
      blockedReport: (err) => ({ summary: `La corrida falló: ${err.message}`, validations: [] }),
    },
  }
}
