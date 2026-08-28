// `pino-roll` no publica tipos, y no existe un `@types/pino-roll`.
//
// Se declara acá y no se usa `any` suelto en logger-sinks.ts porque el punto
// de importarlo como MÓDULO (en vez de nombrarlo como target de
// `pino.transport`) es que el bundler lo vea: el tipo es lo que documenta qué
// contrato estamos apoyando en esa importación. Sólo las opciones que usamos.
declare module 'pino-roll' {
  import type { Writable } from 'node:stream'

  interface PinoRollLimit {
    /** Rotados a conservar, SIN contar el archivo activo. */
    count?: number
    /** Barre el directorio en cada rotación en vez de mirar sólo lo que
     *  escribió ESTE proceso — sin esto el techo no sobrevive a un reinicio. */
    removeOtherLogFiles?: boolean
  }

  interface PinoRollOptions {
    /** Base del nombre; pino-roll le agrega `.<n>` y la extensión. */
    file: string
    /** `50m`, `500k`, `1g`. Un número pelado son MEGABYTES, no bytes. */
    size?: string | number
    extension?: string
    limit?: PinoRollLimit
    mkdir?: boolean
  }

  /** Devuelve un SonicBoom; async porque lee el directorio para saber en qué
   *  número de rotación continuar. */
  export default function pinoRoll(options?: PinoRollOptions): Promise<Writable>
}
