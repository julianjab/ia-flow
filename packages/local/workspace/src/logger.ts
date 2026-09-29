/**
 * El logger del paquete, inyectado por instancia (`new WorkspaceManager(shell, { log })`).
 *
 * ia-flow resolvía esto con un factory global (`setLoggerFactory`) que el host llamaba al
 * bootear; acá cada `WorkspaceManager` recibe el suyo, así que dos instancias (un runner, un
 * test) no comparten estado global y el paquete no tiene orden de inicialización que respetar.
 * Misma forma que un logger de pino: `(objeto, mensaje)`.
 */
export interface WorkspaceLogger {
  info(obj: object, msg?: string): void
  debug(obj: object, msg?: string): void
  warn(obj: object, msg?: string): void
  error(obj: object, msg?: string): void
}

export const noopLogger: WorkspaceLogger = {
  info() {},
  debug() {},
  warn() {},
  error() {},
}
