// Logger minimo — esta app no persiste nada a disco (a diferencia de
// apps/server/src/logger.ts, que escribe daemon.log y reenvía a
// IA_FLOW_REMOTE_LOG_URL): es un proceso standalone, sus logs van a stdout
// y quien lo despliegue (Docker, systemd, lo que sea) decide qué hacer con
// ellos.
import pino from 'pino'

const LOG_LEVEL = (Bun.env.LOG_LEVEL ?? 'info') as pino.Level

const base = pino({
  level: LOG_LEVEL,
  transport: { target: 'pino-pretty', options: { colorize: true } },
})

export interface Log {
  info: (obj: object, msg?: string) => void
  warn: (obj: object, msg?: string) => void
  error: (obj: object, msg?: string) => void
  debug: (obj: object, msg?: string) => void
}

export function createLogger(scope: string): Log {
  const child = base.child({ scope })
  return {
    info: (obj, msg) => child.info(obj, msg),
    warn: (obj, msg) => child.warn(obj, msg),
    error: (obj, msg) => child.error(obj, msg),
    debug: (obj, msg) => child.debug(obj, msg),
  }
}
