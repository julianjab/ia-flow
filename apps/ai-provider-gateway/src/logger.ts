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
import {
  type Resource,
  detectResources,
  envDetector,
  resourceFromAttributes,
} from '@opentelemetry/resources'
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs'
import pino from 'pino'
import pretty from 'pino-pretty'
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
function fileStream(): pino.DestinationStream | null {
  if (!LOG_FILE) return null
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true })
    // `pino.destination`, no un target `pino/file`: es la MISMA SonicBoom, pero
    // construida acá en vez de adentro de un worker. Ver el bloque de abajo.
    return pino.destination({ dest: LOG_FILE, append: true, mkdir: true, sync: false })
  } catch {
    return null
  }
}

/**
 * La consola. `LOG_PLAIN=true` (lo pone la imagen) manda NDJSON crudo a
 * stdout: en un contenedor los logs los junta el runtime, y los códigos de
 * color de pino-pretty son basura adentro de `docker logs` o de un collector.
 */
function consoleStream(): pino.DestinationStream {
  if (Bun.env.LOG_PLAIN === 'true') return pino.destination({ dest: 1, sync: false })
  return pretty({ colorize: true, translateTime: 'HH:MM:ss' })
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
 * Los resource attrs del proceso. `resourceFromAttributes` solo no alcanza:
 * los cuatro atributos de la tabla del ADR son nuestros, pero
 * `OTEL_RESOURCE_ATTRIBUTES` —el mecanismo estándar para que un deploy sume
 * los suyos (`k8s.pod.name`, etc.) sin tocar código— lo lee el `envDetector`,
 * que hay que pedir explícitamente. El merge va en ese orden a propósito: los
 * nuestros pisan a los del env, así nadie puede renombrar el service.name
 * desde afuera sin pasar por `OTEL_SERVICE_NAME`.
 */
export function otelResource(env: OtelEnv): Resource {
  return detectResources({ detectors: [envDetector] }).merge(
    resourceFromAttributes({
      'service.name': env.OTEL_SERVICE_NAME?.trim() || 'ia-flow-gateway',
      'service.instance.id': env.IA_FLOW_INSTANCE_ID?.trim() || String(process.pid),
      'service.version': SERVICE_VERSION,
      'deployment.environment.name': env.OTEL_DEPLOYMENT_ENVIRONMENT?.trim() || 'development',
    }),
  )
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
let otelProvider: LoggerProvider | null = null

/**
 * Vacía el batch en vuelo del `BatchLogRecordProcessor`.
 *
 * Aparte de `flushSinks` porque es asíncrono y los otros dos no: el sink OTel
 * exporta por HTTP en batches, así que un apagado que no lo espere pierde la
 * última tanda — justo las líneas del apagado. Acotado con un timeout por el
 * llamador: con el collector inalcanzable, `forceFlush()` arrastra el timeout
 * de OTLP y se comería el grace del SIGTERM.
 */
export function flushOtel(): Promise<void> {
  return otelProvider?.forceFlush().catch(() => {}) ?? Promise.resolve()
}

export function otelStream(env: OtelEnv = Bun.env): Writable | null {
  if (!env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() && !env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT?.trim()) {
    return null
  }
  if (env.OTEL_SDK_DISABLED === 'true') return null
  try {
    const provider = new LoggerProvider({
      resource: otelResource(env),
      // OJO: opciones como objeto — `new BatchLogRecordProcessor(exporter)` falla
      // en runtime con "undefined is not an object (evaluating 'exporter.export')"
      // y sin un diag seteado se traga en silencio. Ver docs/prd/otel-logs.md, Q1.
      processors: [
        new BatchLogRecordProcessor({ exporter: new OTLPLogExporter({ url: logsEndpoint(env) }) }),
      ],
    })
    logs.setGlobalLoggerProvider(provider)
    otelProvider = provider
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

const file = fileStream()
const console_ = consoleStream()
const otel = otelStream()

// NINGÚN sink corre en un worker thread, y es deliberado.
//
// `pino.transport` levanta un worker y le pasa el target como STRING
// (`'pino-pretty'`, `'pino/file'`), que el worker resuelve en runtime con un
// require propio: nunca entra en el grafo de imports, así que el bundler no lo
// incluye. La imagen de este gateway se construye con `bun build` y su etapa
// de runtime no tiene `node_modules`, o sea que el worker moriría al arrancar
// y thread-stream lo reintentaría por cada línea — un loop de
// `{"err":{"message":"the worker has exited"}}` hasta el OOM. Es exactamente
// lo que le pasaba al runner (ver apps/server/src/logger-sinks.ts).
//
// Importados como módulos entran en el grafo y viajan en el bundle. Además el
// worker era un único punto de falla compartido: la verificación de
// docs/prd/otel-logs.md (Q1) muestra que un target colgado se lleva puesto al
// `pino/file` del mismo worker. In-process cada sink cae solo.
const base = pino(
  { level: LOG_LEVEL, timestamp: pino.stdTimeFunctions.isoTime },
  pino.multistream([
    { level: LOG_LEVEL, stream: console_ },
    ...(file ? [{ level: LOG_LEVEL, stream: file }] : []),
    ...(otel ? [{ level: LOG_LEVEL, stream: otel }] : []),
  ]),
)

/**
 * Vacía los sinks bufferados, sincrónicamente.
 *
 * Los dos son SonicBoom con `sync: false`: buffean ~4 KB y los escriben cuando
 * el event loop los deja. Lo que se pierde al morir son las ÚLTIMAS líneas —
 * las del error que causó la caída, justo en el deploy donde `docker logs` es
 * el único diagnóstico.
 *
 * OJO con el reparto de responsabilidades, que no es obvio: `pino.destination`
 * YA registra un flush on-exit por su cuenta (vía `on-exit-leak-free`, ver
 * `autoEnd` en pino/lib/tools.js), así que en una salida normal esto es
 * redundante. Lo que ese mecanismo NO cubre es una SEÑAL: un SIGTERM sin
 * handler termina el proceso sin correr los handlers de `'exit'`, y este
 * proceso no tenía ningún handler de señal. O sea que el caso que esto arregla
 * es exactamente `docker stop`.
 */
export function flushSinks(): void {
  for (const dest of [console_, file] as unknown[]) {
    try {
      ;(dest as { flushSync?: () => void })?.flushSync?.()
    } catch {
      /* el buffer se pierde igual — no hay nada mejor que hacer acá */
    }
  }
}

// SÓLO `'exit'`. Los handlers de señal viven en index.ts, no acá: un
// `process.exit()` disparado desde el módulo de logging es incondicional y
// síncrono, así que se llevaría puesto cualquier apagado ordenado que se
// agregue después (abortar los runs en vuelo, desregistrarse de los servers,
// flushear OTel) — y encima saldría con código 0 ante una señal, que un
// orquestador lee como salida limpia.
//
// El logger expone `flushSinks`; QUIÉN apaga el proceso es decisión de quien
// lo arranca.
process.on('exit', flushSinks)

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
