import type { Database } from 'bun:sqlite'
import { Agent, Pipeline, Project, Repo } from '@ia-flow/engine-v2'
import { openEngineV2Db } from './db.js'
import { AgentStore, PipelineStore, ProjectStore, RepoStore } from './stores.js'

/**
 * Fachada única del paquete: agrupa los cuatro stores contra UN archivo, y
 * sabe hidratar los catálogos estáticos de `packages/engine-v2` a partir de
 * ellos — el mismo trabajo que `apps/server/src/adapters/engine-v2/
 * hydrate.ts` hace leyendo la config de v1, pero acá la fuente es el sqlite
 * PROPIO de v2. No reemplaza a `hydrate.ts`: son dos fuentes posibles para
 * el mismo catálogo, y quién elige cuál usar es el composition root del
 * host, no esta clase.
 */
export class EngineV2Sqlite {
  readonly projects: ProjectStore
  readonly repos: RepoStore
  readonly agents: AgentStore
  readonly pipelines: PipelineStore

  constructor(private readonly db: Database) {
    this.projects = new ProjectStore(db)
    this.repos = new RepoStore(db)
    this.agents = new AgentStore(db)
    this.pipelines = new PipelineStore(db)
  }

  static open(path?: string): EngineV2Sqlite {
    return new EngineV2Sqlite(openEngineV2Db(path))
  }

  close(): void {
    this.db.close()
  }

  /** Puebla Project/Repo/Agent (los catálogos estáticos por-id) desde este
   *  store. No toca Pipeline — no se autoindexa por id en un Catalog, vive
   *  en el roster de un `Engine` puntual (ver `loadPipelines`). */
  hydrateCatalogs(): void {
    Project.reset()
    Repo.reset()
    Agent.reset()
    for (const row of this.projects.list()) Project.register(Project.fromRow(row))
    for (const row of this.repos.list()) Repo.register(Repo.fromRow(row))
    for (const row of this.agents.list()) Agent.register(Agent.fromRow(row))
  }

  /** Instancias listas para `engine.register(...)` — llamar DESPUÉS de
   *  `hydrateCatalogs()`: una Pipeline con un `AgentAction` necesita que
   *  `Agent.resolve` ya encuentre su agente. */
  loadPipelines(): Pipeline[] {
    return this.pipelines.list().map(Pipeline.fromRow)
  }

  /** Guarda TODO lo que hoy está registrado en los catálogos estáticos +
   *  las Pipeline que se le pasen (el store no las conoce por sí solo, ver
   *  `loadPipelines`) — pensado para un snapshot inicial o para un editor
   *  que construye instancias en memoria y las persiste de una. Un CRUD
   *  fino (upsert de UNA fila) usa los stores (`this.projects.upsert(...)`)
   *  directo, no este método. */
  saveAll(pipelines: Pipeline[]): void {
    for (const project of Project.list()) this.projects.upsert(project.toRow())
    for (const repo of Repo.list()) this.repos.upsert(repo.toRow())
    for (const agent of Agent.list()) this.agents.upsert(agent.toRow())
    for (const pipeline of pipelines) this.pipelines.upsert(pipeline.toRow())
  }
}
