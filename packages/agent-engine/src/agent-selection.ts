// Selección de agente — el corazón del engine agent-céntrico.
//
// El agente es la entidad principal: cada uno declara sus propios criterios de
// activación (`AgentActivationSchema`) y el engine, dado un issue, se pregunta
// "¿qué agente aplica acá?" en vez de "¿qué agentes cableó este status?".
//
// Los cuatro filtros se aplican en este orden, y en los tres primeros
// `null`/`undefined` significa "sin restricción" (el agente matchea cualquier
// valor):
//
//   1. Project — el agente pertenece al proyecto del issue, o es global.
//   2. Repo    — el agente apunta a un repo que el issue toca, o a ninguno.
//   3. Status  — el agente está asignado al status actual del issue, o a ninguno.
//   4. When    — las condiciones del agente evalúan true contra los campos del issue.
//
// De los candidatos que sobreviven los cuatro, **se ejecuta el primero** por
// `position`. No hay cadena: un dispatch corre un agente. El siguiente ciclo de
// poll re-evalúa contra el status ya actualizado por los outcomes de ese run,
// que es lo que hace avanzar el pipeline.
import type { AgentDefinition, Task } from '@ia-flow/shared'
import { evalWhen } from './outcomes.js'

/** Filtro que descartó a un candidato. El orden del union es el de evaluación. */
export type RejectionReason = 'disabled' | 'project' | 'repo' | 'status' | 'when'

export interface RejectedCandidate {
  id: string
  reason: RejectionReason
}

export interface AgentSelectionInput {
  task: Task
  /**
   * Universo de candidatos, típicamente `agentRepo.visibleTo(projectId)` — ya
   * ordenado por `position` y con los globales incluidos. `selectAgent` vuelve
   * a filtrar por proyecto igual: el repo puede devolver un universo más ancho
   * (p. ej. `inScope(undefined)`) y el criterio no debe depender de eso.
   */
  agents: AgentDefinition[]
  /**
   * Status contra el que se evalúa. Se pasa explícito (en vez de leer
   * `task.status`) porque el orchestrator re-lee el status fresco de la fuente
   * antes de seleccionar, para no elegir contra un valor en memoria ya viejo.
   */
  status: string
}

export interface AgentSelectionResult {
  /** El agente a ejecutar, o `null` si ninguno matchea los cuatro criterios. */
  agent: AgentDefinition | null
  /** Candidatos descartados y en qué filtro cayeron — alimenta el log de diagnóstico. */
  rejected: RejectedCandidate[]
}

function matchesProject(agent: AgentDefinition, task: Task): boolean {
  // Sin projectId = agente global, elegible en cualquier proyecto.
  if (!agent.projectId) return true
  return agent.projectId === task.projectId
}

function matchesRepo(agent: AgentDefinition, task: Task): boolean {
  // Sin repoName = el agente no discrimina por repo.
  if (!agent.repoName) return true
  // Pertenencia contra `task.repos[]`, misma semántica que el alias
  // `repository` del DSL de condiciones. Un issue sin refinar (`repos: []`)
  // sólo puede ser tomado por agentes sin repo asignado — que es justo lo que
  // se quiere: refinar primero, decidir el repo, después implementar.
  return task.repos.includes(agent.repoName)
}

function matchesStatus(agent: AgentDefinition, status: string): boolean {
  // Sin statusName = el agente es candidato en cualquier etapa del pipeline.
  if (!agent.statusName) return true
  return agent.statusName.toLowerCase() === status.toLowerCase()
}

/**
 * Aplica los cuatro filtros y devuelve el primer agente que los cumple todos,
 * junto con el detalle de por qué cayó cada descartado.
 */
export function selectAgent({ task, agents, status }: AgentSelectionInput): AgentSelectionResult {
  const rejected: RejectedCandidate[] = []

  // `position` gobierna el orden. Copia antes de ordenar: el array de entrada
  // suele venir de un repositorio y no es nuestro para mutar.
  //
  // Los empates necesitan un desempate explícito: el universo mezcla agentes
  // del proyecto con globales, y cada scope numera sus posiciones por separado
  // (`setPositions` arranca en 0 en ambos), así que dos agentes en `position 0`
  // es normal, no una anomalía. Sin criterio, el ganador lo decidiría el orden
  // de filas de SQLite — invisible para el usuario e imposible de cambiar desde
  // la UI. Desempatamos por especificidad (el agente del proyecto le gana al
  // global, que es el default más amplio) y después por `id`, para que la
  // elección sea siempre reproducible.
  const ordered = [...agents].sort((a, b) => {
    const byPosition = (a.position ?? 0) - (b.position ?? 0)
    if (byPosition !== 0) return byPosition
    const bySpecificity = (a.projectId ? 0 : 1) - (b.projectId ? 0 : 1)
    if (bySpecificity !== 0) return bySpecificity
    return a.id.localeCompare(b.id)
  })

  for (const agent of ordered) {
    if (agent.enabled === false) {
      rejected.push({ id: agent.id, reason: 'disabled' })
      continue
    }
    if (!matchesProject(agent, task)) {
      rejected.push({ id: agent.id, reason: 'project' })
      continue
    }
    if (!matchesRepo(agent, task)) {
      rejected.push({ id: agent.id, reason: 'repo' })
      continue
    }
    if (!matchesStatus(agent, status)) {
      rejected.push({ id: agent.id, reason: 'status' })
      continue
    }
    if (!evalWhen(task as unknown as Record<string, unknown>, agent.when)) {
      rejected.push({ id: agent.id, reason: 'when' })
      continue
    }
    return { agent, rejected }
  }

  return { agent: null, rejected }
}

/**
 * Resumen legible de los descartes para el log. Agrupa por filtro para que la
 * línea diga "cayeron 4 por status, 1 por when" en vez de listar 40 ids.
 */
export function summarizeRejections(rejected: RejectedCandidate[]): string {
  if (!rejected.length) return 'sin candidatos'
  const byReason = new Map<RejectionReason, string[]>()
  for (const r of rejected) {
    const bucket = byReason.get(r.reason)
    if (bucket) bucket.push(r.id)
    else byReason.set(r.reason, [r.id])
  }
  return [...byReason.entries()].map(([reason, ids]) => `${reason}: ${ids.join(', ')}`).join(' | ')
}
