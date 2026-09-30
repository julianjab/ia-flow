/**
 * El contrato de una action de `.config/`: cada `*.ts` de una carpeta `actions/` exporta por
 * default una definición (o una lista) y el runner la registra en su scope:
 *
 *   .config/actions/*.ts                  globales: las ve toda fuente
 *   .config/projects/<id>/actions/*.ts    del proyecto: sólo su fuente, y ganan sobre las globales
 *   actions/_lib/                         helpers: no se registran
 *
 * El runner no arma ninguna acción: le da a cada definición lo que monta —los servicios (GitHub,
 * workspace, …), el proyecto de la fuente que la pide y las `options` del YAML— y la definición
 * hace el resto.
 *
 * ```ts
 * import { defineAction } from '@ia-flow/runner-v2/actions'
 * export default defineAction({ id: 'resolve_task', create: (ctx) => new ResolveTaskAction(…) })
 * ```
 */
import type { Action } from '@ia-flow/agent-engine'
import type { GithubClient } from '@ia-flow/github-api'
import type { SlackClient, SlackUserDirectory } from '@ia-flow/slack-api'
import type { WorkspaceManager, WorkspaceSession } from '@ia-flow/workspace'
import type { AssistantDesk } from '../assistant/AssistantDesk.js'
import type { ProjectConfig } from '../config/RunnerConfig.js'

export type { AssistantDesk } from '../assistant/AssistantDesk.js'
export type { AssistantSession } from '../assistant/AssistantSession.js'
export { ACTION_LABELS, asToolResult } from '../assistant/AssistantSession.js'
export type { ProjectConfig } from '../config/RunnerConfig.js'
export { SlackReviewSchema } from '../config/RunnerConfig.js'

/** Lo que el runner monta y comparte con todas las actions. */
export interface RunnerServices {
  /** GitHub con la identidad del runner. */
  github: GithubClient
  /** Los clones y worktrees de las tasks. */
  workspace: WorkspaceManager
  /** El worktree de CADA corrida, a demanda (`workspaceTargetFor`): lo comparten las tools de
   *  disco y los providers que corren en él (`claude-cli`). */
  session: WorkspaceSession
  /** La credencial de los `git` de red (la de la App). */
  gitCredential: () => Promise<string | undefined>
  /** Slack con el bot token (`SLACK_BOT_TOKEN`); sin token, `enabled` es false. */
  slack: SlackClient
  /** `slack.users` de `runner.yaml`: login de GitHub → usuario de Slack. */
  slackUsers: SlackUserDirectory
  /** Los pedidos abiertos al asistente de la web: las actions `assistant_*` encuentran el suyo. */
  assistant: AssistantDesk
  log: (line: string) => void
}

/** Lo que recibe `create`: quién la pide y con qué. */
export interface ActionContext {
  /** La fuente que la pide: el id de un proyecto, o `runner` (la global). */
  sourceId: string
  /** El agente que la recibe como tool, si la pide un agente. */
  agentId?: string
  /** Las `options` de la entrada del YAML. */
  options: Record<string, unknown>
  /** El proyecto de la fuente que la pide; en la global, ninguno. */
  project?: ProjectConfig
  /** Todos los proyectos montados: para una action global que decide de cuál es un evento. */
  projects(): ProjectConfig[]
  services: RunnerServices
}

export interface ActionDefinition {
  kind: 'action'
  /** El nombre con el que el YAML la pide (`action: <id>`, `tools: [<id>]`). */
  id: string
  create(ctx: ActionContext): Action | Action[]
}

/** Un mapper de `onError` (`input`/`report` a partir del error), por nombre. */
export interface MapperDefinition {
  kind: 'mapper'
  id: string
  map(error: Error): unknown
}

export type Definition = ActionDefinition | MapperDefinition

export function defineAction(definition: Omit<ActionDefinition, 'kind'>): ActionDefinition {
  return { kind: 'action', ...definition }
}

export function defineMapper(definition: Omit<MapperDefinition, 'kind'>): MapperDefinition {
  return { kind: 'mapper', ...definition }
}
