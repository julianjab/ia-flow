// Admisión — el provider decide si toma una tarea.
//
// El engine no sabe (ni puede saber) por qué un provider no está en
// condiciones de trabajar: la RAM del host, cuántas sesiones de terminal
// vivas hay, si el proceso está ocupado con trabajo que no vino de este
// daemon, un rate limit propio del upstream. Todo eso lo sabe el provider y
// nadie más, así que la decisión es suya.
//
// Lo que el engine SÍ sabe se le pasa en el request (`running`, `cap`): así
// el provider no tiene que reimplementar el conteo ni leer config, y puede
// usar `withinDeclaredCap` para respetar el cap de la UI y agregar encima
// sus propios motivos.
//
// Reglas del contrato:
//  - `canAccept` es **consultivo**: no reserva nada. Entre el `accept` y el
//    `run` puede entrar otro dispatch. La palabra final la tiene `run` (el
//    gateway remoto responde 503 cuando ya no puede). Esto es enrutamiento,
//    no un lock — un lock distribuido acá costaría más de lo que arregla.
//  - Nunca lanza y no debe bloquear: ante la duda, `ADMIT`. Un chequeo roto
//    que congela el pipeline es peor que intentar y fallar, porque el fallo
//    del run sí se reporta.
//  - Rechazar NO es fallar: el issue se difiere y se reintenta cuando se
//    libere un slot. Por eso el motivo es texto para humanos (va al log),
//    no un código de error.

import type { Task } from '@ia-flow/shared'

export interface AdmissionRequest {
  /** La tarea que se le ofrece. Un provider puede rechazarla por lo que ES
   *  (un repo que no tiene clonado, un tamaño que no le entra) y no sólo por
   *  cuántas cosas está haciendo. */
  task: Task
  /** Qué agente la correría, para providers que traten distinto a unos que a
   *  otros (o que sólo quieran loguearlo). */
  agentId?: string
  /** Runs de ESTE provider en vuelo **según este daemon**. Un provider
   *  compartido entre varios daemons ve menos de lo que realmente corre —
   *  ese hueco es justamente lo que su propio chequeo puede cerrar. */
  running: number
  /** Cap declarado en la config (`ProviderConfig.providerLimits`), tal como
   *  lo editó la UI. `undefined` o `0` = sin límite. */
  cap?: number
}

export type Admission = { accept: true } | { accept: false; reason: string; retryAfterMs?: number }

export const ADMIT: Admission = { accept: true }

/** `retryAfterMs` es una pista, no una promesa: hoy sólo se loguea (el
 *  backlog del dispatcher tiene su propio backoff exponencial). */
export function decline(reason: string, retryAfterMs?: number): Admission {
  return { accept: false, reason, retryAfterMs }
}

/**
 * El chequeo declarativo, el mismo para todos: ¿queda lugar bajo el cap que
 * el operador puso en la UI?
 *
 * Es el default cuando un provider no implementa `canAccept` — así el cap
 * sigue valiendo para todos los providers sin que ninguno escriba código — y
 * es la primera línea de un `canAccept` propio:
 *
 * ```ts
 * async canAccept(req: AdmissionRequest): Promise<Admission> {
 *   const declared = withinDeclaredCap(req)
 *   if (!declared.accept) return declared
 *   if (freeMemMb() < 512) return decline('RAM al límite', 30_000)
 *   return ADMIT
 * }
 * ```
 */
export function withinDeclaredCap(req: AdmissionRequest): Admission {
  // `0` = sin definir, nunca "frenar todo" — mismo criterio que el resto de
  // los caps (ver capacity.ts en @ia-flow/agent-engine).
  if (req.cap == null || req.cap <= 0) return ADMIT
  if (req.running < req.cap) return ADMIT
  return decline(`cap declarado alcanzado (${req.running}/${req.cap})`)
}
