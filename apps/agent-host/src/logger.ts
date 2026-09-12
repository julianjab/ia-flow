// Logger del agent-host — pretty a stdout + JSON a archivo (rotado) + OTLP
// opcional. Mismo formato y mismas piezas que apps/server/src/logger.ts —
// paridad deliberada: es lo que permite mirar el log de un agent-host con la
// misma vista mental que el de un daemon, campo por campo.
//
// El archivo existe por cómo se lo levanta de verdad: `IA Flow AgentHost.app`
// (apps/desktop) lo spawnea y sólo repite su stdout al stdout de Electron,
// que abierto desde el Finder no va a ningún lado. Sin archivo, la única
// forma de ver por qué falló un run era relanzar la app desde una terminal.
//
// Convive con apps/server/src/logger.ts: mismo $IA_FLOW_LOG_DIR, mismas vars
// de rotación (`IA_FLOW_LOG_MAX_SIZE`/`IA_FLOW_LOG_MAX_FILES`), archivo aparte
// (`agent-host.<n>.log` junto a `daemon.<n>.log`) — un solo env mueve los dos
// procesos. Lo que NO copia es el forward a IA_FLOW_REMOTE_LOG_URL ni el
// broadcast WS: el agent-host no es un daemon de ia-flow, no tiene UI propia
// de logs a la que alimentar — su UI (`apps/web/src/features/agent-host/`)
// lee `GET /v1/logs` bajo demanda, no en vivo.
//
// El tercer sink es OTLP/HTTP hacia un collector OpenTelemetry, apagado
// mientras no haya `OTEL_EXPORTER_OTLP_ENDPOINT`. Suma, no reemplaza: es la
// única forma de mirar N agent-hosts en N máquinas sin abrir N `agent-host.log`.
// El diseño y el porqué de cada decisión están en docs/prd/otel-logs.md.
import { readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { Writable } from 'node:stream'
import { logs, SeverityNumber } from '@opentelemetry/api-logs'
import { setGlobalErrorHandler } from '@opentelemetry/core'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http'
import {
  detectResources,
  envDetector,
  type Resource,
  resourceFromAttributes,
} from '@opentelemetry/resources'
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs'
import pino from 'pino'
import { version as SERVICE_VERSION } from '../package.json'
import { prettyConsoleStream, rollingFileStream } from './logger-sinks.js'

const LOG_LEVEL = (Bun.env.LOG_LEVEL ?? 'info') as pino.Level

// Mismos defaults y misma validación que apps/server/src/logger.ts — ver ahí
// el porqué de cada guarda (un `size`/`count` inválido no puede apagar la
// rotación en silencio).
const DEFAULT_LOG_MAX_SIZE = '50m'
const DEFAULT_LOG_MAX_FILES = 4
const SIZE_RE = /^\d+(\.\d+)?[kmg]$/i

export function logMaxSize(raw: string | undefined): string {
  const v = raw?.trim()
  if (!v || !SIZE_RE.test(v)) return DEFAULT_LOG_MAX_SIZE
  const n = Number.parseFloat(v)
  return Number.isFinite(n) && n > 0 ? v : DEFAULT_LOG_MAX_SIZE
}

export function logMaxFiles(raw: string | undefined): number {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_LOG_MAX_FILES
}

const LOG_MAX_SIZE = logMaxSize(Bun.env.IA_FLOW_LOG_MAX_SIZE)
const LOG_MAX_FILES = logMaxFiles(Bun.env.IA_FLOW_LOG_MAX_FILES)

export interface LogEnv {
  HOME?: string
  IA_FLOW_CONFIG_DIR?: string
  IA_FLOW_LOG_DIR?: string
  IA_FLOW_AGENT_HOST_LOG_FILE?: string
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
 * Base del nombre del archivo activo, SIN extensión — `rollingFileStream` le
 * agrega `.<n>.log`, igual que `daemon.<n>.log` del lado del server.
 *
 * Cadena de defaults igual a la del state file (state.ts): override explícito
 * → $IA_FLOW_LOG_DIR → $IA_FLOW_CONFIG_DIR → ~/.config/ia-flow.
 *
 * Un `IA_FLOW_AGENT_HOST_LOG_FILE` vacío apaga el archivo: en un container los
 * logs los junta el runtime y escribir a un filesystem efímero es basura que
 * nadie lee. Un override CON extensión (`.log`) se la recorta: es lo que
 * alguien escribe pensando en el nombre del archivo activo, no en la base que
 * pino-roll necesita. Puro y exportado para poder testear la cadena sin tocar
 * disco.
 */
export function resolveLogFileBase(env: LogEnv): string | null {
  const override = env.IA_FLOW_AGENT_HOST_LOG_FILE
  if (override !== undefined) {
    const trimmed = override.trim()
    if (trimmed === '') return null
    return trimmed.endsWith('.log') ? trimmed.slice(0, -'.log'.length) : trimmed
  }
  const configDir = env.IA_FLOW_CONFIG_DIR ?? join(env.HOME ?? '', '.config', 'ia-flow')
  return join(env.IA_FLOW_LOG_DIR ?? join(configDir, 'logs'), 'agent-host')
}

const LOG_FILE_BASE = resolveLogFileBase(Bun.env as LogEnv)

/**
 * Un fallo del archivo (disco lleno, permisos, un path que no se puede crear)
 * apaga ESE sink y nada más — nunca tumba el proceso. Mismo criterio que
 * `onFileSinkError` de apps/server/src/logger.ts.
 */
function onFileSinkError(err: unknown): void {
  process.stderr.write(
    `[logger] sink de archivo deshabilitado (${String(err)}) — el logging sigue sin él\n`,
  )
}

const fileStream = LOG_FILE_BASE
  ? rollingFileStream(
      { file: LOG_FILE_BASE, size: LOG_MAX_SIZE, count: LOG_MAX_FILES },
      onFileSinkError,
    )
  : null

/**
 * La consola. `LOG_PLAIN=true` (lo pone la imagen) manda NDJSON crudo a
 * stdout: en un contenedor los logs los junta el runtime, y los códigos de
 * color de pino-pretty son basura adentro de `docker logs` o de un collector.
 */
function consoleStream(): pino.DestinationStream {
  if (Bun.env.LOG_PLAIN === 'true') return pino.destination({ dest: 1, sync: false })
  return prettyConsoleStream(Bun.env.LOG_SINGLE_LINE === 'true') as pino.DestinationStream
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
      'service.name': env.OTEL_SERVICE_NAME?.trim() || 'ia-flow-agent-host',
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
 * extra; que se apague es mejor que quedarse sin agent-host.
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

export function otelStream(env: OtelEnv = Bun.env as OtelEnv): Writable | null {
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
    const otel = provider.getLogger('ia-flow-agent-host')
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

const file = fileStream
const console_ = consoleStream()
const otel = otelStream()

// NINGÚN sink corre en un worker thread, y es deliberado.
//
// `pino.transport` levanta un worker y le pasa el target como STRING
// (`'pino-pretty'`, `'pino/file'`), que el worker resuelve en runtime con un
// require propio: nunca entra en el grafo de imports, así que el bundler no lo
// incluye. La imagen de este agent-host se construye con `bun build` y su etapa
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
  { level: LOG_LEVEL, timestamp: pino.stdTimeFunctions.isoTime, base: { pid: process.pid } },
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
// exporter que no llega es información de debug, no un problema del agent-host.
if (otel) {
  const diag = base.child({ module: 'otel' })
  setGlobalErrorHandler((err) => {
    diag.debug({ err: String(err) }, 'otel exporter error')
  })
}

// ── Redrive de logs de run hacia el daemon que los despachó ───────────────
//
// El agent-host no tiene UI de logs — por eso `logger.ts` no copiaba el forward a
// `IA_FLOW_REMOTE_LOG_URL` del daemon. Ese razonamiento vale para los logs
// PROPIOS del agent-host (boot, registración, sondas de capacidad) y no contempla
// los de un run, que pertenecen a una ejecución que el daemon SÍ posee y
// muestra. Sin este reenvío, un operador mirando los logs del daemon ve un run
// remoto como un agujero: arranca, y horas después aparece el resultado.
//
// La regla es por eso selectiva: **se reenvía lo que lleva `runId`**. Lo demás
// se queda local, que es lo que evita convertir el `daemon.log` en un espejo
// del ciclo de vida de cada agent-host.
//
// Auth: el MISMO token que el agent-host entregó al registrarse
// (`API_AI_PROVIDER_TOKEN`). No hace falta un secreto nuevo ni mandarlo en
// cada run: el daemon ya lo tiene guardado en su `provider_registrations` y ya
// lo verificó (llamó al agent-host con él antes de dar de alta la fila), así que
// presentarlo de vuelta prueba identidad Y le permite al daemon atribuir la
// línea a ESTA registración en vez de creerle a lo que venga en el payload.
const REDRIVE_TIMEOUT_MS = 3_000

// Tope del `extras` serializado. El receptor corta en 20 KB
// (MAX_EXTRAS_BYTES en routes/remote-logs.ts) y `bash_run` sólo ya devuelve
// hasta 20 KB de salida: sin recortar acá, las líneas más interesantes de un
// run —justo las que traen output— serían las únicas que el daemon rechaza.
const MAX_REDRIVE_EXTRAS_BYTES = 16_000

/** `runId` → base URL del daemon que despachó ese run. La llena y la vacía
 *  `/v1/run` (app.ts): el destino es propiedad del RUN, no del agent-host, porque
 *  un agent-host puede estar registrado contra varios daemons a la vez
 *  (`registerServerUrls` es una lista). */
const redriveTargets = new Map<string, string>()

export function setRunLogTarget(runId: string, daemonUrl: string): void {
  redriveTargets.set(runId, daemonUrl.replace(/\/+$/, ''))
}

export function clearRunLogTarget(runId: string): void {
  redriveTargets.delete(runId)
}

/** Sólo para tests. */
export function runLogTargetCount(): number {
  return redriveTargets.size
}

/**
 * Recorta `extras` para que entre en el tope del receptor. Puro y exportado
 * para testear el recorte sin abrir un socket.
 */
export function capExtras(extras: Record<string, unknown>): Record<string, unknown> {
  let serialized: string
  try {
    serialized = JSON.stringify(extras)
  } catch {
    return { redriveError: 'extras no serializable' }
  }
  // `Buffer.byteLength` y NO `.length`: el segundo cuenta unidades UTF-16 y el
  // receptor corta en BYTES. Cualquier salida no-ASCII —acentos, el
  // box-drawing de un test runner, un emoji— pasa este cap y la rechaza el
  // daemon, que es exactamente la línea que el redrive existe para no perder.
  const bytes = Buffer.byteLength(serialized, 'utf8')
  if (bytes <= MAX_REDRIVE_EXTRAS_BYTES) return extras
  // Se conservan las claves de correlación —son lo que hace útil a la línea—
  // y se reemplaza el resto por una marca, en vez de truncar el JSON por la
  // mitad y que el receptor lo rechace por malformado.
  const kept: Record<string, unknown> = {}
  for (const key of ['runId', 'agent', 'projectId', 'taskId', 'task', 'event', 'tool']) {
    if (key in extras) kept[key] = extras[key]
  }
  kept.redriveTruncated = bytes
  return kept
}

/**
 * ¿Esta línea se reenvía, y a dónde? `null` = se queda local.
 *
 * Puro y exportado por lo mismo que `capExtras`: la decisión de reenviar es
 * lo que hay que poder testear, no el `fetch`.
 */
export function redriveTarget(extras: Record<string, unknown>): string | null {
  const runId = extras.runId
  if (typeof runId !== 'string' || !runId) return null
  return redriveTargets.get(runId) ?? null
}

function redrive(
  level: string,
  module: string,
  msg: string,
  extras: Record<string, unknown>,
): void {
  const daemonUrl = redriveTarget(extras)
  if (!daemonUrl) return
  const token = Bun.env.API_AI_PROVIDER_TOKEN?.trim()
  // Sin token no hay a quién probarle quiénes somos. Se calla en vez de
  // reintentar: el receptor es fail-closed y rechazaría cada línea.
  if (!token) return
  fetch(`${daemonUrl}/api/remote-logs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ia-flow-token': token },
    body: JSON.stringify({ level, module, msg, extras: capExtras(extras) }),
    signal: AbortSignal.timeout(REDRIVE_TIMEOUT_MS),
  }).catch(() => {})
  // Fire-and-forget, igual que el forward del daemon: loguear no puede hacer
  // fallar un run, y un agent-host que no alcanza a su daemon tiene problemas
  // mucho más ruidosos que una línea perdida.
}

export interface Log {
  info: (obj: object, msg?: string) => void
  warn: (obj: object, msg?: string) => void
  error: (obj: object, msg?: string) => void
  debug: (obj: object, msg?: string) => void
  /**
   * Correlación por run. `executeLoop` (@ia-flow/tools) bindea acá el
   * contexto del dispatch (runId, taskId, agentId) para que cada línea del
   * loop de tools se pueda juntar con las del daemon que lo despachó — es la
   * razón por la que el `Logger` de ese paquete exige `child()` y el de
   * issue-sources/agent-engine no.
   *
   * Sin esto, `setToolsLoggerFactory(createLogger)` (providers.ts) no
   * typechequea: `Log` no satisfacía `LoggerFactory`.
   */
  child: (bindings: Record<string, unknown>) => Log
}

/**
 * Envuelve un logger de pino en la interfaz mínima que exportamos. Recursivo
 * porque `child()` tiene que devolver la MISMA interfaz, no el pino crudo.
 *
 * `bindings` se arrastra acumulado en vez de leerse de pino en cada llamada:
 * el `runId` que decide el redrive puede venir por DOS caminos y hay que
 * mirarlos juntos —`executeLoop` (@ia-flow/tools) lo bindea con `.child()`,
 * mientras que el provider lo esparce en el objeto de cada llamada
 * (`logMcpToolCall` y compañía)—. Mezclar los dos acá es lo que hace que las
 * líneas de progreso de un run salgan por el mismo filtro sin importar quién
 * las emitió.
 */
function wrap(p: pino.Logger, module: string, bindings: Record<string, unknown>): Log {
  const emit =
    (level: 'info' | 'warn' | 'error' | 'debug') =>
    (obj: object, msg?: string): void => {
      p[level](obj, msg)
      try {
        redrive(level, module, msg ?? '', { ...bindings, ...(obj as Record<string, unknown>) })
      } catch {
        // Un fallo del reenvío nunca puede tocar al log local, que es el que
        // de verdad no se puede perder.
      }
    }
  return {
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    debug: emit('debug'),
    child: (b) => wrap(p.child(b), module, { ...bindings, ...b }),
  }
}

export function createLogger(module: string): Log {
  return wrap(base.child({ module }), module, {})
}

/**
 * `agent-host.<n>.log` → n. `null` para cualquier otro nombre del directorio.
 * Mismo patrón que `rollNumber()` de `apps/server/src/routes/server-logs.ts`,
 * generalizado sobre la base (`agent-host` acá, `daemon` allá).
 */
function rollNumber(base: string, name: string): number | null {
  const m = name.match(
    new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(\\d+)\\.log$`),
  )
  return m ? Number(m[1]) : null
}

/**
 * Los archivos de log de ESTE proceso, del más nuevo al más viejo — o `[]` sin
 * archivo configurado o con el directorio inexistente (primer arranque).
 *
 * El "más nuevo" es el de número más alto, no el de mtime más reciente —
 * mismo razonamiento que del lado del server: un `touch`/rsync sobre un
 * rotado viejo no debería redirigir la lectura. `log-tail.ts` los recorre
 * hacia atrás hasta juntar su ventana, así que justo después de rotar (con el
 * activo casi vacío) la vista sigue completa gracias al anterior.
 *
 * Cierra con `agent-host.log` si existe: el nombre que dejó cualquier
 * instalación anterior a esta rotación.
 */
export function resolveLogFiles(): string[] {
  if (!LOG_FILE_BASE) return []
  const dir = dirname(LOG_FILE_BASE)
  const base = basename(LOG_FILE_BASE)
  const rolled: Array<{ n: number; name: string }> = []
  let legacy = false
  try {
    for (const name of readdirSync(dir)) {
      if (name === `${base}.log`) {
        legacy = true
        continue
      }
      const n = rollNumber(base, name)
      if (n != null) rolled.push({ n, name })
    }
  } catch {
    return []
  }
  rolled.sort((a, b) => b.n - a.n)
  const files = rolled.map((f) => join(dir, f.name))
  if (legacy) files.push(join(dir, `${base}.log`))
  return files
}

/**
 * Identidad del sink de archivo, para el arranque y para `GET /v1/logs`:
 * `null` sólo cuando el archivo está apagado por config — a diferencia de
 * `resolveLogFiles()`, NO depende de que el archivo ya exista en disco (el
 * primer flush de pino-roll es async, y "recién booteó" no es "sin archivo").
 */
export const logFilePath = LOG_FILE_BASE ? `${LOG_FILE_BASE}.1.log` : null
