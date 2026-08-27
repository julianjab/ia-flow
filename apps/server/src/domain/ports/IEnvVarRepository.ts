export interface IEnvVarRepository {
  get(key: string): string | null
  set(key: string, value: string): void
  delete(key: string): void
  loadIntoProcess(): void
  /**
   * Claves que `loadIntoProcess` volcó al entorno PISANDO un valor distinto
   * que el proceso ya traía (del shell, del `.env`, del compose).
   *
   * Existe porque después de ese volcado la pregunta "¿de dónde salió este
   * valor?" ya no se puede contestar mirando `Bun.env`: ahí está el de la DB,
   * indistinguible de uno del ambiente. Quien quiera mostrarle al operador de
   * dónde viene lo que corre —la pantalla de Configuración— necesita este
   * registro, tomado en el único momento en que la diferencia todavía existe.
   *
   * Vacío antes del primer `loadIntoProcess`.
   */
  shadowedEnvKeys(): string[]
}
