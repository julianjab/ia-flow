/**
 * Registra las actions de `.config/` respetando la jerarquía: las de `actions/` (globales) y las
 * de `projects/<id>/actions/` (del proyecto). Una fuente de proyecto ve primero las suyas y después
 * las globales; la global, sólo las globales. Un id repetido dentro del mismo scope rompe el
 * arranque.
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Action } from '@ia-tools/agent-engine'
import type { ActionProvider, ActionRequest, Catalogs } from '@ia-tools/agent-engine-definitions'
import type { ProjectConfig } from '../config/RunnerConfig.js'
import type {
  ActionDefinition,
  Definition,
  MapperDefinition,
  RunnerServices,
} from './defineAction.js'

/** El id de la fuente global (la raíz de `.config`). */
export const GLOBAL_SOURCE = 'runner'

const MODULE = /\.ts$/
const NOT_A_MODULE = /\.(test|d)\.ts$/

interface Scope {
  actions: Map<string, { definition: ActionDefinition; file: string }>
  mappers: Map<string, { definition: MapperDefinition; file: string }>
}

export interface LoadedActions {
  catalogs: Pick<Catalogs, 'actions' | 'mappers'>
  /** Qué registró cada scope: `runner` y el id de cada proyecto. */
  registered: Record<string, string[]>
}

function isDefinition(value: unknown): value is Definition {
  const kind = (value as { kind?: unknown } | null)?.kind
  return (
    (kind === 'action' || kind === 'mapper') && typeof (value as { id?: unknown }).id === 'string'
  )
}

/** Cada `*.ts` que está directo en `dir` (los de `_lib/` y los tests no). */
async function loadScope(dir: string): Promise<Scope> {
  const scope: Scope = { actions: new Map(), mappers: new Map() }
  if (!existsSync(dir)) return scope
  const files = readdirSync(dir)
    .filter((name) => MODULE.test(name) && !NOT_A_MODULE.test(name))
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile())
    .sort()
  for (const file of files) {
    const exported = ((await import(pathToFileURL(file).href)) as { default?: unknown }).default
    const definitions = [exported].flat()
    if (definitions.length === 0 || !definitions.every(isDefinition)) {
      throw new Error(
        `${file}: tiene que exportar por default una definición (defineAction/defineMapper) o una lista`,
      )
    }
    for (const definition of definitions) {
      const registry = (definition.kind === 'action' ? scope.actions : scope.mappers) as Map<
        string,
        { definition: Definition; file: string }
      >
      const existing = registry.get(definition.id)
      if (existing) {
        throw new Error(`${file}: "${definition.id}" ya está definida en ${existing.file}`)
      }
      registry.set(definition.id, { definition, file })
    }
  }
  return scope
}

export async function loadActions(
  configDir: string,
  projects: ProjectConfig[],
  services: RunnerServices,
): Promise<LoadedActions> {
  const global = await loadScope(join(configDir, 'actions'))
  const own = new Map<string, Scope>()
  for (const project of projects) own.set(project.id, await loadScope(join(project.dir, 'actions')))

  const provider =
    (name: string): ActionProvider =>
    (request: ActionRequest): Action | Action[] => {
      const project = projects.find((candidate) => candidate.id === request.sourceId)
      const found = (project && own.get(project.id)?.actions.get(name)) ?? global.actions.get(name)
      if (!found) {
        throw new Error(`la action "${name}" no está en ${request.sourceId} ni entre las globales`)
      }
      return found.definition.create({
        sourceId: request.sourceId,
        ...(request.agentId ? { agentId: request.agentId } : {}),
        options: request.options,
        ...(project ? { project } : {}),
        projects: () => projects,
        services,
      })
    }

  const names = new Set([
    ...global.actions.keys(),
    ...[...own.values()].flatMap((scope) => [...scope.actions.keys()]),
  ])
  const mappers: Record<string, (err: Error) => unknown> = {}
  for (const scope of [global, ...own.values()]) {
    for (const [id, { definition, file }] of scope.mappers) {
      if (id in mappers)
        throw new Error(`${file}: el mapper "${id}" ya está definido en otro scope`)
      mappers[id] = definition.map
    }
  }

  return {
    catalogs: {
      actions: Object.fromEntries([...names].map((name) => [name, provider(name)])),
      mappers,
    },
    registered: {
      [GLOBAL_SOURCE]: [...global.actions.keys(), ...global.mappers.keys()].sort(),
      ...Object.fromEntries(
        [...own].map(([id, scope]) => [
          id,
          [...scope.actions.keys(), ...scope.mappers.keys()].sort(),
        ]),
      ),
    },
  }
}
