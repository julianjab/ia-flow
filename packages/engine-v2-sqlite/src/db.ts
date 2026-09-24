import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Archivo PROPIO de v2 — nunca el sqlite de v1 (`~/.config/ia-flow/ia-flow.sqlite`).
 * El punto de este paquete es que v2 pueda persistir su config sin depender
 * de que v1 exista: leer la config de v1 (ver `apps/server/src/adapters/
 * engine-v2/hydrate.ts`) sigue siendo una fuente alternativa, no la única.
 */
export function defaultDbPath(): string {
  return join(homedir(), '.config', 'ia-flow', 'ia-flow-v2.sqlite')
}

/** Una fila por entidad, `data` es el `*Row` completo serializado a JSON —
 *  evita modelar columna por columna algo que ya está tipado como interface
 *  de TS en `packages/engine-v2` (`ProjectRow`/`AgentRow`/`PipelineRow`/
 *  `RepoRow`). `repos` usa clave compuesta porque `name` sólo es único
 *  DENTRO de un proyecto — mismo criterio que `Repo`'s índice estático. */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS repos (
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (project_id, name)
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pipelines (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
`

export function openEngineV2Db(path: string = defaultDbPath()): Database {
  // `Database(..., {create: true})` crea el ARCHIVO, no el directorio — un
  // primer arranque con `~/.config/ia-flow` inexistente reventaría acá.
  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path, { create: true })
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec(SCHEMA)
  return db
}
