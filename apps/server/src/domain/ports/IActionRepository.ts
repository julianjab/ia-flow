import type { NamedAction } from '@ia-flow/shared'

/**
 * Persistencia de acciones con nombre.
 *
 * Interfaz angosta y del mismo tamaño que `IRuleRepository`, a propósito: son
 * la misma clase de entidad —configuración con ámbito, editable desde la UI o
 * fija por YAML— y darles formas distintas obligaría a cada consumidor a
 * aprender dos.
 */
export interface IActionRepository {
  /** `true` cuando el backing store no acepta escrituras (el deploy headless
   *  que define sus acciones por YAML). El CRUD lo consulta para responder un
   *  error legible en vez de tirar. */
  isReadOnly(): boolean

  /**
   * Las visibles para un proyecto: las suyas MÁS las globales.
   *
   * Es lo que resuelve una `ref` al ejecutar, y es también lo que hace
   * imposible por construcción referenciar la acción de OTRO proyecto: nunca
   * entra en el resultado.
   *
   * `projectId` undefined devuelve sólo las globales — el mismo fail-closed
   * que `IRuleRepository.visibleTo`.
   */
  visibleTo(projectId?: string): Promise<NamedAction[]>

  /** Todas, para el CRUD. `scope` acota igual que en `rules`. */
  list(scope?: { projectId?: string | null; global?: boolean }): Promise<NamedAction[]>

  getById(id: string): Promise<NamedAction | null>

  upsert(action: NamedAction): Promise<NamedAction>

  deleteById(id: string): Promise<boolean>
}
