// Logger del gateway — pretty a stdout + JSON a archivo + OTLP opcional.
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
//
// El tercer sink es OTLP/HTTP hacia un collector OpenTelemetry, apagado
// mientras no haya `OTEL_EXPORTER_OTLP_ENDPOINT`. Suma, no reemplaza: es la
// única forma de mirar N gateways en N máquinas sin abrir N `gateway.log`.
// El diseño y el porqué de cada decisión están en docs/prd/otel-logs.md.
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Writable } from 'node:stream'
import { SeverityNumber, logs } from '@opentelemetry/api-logs'
import { setGlobalErrorHandler } from '@opentelemetry/core'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs'
import pino from 'pino'
import { version as SERVICE_VERSION } from '../package.json'

const LOG_LEVEL = (Bun.env.LOG_LEVEL ?? 'info') as pino.Level

export interface LogEnv {
  HOME?: string
  IA_FLOW_CONFIG_DIR?: string
  IA_FLOW_LOG_DIR?: string
  IA_FLOW_GATEWAY_LOG_FILE?: string
}

/** Lo que `otelStream()` mira del entorno. Aparte de `LogEnv` a propósito: son
 * dos sinks distintos y ninguno tiene por qué conocer las vars del otro. */
export interface OtelEnv {
  OTEL_EXPORTER_OTLP_ENDPOINT?: string
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT?: string
  OTEL_SDK_DISABLED?: string
  OTEL_SERVICE_NAME?: string
  OTEL_DEPLOYMENT_ENVIRONMENT?: string
  IA_FLOW_INSTANCE_ID?: string
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

/** Los niveles numéricos de pino, traducidos al severity de OTel. */
const SEVERITY: Record<number, SeverityNumber> = {
  10: SeverityNumber.TRACE,
  20: SeverityNumber.DEBUG,
  30: SeverityNumber.INFO,
  40: SeverityNumber.WARN,
  50: SeverityNumber.ERROR,
  60: SeverityNumber.FATAL,
}

/**
 * A qué URL exacta postear los log records. La var estándar es el *base*
 * endpoint del collector (`http://host:4318`) y cada señal cuelga de su path;
 * la var específica de logs, en cambio, ya viene completa. Un valor que no es
 * una URL hace tirar a `new URL(...)`, y ese throw es justamente lo que el
 * `try/catch` de `otelStream` convierte en "sin sink" en vez de en un crash.
 */
function logsEndpoint(env: OtelEnv): string {
  const specific = env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT?.trim()
  if (specific) return new URL(specific).toString()
  const base = (env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '').trim().replace(/\/+$/, '')
  return new URL(`${base}/v1/logs`).toString()
}

/**
 * El sink OTel. `null` = apagado, con el mismo criterio que `fileTarget()`:
 * sin endpoint, con el kill switch puesto, o si construir el provider falla
 * (endpoint mal formado, paquete que no resuelve). La observabilidad es un
 * extra; que se apague es mejor que quedarse sin gateway.
 *
 * Toma el entorno por parámetro —igual que `resolveLogFile`— para poder
 * testearla sin ensuciar `Bun.env` del proceso de test.
 */
export function otelStream(env: OtelEnv = Bun.env): Writable | null {
  if (!env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() && !env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT?.trim()) {
    return null
  }
  if (env.OTEL_SDK_DISABLED === 'true') return null
  try {
    const provider = new LoggerProvider({
      resource: resourceFromAttributes({
        'service.name': env.OTEL_SERVICE_NAME?.trim() || 'ia-flow-gateway',
        'service.instance.id': env.IA_FLOW_INSTANCE_ID?.trim() || String(process.pid),
        'service.version': SERVICE_VERSION,
        'deployment.environment.name': env.OTEL_DEPLOYMENT_ENVIRONMENT?.trim() || 'development',
      }),
      // OJO: opciones como objeto — `new BatchLogRecordProcessor(exporter)` falla
      // en runtime con "undefined is not an object (evaluating 'exporter.export')"
      // y sin un diag seteado se traga en silencio. Ver docs/prd/otel-logs.md, Q1.
      processors: [
        new BatchLogRecordProcessor({ exporter: new OTLPLogExporter({ url: logsEndpoint(env) }) }),
      ],
    })
    logs.setGlobalLoggerProvider(provider)
    const otel = provider.getLogger('ia-flow-gateway')
    return new Writable({
      write(chunk, _enc, cb) {
        try {
          const { level, time, msg, ...attributes } = JSON.parse(String(chunk))
          otel.emit({
            severityNumber: SEVERITY[level] ?? SeverityNumber.INFO,
            body: msg,
            attributes,
          })
        } catch {
          // Un record ilegible no puede frenar el stream: por multistream, un
          // cb() que no se llama frena el logging entero.
        }
        cb()
      },
    })
  } catch {
    return null // endpoint inválido, paquete ausente: se sigue sin OTel.
  }
}

const file = fileTarget()

// Los targets de pino.transport SIEMPRE corren en el worker; el bridge de OTel
// vive en el hilo principal. La forma de dos argumentos de pino() es la única
// que deja combinar los dos — ver docs/prd/otel-logs.md, Q1.
const workerStream = pino.transport({
  targets: file ? [prettyTarget, file] : [prettyTarget],
})

const otel = otelStream()

const base = pino(
  { level: LOG_LEVEL, timestamp: pino.stdTimeFunctions.isoTime },
  pino.multistream([
    { level: LOG_LEVEL, stream: workerStream },
    ...(otel ? [{ level: LOG_LEVEL, stream: otel }] : []),
  ]),
)

// El default de OTel escribe a stderr, así que un collector caído ensuciaría el
// pretty del arranque una vez por cada ciclo del BatchLogRecordProcessor. Un
// exporter que no llega es información de debug, no un problema del gateway.
if (otel) {
  const diag = base.child({ scope: 'otel' })
  setGlobalErrorHandler((err) => {
    diag.debug({ err: String(err) }, 'otel exporter error')
  })
}

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
