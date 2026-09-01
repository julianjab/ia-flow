// Matching por scope — "dónde vive algo" ES su filtro.
//
// Una regla (y hoy, un agente) declara dónde se aplica con dos campos
// nullables. Vacío significa "sin restricción", nunca "no aplica a nada":
//
//   projectId: null,  repoName: null    → global, ve todo
//   projectId: 'X',   repoName: null    → sólo eventos del proyecto X
//   projectId: 'X',   repoName: 'api'   → proyecto X **y** repo api, los dos
//
// La contracara importa tanto como la regla: cuando el sujeto NO trae el dato
// (un mensaje suelto de Slack no sabe de qué proyecto es), una ubicación que sí
// lo declara **no matchea**. Eso es deliberado y fail-closed — si un scope
// ausente matcheara todo, un evento sin rutear dispararía las reglas de todos
// los proyectos a la vez. La consecuencia de diseño es que resolver el scope de
// un evento crudo es un paso explícito del pipeline (un agente de triage que
// emite un evento ya scopeado), no algo que el matcher adivine.
//
// Vive en su propio paquete y no en `agent-engine` porque tiene dos
// consumidores que no se conocen entre sí: la selección de agentes y el matcher
// de reglas. La flecha va agent-engine → rules, nunca al revés.

/** Dónde se aplica una regla o un agente. `null`/`undefined` = sin restricción. */
export interface ScopeLocation {
  projectId?: string | null
  repoName?: string | null
}

/**
 * De qué habla el sujeto que se está evaluando.
 *
 * `repos` es una lista y no un string porque el sujeto puede tocar más de un
 * repo: una task sin refinar trae `[]`, una ejecutable trae uno, y una épica
 * trae varios. El matching es de **pertenencia**, así que una lista vacía sólo
 * la matchean las ubicaciones que no declaran repo — que es justo lo que se
 * quiere: refinar primero, decidir el repo, después implementar.
 */
export interface MatchableScope {
  projectId?: string
  repos?: readonly string[]
}

/**
 * ¿La ubicación declarada acepta este sujeto?
 *
 * Puro y sin I/O a propósito: es lo que permite usarlo como pre-check barato
 * antes de comprometerse a un dispatch, y testearlo sin levantar nada.
 */
export function matchScope(location: ScopeLocation, scope: MatchableScope): boolean {
  if (location.projectId && location.projectId !== scope.projectId) return false
  if (location.repoName && !(scope.repos ?? []).includes(location.repoName)) return false
  return true
}
