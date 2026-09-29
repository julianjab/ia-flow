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
import type { Action } from '@ia-tools/agent-engine'
import type { GithubClient } from '@ia-tools/github-api'
import type { WorkspaceManager } from '@ia-tools/workspace'
import type { ProjectConfig } from '../config/RunnerConfig.js'

export type { ProjectConfig } from '../config/RunnerConfig.js'

/** Lo que el runner monta y comparte con todas las actions. */
export interface RunnerServices {
  /** GitHub con la identidad del runner. */
  github: GithubClient
  /** Los clones y worktrees de las tasks. Sin esto (dry-run), no hay disco. */
  workspace?: WorkspaceManager
  /** La credencial de los `git` de red (sin workspace, en dry-run, no hay). */
  gitCredential?: () => Promise<string | undefined>
  dryRun: boolean
  log: (line: string) => void
  /** Lo que la definición pide y este runner no puede dar — se avisa una vez al arrancar. */
  missingTools: Set<string>
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
