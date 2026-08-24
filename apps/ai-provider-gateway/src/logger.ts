// Logger del gateway — pretty a stdout + JSON a archivo.
//
// El archivo existe por cómo se lo levanta de verdad: `IA Flow Gateway.app`
// (apps/desktop) lo spawnea y sólo repite su stdout al stdout de Electron,
// que abierto desde el Finder no va a ningún lado. Sin archivo, la única
// forma de ver por qué falló un run era relanzar la app desde una terminal.
//
// Convive con apps/server/src/logger.ts: mismo $IA_FLOW_LOG_DIR, archivo
// aparte (`gateway.log` junto a `daemon.log`), así un solo env mueve los dos
// procesos. Lo que NO copia es el forward a IA_FLOW_REMOTE_LOG_URL: el
// gateway no es un daemon de ia-flow, no tiene UI de logs a la que alimentar.
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import pino from 'pino'

const LOG_LEVEL = (Bun.env.LOG_LEVEL ?? 'info') as pino.Level

export interface LogEnv {
  HOME?: string
  IA_FLOW_CONFIG_DIR?: string
  IA_FLOW_LOG_DIR?: string
  IA_FLOW_GATEWAY_LOG_FILE?: string
}

/**
 * Dónde escribir, según el entorno. Cadena de defaults igual a la del state
 * file (state.ts): override explícito → $IA_FLOW_LOG_DIR → $IA_FLOW_CONFIG_DIR
 * → ~/.config/ia-flow.
 *
 * Un `IA_FLOW_GATEWAY_LOG_FILE` vacío apaga el archivo: en un container los
 * logs los junta el runtime y escribir a un filesystem efímero es basura que
 * nadie lee. Puro y exportado para poder testear la cadena sin tocar disco.
 */
export function resolveLogFile(env: LogEnv): string | null {
  const override = env.IA_FLOW_GATEWAY_LOG_FILE
  if (override !== undefined) return override.trim() === '' ? null : override
  const configDir = env.IA_FLOW_CONFIG_DIR ?? join(env.HOME ?? '', '.config', 'ia-flow')
  return join(env.IA_FLOW_LOG_DIR ?? join(configDir, 'logs'), 'gateway.log')
}

const LOG_FILE = resolveLogFile(Bun.env)

/**
 * El archivo es un extra, no un requisito: un directorio que no se puede
 * crear (filesystem read-only, un HOME que no existe) baja a stdout solo en
 * vez de tumbar el proceso en el import. Quedarse sin gateway por no poder
 * loguear sería peor que quedarse sin el log.
 */
function fileTarget(): pino.TransportTargetOptions | null {
  if (!LOG_FILE) return null
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true })
  } catch {
    return null
  }
  return {
    target: 'pino/file',
    level: LOG_LEVEL,
    options: { destination: LOG_FILE, append: true, mkdir: true },
  }
}

const prettyTarget: pino.TransportTargetOptions = {
  target: 'pino-pretty',
  level: LOG_LEVEL,
  options: { colorize: true, translateTime: 'HH:MM:ss' },
}

const file = fileTarget()

const base = pino({
  level: LOG_LEVEL,
  timestamp: pino.stdTimeFunctions.isoTime,
  transport: { targets: file ? [prettyTarget, file] : [prettyTarget] },
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

/** Dónde quedaron los logs — para que el arranque lo pueda decir. */
export const logFilePath = file ? LOG_FILE : null
