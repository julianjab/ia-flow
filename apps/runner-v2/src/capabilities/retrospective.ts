/**
 * La retrospectiva que trae el runner: cuando se mergea el PR de una tarea, el agente
 * `retrospective` mira cómo corrió y deja mejoras propuestas en la bandeja (`docs` del repo de la
 * tarea, `config` del deploy, `engine`). Va en la fuente global —que recibe los eventos de todos
 * los proyectos— como una pipeline más, encendida salvo que `runner.yaml` diga
 * `retrospective: { enabled: false }`.
 *
 * Un deploy que quiere otro agente la apaga y declara su propia pipeline (con otro id): un agente o
 * una pipeline propia con el id de éstos rompe el arranque.
 */
import agent from './retrospective.yaml'

export const RETROSPECTIVE_ID = 'retrospective'

export interface RetrospectiveSettings {
  enabled: boolean
  /** Dónde se abre cada destino que no es el repo de la tarea. */
  repos: { engine?: string; config?: string }
}

/** Su agente, con los repos de cada destino como `options` de `propose_improvement`. */
function retrospectiveAgent(repos: RetrospectiveSettings['repos']): Record<string, unknown> {
  const actions = (agent.actions as unknown[]).map((entry) =>
    entry === 'propose_improvement' ? { action: entry, options: { ...repos } } : entry,
  )
  return { ...agent, actions }
}

/** La pipeline: el `pull_request` de una tarea (lo publica el intake), sólo si quedó mergeado. */
const PIPELINE = {
  id: RETROSPECTIVE_ID,
  name: 'Retrospectiva · PR mergeado → mejoras propuestas a la bandeja',
  on: ['pull_request'],
  when: [
    { field: 'action', op: 'eq', value: 'closed' },
    { field: 'pr.merged', op: 'eq', value: true },
  ],
  do: [{ agent: RETROSPECTIVE_ID }],
}

/** Lo que suma a la fuente global: nada si está apagada. */
export function retrospectiveSource(settings: RetrospectiveSettings): {
  agents: Record<string, unknown>[]
  pipelines: Record<string, unknown>[]
} {
  if (!settings.enabled) return { agents: [], pipelines: [] }
  return { agents: [retrospectiveAgent(settings.repos)], pipelines: [PIPELINE] }
}
