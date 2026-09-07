import type { ExecutionStats, TaskDisposition } from '@ia-flow/shared'
import { CLASS_LABELS, percent } from './health-format'

/**
 * El resumen de una pantalla de vigilancia es un VEREDICTO, no una tabla (R10).
 *
 * Arriba del listado de ejecuciones había una tabla de diez columnas por
 * agente: 418px de alto antes de la primera fila de runs, y en un teléfono de
 * 800px eso dejaba una fila y media visible. Peor que el alto: la tabla contesta
 * "¿cuánto cuesta cada agente?" —una pregunta de auditoría, que se hace de vez
 * en cuando— y la pregunta de esta pantalla es "¿a cuál tengo que mirar?".
 *
 * Así que el panel dice sólo lo que está **fuera de banda**, con su razón
 * literal, y cuenta el resto. La tabla no se recorta a tres columnas: se muda
 * entera a la pantalla del agente, que es donde se audita.
 *
 * Todo esto es puro y vive fuera del componente: son las reglas que deciden a
 * quién señalar, y decidir eso dentro de un `<template>` las vuelve
 * inspeccionables sólo montando la pantalla.
 */

/** Debajo de esto una tasa describe la muestra, no al agente. */
export const LOW_SAMPLE = 5
/** Un agente por debajo de esto necesita que alguien lo mire. */
export const SUCCESS_BAND = 0.9
/** Un prefijo estable debería servirse casi entero del cache; bajo esto, el
 *  historial se re-manda a precio pleno en cada vuelta. */
export const CACHE_BAND = 0.5

export type AgentHealth = ExecutionStats['agents'][number]

export interface AgentVerdict {
  agentId: string
  /** Por qué está fuera de banda, dicho como se lee: `48% ok · 12 de 23 por
   *  tools fallando`. Es la razón literal, no una etiqueta de severidad. */
  reason: string
  successRate: number | null
}

/** La clase de fallo que más pesa, con su cuenta. `null` si no hay fallos
 *  clasificados — decir "por unknown" no explica nada. */
function topFailure(agent: AgentHealth): { label: string; count: number } | null {
  const entries = Object.entries(agent.failureClasses).sort((a, b) => b[1] - a[1])
  if (!entries.length) return null
  const [cls, count] = entries[0]
  return { label: CLASS_LABELS[cls] ?? cls, count }
}

/**
 * ¿Este agente pide atención?
 *
 * Con menos de `LOW_SAMPLE` runs, **no** — su tasa es técnicamente correcta y
 * prácticamente ruido, y un panel que grita por dos runs de tres enseña a
 * ignorarlo. Ésa es la falla que mata a un panel de alertas.
 */
export function isOutOfBand(agent: AgentHealth): boolean {
  if (agent.runs < LOW_SAMPLE) return false
  if (agent.successRate !== null && agent.successRate < SUCCESS_BAND) return true
  if (agent.cacheHitRate !== null && agent.cacheHitRate < CACHE_BAND) return true
  return false
}

export function verdictFor(agent: AgentHealth): AgentVerdict {
  const parts: string[] = []
  if (agent.successRate !== null && agent.successRate < SUCCESS_BAND) {
    const failed = agent.error + agent.cancelled + agent.truncated
    const top = topFailure(agent)
    parts.push(
      `${percent(agent.successRate)} ok` +
        (failed > 0 ? ` · ${failed} de ${agent.runs}${top ? ` por ${top.label}` : ''}` : ''),
    )
  }
  if (agent.cacheHitRate !== null && agent.cacheHitRate < CACHE_BAND) {
    parts.push(`${percent(agent.cacheHitRate)} de cache — el historial se re-manda`)
  }
  return { agentId: agent.agentId, reason: parts.join(' · '), successRate: agent.successRate }
}

export interface HealthVerdict {
  /** Uno por línea, con su razón. Son los únicos que el panel nombra. */
  outOfBand: AgentVerdict[]
  /** Los que están bien: una línea plegada con sus tasas. */
  healthy: AgentHealth[]
  /** Los que todavía no dicen nada — menos de LOW_SAMPLE runs. Se cuentan
   *  aparte de los sanos: "en banda" sería una afirmación que la muestra no
   *  sostiene (DESIGN_SYSTEM · Ausencia). */
  lowSample: AgentHealth[]
}

export function summarizeHealth(agents: AgentHealth[]): HealthVerdict {
  const outOfBand: AgentVerdict[] = []
  const healthy: AgentHealth[] = []
  const lowSample: AgentHealth[] = []
  for (const a of agents) {
    if (a.runs < LOW_SAMPLE) lowSample.push(a)
    else if (isOutOfBand(a)) outOfBand.push(verdictFor(a))
    else healthy.push(a)
  }
  // El peor primero: si sólo se lee una línea, que sea la que más duele.
  outOfBand.sort((a, b) => (a.successRate ?? 1) - (b.successRate ?? 1))
  return { outOfBand, healthy, lowSample }
}

export type Disposition = 'waiting' | 'running' | 'closed'

export interface DispositionCount {
  key: Disposition
  label: string
  count: number
  /** Los tokens `resultado:<x>` que este contador prende al tocarlo. El
   *  contador ES el filtro — un atajo, no un segundo camino. */
  outcomes: string[]
}

/**
 * Los tres contadores de la cabecera: por **disposición**, no por los seis
 * outcomes.
 *
 * "success / error / cancelled / truncated / pending" describe qué pasó; la
 * pregunta de esta pantalla es quién tiene que mover la próxima pieza. Un run
 * `truncated` y uno `error` se leen distinto y significan lo mismo para vos:
 * nadie los va a tocar si no los tocás.
 *
 * **Un contador en cero no se dibuja** (R10): "0 te esperan" ocupa el mismo
 * ancho que un problema y no es uno.
 */
export function dispositionCounts(counts: Record<string, number>): DispositionCount[] {
  const waiting = (counts.error ?? 0) + (counts.cancelled ?? 0) + (counts.truncated ?? 0)
  const all: DispositionCount[] = [
    {
      key: 'waiting',
      label: 'te esperan',
      count: waiting,
      outcomes: ['error', 'cancelled', 'truncated'],
    },
    { key: 'running', label: 'corriendo', count: counts.pending ?? 0, outcomes: ['pending'] },
    { key: 'closed', label: 'cerradas', count: counts.success ?? 0, outcomes: ['success'] },
  ]
  return all.filter((c) => c.count > 0)
}

/**
 * La disposición de UN run, a partir de su outcome.
 *
 * Es el mismo agrupado que `dispositionCounts`, dicho por fila: los seis
 * outcomes son tres disposiciones. `error`, `cancelled` y `truncated` se leen
 * distinto y significan lo mismo para vos — nadie los va a tocar si no los
 * tocás.
 *
 * A diferencia de la disposición de una TAREA, ésta no necesita el server: un
 * run terminado no tiene regla de retry que consultar (la regla actuaría sobre
 * la tarea, no sobre esta fila, y el resultado sería otro run). Por eso vive
 * acá y no en `@ia-flow/shared`.
 */
export function dispositionOfOutcome(outcome: string | null | undefined): TaskDisposition {
  if (!outcome) return 'moving'
  if (outcome === 'success') return 'closed'
  return 'waiting-on-you'
}
