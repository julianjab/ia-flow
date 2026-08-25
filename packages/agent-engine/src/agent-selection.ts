// Selección de agente — el corazón del engine agent-céntrico.
//
// El agente es la entidad principal: cada uno declara sus propios criterios de
// activación (`AgentActivationSchema`) y el engine, dado un issue, se pregunta
// "¿qué agente aplica acá?" en vez de "¿qué agentes cableó este status?".
//
// Los filtros se aplican en este orden. En Project/Repo/Status,
// `null`/`undefined` significa "sin restricción" (el agente matchea cualquier
// valor):
//
//   0. Scope   — el agente declara `statusName` o `when` no vacío. Ver
//                `isScoped` más abajo para por qué este gate existe.
//   1. Project — el agente pertenece al proyecto del issue, o es global.
//   2. Repo    — el agente apunta a un repo que el issue toca, o a ninguno.
//   3. Status  — el agente está asignado al status actual del issue, o a ninguno.
//   4. When    — las condiciones del agente evalúan true contra los campos del issue.
//
// Hay un quinto filtro, `whenText`, que NO vive acá: es semántico (lo decide un
// modelo leyendo el issue) y por lo tanto impuro. Vive en `agent-text-gate.ts`,
// que envuelve a este módulo — ver `selectAgentGated`. Este archivo se mantiene
// sin I/O a propósito: es lo que permite testear la selección estructural sin
// levantar nada, y lo que deja que `TaskDispatcher` la use como pre-check
// barato antes de comprometerse a un dispatch.
//
// De los candidatos que sobreviven todos, **se ejecuta el primero** por
// `position`. No hay cadena: un dispatch corre un agente. El siguiente ciclo de
// poll re-evalúa contra el status ya actualizado por los outcomes de ese run,
// que es lo que hace avanzar el pipeline.
import type { AgentDefinition, Task } from '@ia-flow/shared'
import { evalWhen } from './outcomes.js'

/** Filtro que descartó a un candidato. El orden del union es el de evaluación.
 *  `whenText` es el único que NO se decide acá: lo produce el gate semántico
 *  de `agent-text-gate.ts`, que es impuro (llama a un modelo) y por eso vive
 *  fuera de este módulo. Comparte el tipo para que el log de descartes sea uno
 *  solo. */
export type RejectionReason =
  | 'disabled'
  | 'unscoped'
  | 'project'
  | 'repo'
  | 'status'
  | 'when'
  | 'whenText'

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

// Sin `statusName` NI `when`, un agente no tiene ningún criterio que deje de
// cumplirse una vez que termina su propio run: `statusName` null matchea
// "cualquier status", así que el `onFinish` que mueve el issue a un status
// nuevo no lo saca de la selección — el próximo ciclo de scan lo vuelve a
// ver como candidato para el MISMO issue, corre otra vez, mueve el status
// otra vez, y así indefinidamente (issue real: sin el prefiltro de statuses
// que antes acotaba qué se escaneaba, esto pasó de "amplio pero acotado" a
// "loop sin freno" — ver el commit que agregó este gate). Exigir uno de los
// dos no es arbitrario: `statusName` acota a una etapa puntual del pipeline
// que el propio outcome abandona; `when` acota a una condición (ej. una
// label) que el run debería poder dejar de cumplir al terminar. Un agente
// así configurado sigue siendo válido para cualquier dispatch que no pase
// por `selectAgent` (hoy no existe ese camino, pero si aparece uno manual/
// directo en el futuro, este gate no lo alcanza — es a propósito, ver la
// discusión que llevó a este diseño).
function isScoped(agent: AgentDefinition): boolean {
  if (agent.statusName) return true
  if (Array.isArray(agent.when)) return agent.when.length > 0
  if (agent.when && typeof agent.when === 'object') return Object.keys(agent.when).length > 0
  return false
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

export interface AgentCandidatesResult {
  /** TODOS los agentes que sobreviven los filtros estructurales, en el orden
   *  en que habría que probarlos (especificidad → position → id). */
  candidates: AgentDefinition[]
  rejected: RejectedCandidate[]
}

/**
 * Aplica los cuatro filtros y devuelve **todos** los agentes que los cumplen,
 * en orden de prioridad, junto con el detalle de por qué cayó cada descartado.
 *
 * `selectAgent` se queda con el primero y es lo que usa cualquier caller que
 * necesite una decisión sincrónica y barata (el pre-check de `TaskDispatcher`).
 * La lista completa existe para el gate semántico de `agent-text-gate.ts`: si
 * el primer candidato declara `whenText` y el modelo dice que no aplica, hay
 * que poder seguir probando el siguiente sin volver a correr los filtros.
 */
export function selectAgentCandidates({
  task,
  agents,
  status,
}: AgentSelectionInput): AgentCandidatesResult {
  const rejected: RejectedCandidate[] = []
  const candidates: AgentDefinition[] = []

  // Orden de evaluación: **especificidad primero, `position` después.**
  //
  // El orden importa y la razón no es obvia. El universo mezcla agentes del
  // proyecto con globales, y cada scope numera sus posiciones de forma
  // independiente (`setPositions` renumera 0..n-1 dentro de un scope). Comparar
  // posiciones entre scopes no significa nada: reordenar los globales los
  // dejaría en 0..n-1 y, bajo un orden por `position` primero, se colarían
  // delante de agentes de proyecto que viven en 7, 8, 9 — el usuario reordena
  // una lista y promueve en silencio otra.
  //
  // Ordenando por especificidad primero, un agente del proyecto siempre le gana
  // a uno global, que es el default más amplio. `position` decide dentro de cada
  // scope, que es donde el usuario efectivamente lo controla desde la UI. `id`
  // cierra el desempate para que la elección sea siempre reproducible.
  //
  // Copia antes de ordenar: el array de entrada suele venir de un repositorio y
  // no es nuestro para mutar.
  const ordered = [...agents].sort((a, b) => {
    const bySpecificity = (a.projectId ? 0 : 1) - (b.projectId ? 0 : 1)
    if (bySpecificity !== 0) return bySpecificity
    const byPosition = (a.position ?? 0) - (b.position ?? 0)
    if (byPosition !== 0) return byPosition
    return a.id.localeCompare(b.id)
  })

  for (const agent of ordered) {
    if (agent.enabled === false) {
      rejected.push({ id: agent.id, reason: 'disabled' })
      continue
    }
    if (!isScoped(agent)) {
      rejected.push({ id: agent.id, reason: 'unscoped' })
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
    candidates.push(agent)
  }

  return { candidates, rejected }
}

/**
 * El primer agente que cumple los cuatro filtros estructurales, o `null`.
 *
 * NO evalúa `whenText` — eso requiere una llamada a un modelo y rompería la
 * pureza de la que dependen sus callers sincrónicos. El gate completo (filtros
 * + texto libre) es `selectAgentGated` en `agent-text-gate.ts`.
 */
export function selectAgent(input: AgentSelectionInput): AgentSelectionResult {
  const { candidates, rejected } = selectAgentCandidates(input)
  return { agent: candidates[0] ?? null, rejected }
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
