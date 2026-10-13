/** El logger que el gateway necesita: sin contenido de mensajes, sólo metadatos de la llamada. */
export interface GatewayLog {
  info(message: string, attributes?: Record<string, string | number | boolean>): void
  warn(message: string, attributes?: Record<string, string | number | boolean>): void
  error(message: string, attributes?: Record<string, string | number | boolean>): void
}

export const NOOP_LOG: GatewayLog = { info() {}, warn() {}, error() {} }
