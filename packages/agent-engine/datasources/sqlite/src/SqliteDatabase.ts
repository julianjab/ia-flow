/**
 * Lo que el repositorio necesita de una base SQLite: la forma SÍNCRONA que comparten
 * `node:sqlite` (`DatabaseSync`) y `bun:sqlite` (`Database`). El repositorio no importa ninguna de
 * las dos: cada runtime abre la suya (`./node` acá, o un adaptador de la app) y se la pasa.
 *
 * Los parámetros con nombre van con su prefijo (`{ $id: … }`): las dos implementaciones lo aceptan.
 */
export interface SqliteStatement {
  run(...params: any[]): unknown
  /** La primera fila, o `undefined`/`null` si no hay. */
  get(...params: any[]): unknown
  all(...params: any[]): unknown[]
}

export interface SqliteDatabase {
  exec(sql: string): unknown
  prepare(sql: string): SqliteStatement
  close(): void
}
