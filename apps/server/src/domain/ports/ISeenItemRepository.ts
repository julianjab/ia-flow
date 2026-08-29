/**
 * El status con el que cada item quedó en el scan anterior.
 *
 * Es lo que le permite al scan producir un HECHO (`issue.status_changed`) en
 * vez de una observación (`issue.scanned`). Interfaz angosta: su único
 * consumidor es el diff.
 *
 * Sincrónico a propósito — se consulta por cada item de cada scan, y una
 * promesa ahí sólo agregaría await sin comprar nada (el store es SQLite local,
 * igual que el de repos).
 */
export interface ISeenItemRepository {
  get(projectId: string, itemId: string): string | undefined
  set(projectId: string, itemId: string, status: string): void
  /**
   * Si el proyecto ya fue escaneado alguna vez.
   *
   * Distingue "board vacío" de "primer scan", que es lo que decide si el diff
   * emite o sólo aprende. Sin esto, el primer scan de un board de 200 issues
   * emitiría 200 `issue.created`.
   */
  hasSeen(projectId: string): boolean
}
