export interface IEnvVarRepository {
  get(key: string): string | null
  set(key: string, value: string): void
  delete(key: string): void
  loadIntoProcess(): void
  /**
   * Claves que tienen valor guardado pero NO en uso: el entorno del proceso
   * define esa variable con otro valor, y el entorno gana.
   *
   * Es lo que le permite a la pantalla de Configuración decir la verdad. Sin
   * esto tendría que mostrar "configurada" para una fila que no se está
   * aplicando — y una UI que miente es peor que una que no está. Es también la
   * razón por la que la precedencia PUEDE ser "el entorno gana": el caso
   * confuso queda visible en vez de silencioso.
   *
   * No incluye las que el entorno repite con el MISMO valor: eso es la
   * situación normal de un deploy, no algo que avisar.
   */
  keysOverriddenByEnv(): string[]
}
