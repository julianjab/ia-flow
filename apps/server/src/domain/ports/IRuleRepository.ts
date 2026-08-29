import type { Rule } from '@ia-flow/shared'

/**
 * Persistencia de reglas.
 *
 * Interfaz angosta a propósito: declara lo que sus dos consumidores necesitan
 * —el matcher (leer las que aplican a un evento) y el CRUD (escribirlas)— y
 * nada más.
 */
export interface IRuleRepository {
  /** `true` cuando el backing store no acepta escrituras (el deploy headless
   *  que define sus reglas por YAML). El CRUD lo consulta para responder un
   *  error legible en vez de tirar. */
  isReadOnly(): boolean

  /**
   * Reglas candidatas para un proyecto: las suyas MÁS las globales.
   *
   * El filtrado fino (tipo de evento, repo, condiciones) lo hace `matchRules`
   * en memoria — es puro y barato, y bajarlo a SQL partiría el criterio en dos
   * lugares que se pueden desincronizar.
   *
   * `projectId` undefined devuelve sólo las globales, que es exactamente lo que
   * corresponde a un evento sin scope: fail-closed.
   */
  visibleTo(projectId?: string): Promise<Rule[]>

  /** Todas, para el CRUD. `scope` acota igual que en `agents-crud`. */
  list(scope?: { projectId?: string | null; global?: boolean }): Promise<Rule[]>

  getById(id: string): Promise<Rule | null>

  upsert(rule: Rule): Promise<Rule>

  deleteById(id: string): Promise<boolean>

  /** Reordena dentro de un ámbito, transaccional. Las posiciones se renumeran
   *  0..n-1 dentro del ámbito — compararlas entre ámbitos no significa nada
   *  (ver el orden por especificidad en `matchRules`). */
  setPositions(ids: string[]): Promise<void>
}
