// Los sinks de pino que corren en el HILO PRINCIPAL.
//
// ── Por qué existe este archivo ──────────────────────────────────────────
//
// `pino.transport` levanta un **worker thread** y le pasa el nombre del target
// (`pino-pretty`, `pino-roll`) como string. Ese nombre lo resuelve el worker
// EN RUNTIME, con un `require` propio — no entra en el grafo de imports, así
// que `bun build` no lo mete en el bundle.
//
// En el contenedor del runner eso es fatal: la etapa de runtime copia
// `/app/server.js` y NADA más (ver apps/server/Dockerfile.runner), o sea que no
// hay `node_modules` donde resolver el target. El worker muere al arrancar,
// `thread-stream` lo reintenta **por cada línea de log**, y el proceso se
// queda escupiendo
//
//     {"err":{"message":"the worker has exited"}}
//
// en loop hasta que el cgroup lo mata por memoria: `Exited (137)`. El síntoma
// no dice "falta un módulo" en ningún lado, que es lo que lo vuelve caro de
// diagnosticar.
//
// La salida no es adivinar cuándo hay node_modules: es **no usar workers**.
// Importados como módulos, `pino-pretty` y `pino-roll` entran en el grafo y
// `bun build` los bundlea; el mismo archivo funciona con y sin node_modules al
// lado. Es la misma decisión que ya había tomado el sink de OTel ("bridge
// custom corriendo en el hilo principal", ver logger.ts) — acá se termina de
// aplicar al resto.
//
// El costo real de sacar el worker es que el formateo y el write al archivo
// pasan a competir con el event loop del proceso. Para el volumen de este
// daemon es ruido; un logger que no puede arrancar cuesta infinitamente más.

import { Writable } from 'node:stream'
import pretty from 'pino-pretty'
import roll from 'pino-roll'

/**
 * Cuántas líneas se guardan mientras el destino real termina de construirse.
 *
 * Acotado a propósito: si el destino nunca resuelve, lo que se pierde son
 * líneas viejas y no la memoria del proceso — que es exactamente el modo de
 * falla que este archivo vino a eliminar.
 */
const BOOT_BUFFER_LINES = 1_000

/**
 * Un stream escribible desde el primer instante, que vuelca al destino real
 * cuando ese destino termina de abrirse.
 *
 * `pino.multistream` necesita el stream YA, de forma síncrona, pero `pino-roll`
 * es async: tiene que leer el directorio para saber en qué número de rotación
 * sigue. Sin este buffer, las líneas del arranque —justo las que explican por
 * qué un proceso no levantó— serían las únicas que no llegan al archivo.
 *
 * `onError` recibe tanto un fallo al abrir como uno posterior del destino
 * (disco lleno, permisos). En los dos casos el sink queda **apagado**, no
 * roto: las escrituras siguientes se descartan y el resto de los sinks sigue
 * andando. Un stream de Node sin listener de `'error'` **tira**, así que no
 * enganchar esto sería cambiar el loop de OOM por un crash.
 */
export interface FlushableStream extends Writable {
  /**
   * Vacía lo que quede en el buffer, YA y de forma síncrona.
   *
   * Existe porque el destino es una SonicBoom con `sync: false`: bufferea ~4 KB
   * y los escribe cuando el event loop la deja. En un apagado eso se pierde —
   * y lo que se pierde son las ÚLTIMAS líneas, o sea las del error que causó
   * el apagado, justo en un contenedor donde el log es el único diagnóstico.
   *
   * Antes esto lo cubría `thread-stream` (registraba su propio flush on-exit al
   * usar `pino.transport`); al sacar el worker, el flush pasa a ser nuestro.
   */
  flushSync(): void
}

export function deferredStream(
  open: () => Promise<NodeJS.WritableStream>,
  onError: (err: unknown) => void,
): FlushableStream {
  let target: NodeJS.WritableStream | null = null
  let off = false
  const buffered: string[] = []
  let dropped = 0

  const fail = (err: unknown): void => {
    off = true
    target = null
    buffered.length = 0
    onError(err)
  }

  open().then((stream) => {
    stream.on('error', fail)
    if (dropped > 0) {
      // No se pierde en silencio: el arranque tardó más que el buffer y hay
      // líneas que nadie va a poder leer después.
      process.stderr.write(
        `[logger] ${dropped} líneas de arranque descartadas antes de abrir el archivo\n`,
      )
    }
    for (const line of buffered) stream.write(line)
    buffered.length = 0
    if (!off) target = stream
  }, fail)

  const stream = new Writable({
    write(chunk, _enc, cb) {
      try {
        if (target) target.write(String(chunk))
        else if (!off) {
          if (buffered.length >= BOOT_BUFFER_LINES) {
            buffered.shift()
            dropped++
          }
          buffered.push(String(chunk))
        }
      } catch {
        // Un write fallido no puede frenar el resto de los sinks.
      }
      // SIEMPRE, y fuera del try: un cb() que no se llama congela el
      // multistream entero, o sea el logging completo del proceso.
      cb()
    },
  }) as FlushableStream

  // No-op si el destino todavía no abrió, si ya se apagó, o si no es una
  // SonicBoom. Nunca tira: corre desde un handler de apagado, donde una
  // excepción se comería el resto del apagado.
  stream.flushSync = () => {
    try {
      ;(target as { flushSync?: () => void } | null)?.flushSync?.()
    } catch {
      /* el buffer se pierde igual — no hay nada mejor que hacer acá */
    }
  }

  return stream
}

export interface RollingFileOptions {
  /** Base del nombre, SIN extensión — pino-roll le agrega `.<n>.log`. */
  file: string
  /** `50m`, `500k`, `1g`. Ya validado por logMaxSize() en logger.ts. */
  size: string
  /** Rotados a conservar, SIN contar el activo. Ya validado por logMaxFiles(). */
  count: number
}

/**
 * El archivo NDJSON que lee la UI (`routes/server-logs.ts`), rotado por tamaño.
 *
 * Mismas opciones que tenía como target de `pino.transport` — lo único que
 * cambia es que corre acá, sin worker. `removeOtherLogFiles: true` sigue
 * siendo obligatorio para que el techo de disco sea real tras un reinicio; el
 * porqué está en logger.ts, junto a los defaults.
 */
export function rollingFileStream(
  opts: RollingFileOptions,
  onError: (err: unknown) => void,
): FlushableStream {
  return deferredStream(
    () =>
      roll({
        file: opts.file,
        extension: '.log',
        size: opts.size,
        limit: { count: opts.count, removeOtherLogFiles: true },
        mkdir: true,
      }) as Promise<NodeJS.WritableStream>,
    onError,
  )
}

/**
 * La consola con formato humano. Es el mismo `pino-pretty` de antes, con las
 * mismas opciones, construido como stream en vez de como target.
 */
export function prettyConsoleStream(singleLine: boolean): NodeJS.WritableStream {
  return pretty({
    colorize: true,
    translateTime: 'HH:MM:ss',
    ignore: 'pid,hostname',
    messageFormat: '[{module}] {msg}',
    singleLine,
  })
}
