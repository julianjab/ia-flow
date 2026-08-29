// El quinto filtro de selección: `whenText`, el criterio en texto libre que un
// agente declara además de su `when` estructurado.
//
// Vive separado de `agent-selection.ts` por la misma razón que
// `provider-selection.ts` vive separado: los cuatro filtros estructurales son
// puros y sincrónicos (es lo que permite testearlos sin I/O y usarlos como
// pre-check barato en `TaskDispatcher`), y este necesita preguntarle a un
// modelo. Mezclarlos volvería async e impura toda la selección.
//
// ## Por qué existe
//
// `when` compara valores exactos (`=`, `!=`, `$null`) contra campos del issue.
// Alcanza para "tiene la label agent:e2e", no para "este cambio tiene efecto
// observable en runtime". Ese segundo tipo de criterio hoy se resuelve dentro
// del prompt del agente — que ya arrancó, ya tomó el lock del workspace y ya
// gastó un run entero para decidir que no aplicaba. `whenText` lo mueve al
// momento de la selección, donde cuesta una llamada a Haiku.
//
// ## Semántica: gate, no desempate
//
// Ojo con la diferencia contra `AgentProviderChoiceSchema.whenText`, que es el
// mismo campo con OTRA semántica: allá sólo desempata entre >1 candidato y
// nunca puede rechazar al único que hay. Acá es un gate — un agente con
// `whenText` puede quedar descartado aunque sea el único candidato, que es
// justamente el caso de uso (un e2e-tester que no debe correr sobre un cambio
// interno).
//
// ## Fallo del clasificador = abortar, no adivinar
//
// Si el modelo no puede decidir (sin auth, timeout, error de la API), NO se
// asume ni que sí ni que no: se aborta la selección entera y el dispatch se
// saltea. El issue conserva el estado que lo activó, así que el próximo scan
// lo reintenta. Es la misma decisión de producto que `resolveProvider` toma
// ante un classifier caído, y por eso tampoco se cae al siguiente candidato:
// el candidato dudoso tiene prioridad sobre él, y correr al de abajo sería
// elegir por descarte con información faltante.
import { selectCommentWindow } from '@ia-flow/issue-sources'
import type { AgentDefinition, Task } from '@ia-flow/shared'
import {
  type AgentSelectionInput,
  type AgentSelectionResult,
  type RejectedCandidate,
  selectAgentCandidates,
} from './agent-selection.js'
import { createLogger } from './logger.js'

const log = createLogger('agent-text-gate')

/** Puerto hacia el clasificador. Coincide con `AgentClassifier` de
 *  @ia-flow/ai-providers (`createAgentClassifier`); se redeclara acá para no
 *  hacer que agent-engine dependa de ai-providers sólo por un tipo. */
export type AgentTextClassifier = (input: {
  task: Pick<Task, 'title' | 'description' | 'type'>
  agent: { id: string; whenText: string }
  /** La conversación que ESTE agente todavía no vio, ya renderizada por
   *  `renderConversationWindow`. Se pasa hecha (en vez de mandar
   *  `task.comments` crudo) para que el texto que juzga el modelo y el que
   *  entra en la key del cache sean literalmente el mismo string — ver
   *  `verdictKey`. Vacío = no hay nada nuevo desde su última corrida. */
  conversation?: string
}) => Promise<boolean | null>

/**
 * Cache de veredictos en proceso.
 *
 * Sin esto, un issue que queda parado en el estado que activa a un agente con
 * `whenText` (justamente lo que pasa cuando el veredicto es "no aplica": nada
 * corre, así que nada cambia el estado) dispara una llamada a Haiku en CADA
 * ciclo de scan, para siempre.
 *
 * El veredicto sólo depende del criterio del agente y de lo que el agente ve
 * del issue, así que la key incluye las dos cosas: si alguien reescribe la
 * descripción, el `whenText` del agente, o aparece un comentario nuevo, la
 * entrada vieja deja de matchear sola y se vuelve a preguntar. No hay TTL a
 * propósito — no hay nada que expire salvo un cambio de contenido, y ese ya
 * está en la key.
 *
 * La conversación es parte de la key y NO un detalle de implementación: sin
 * ella, un `whenText` que hable de los comentarios queda congelado en el
 * primer veredicto para siempre — el issue no cambia de estado (justamente
 * porque el gate dijo que no), así que ningún otro componente de la key se
 * mueve y el comentario nuevo nunca se llega a evaluar.
 */
const MAX_CACHED_VERDICTS = 500
const verdicts = new Map<string, boolean>()

function verdictKey(agent: AgentDefinition, task: Task, conversation: string): string {
  // NUL como separador: no puede aparecer en ninguno de estos campos, asi que
  // dos keys distintas no pueden colapsar por concatenacion ambigua (con un
  // separador imprimible, un id que lo contenga alcanzaria para confundirlas).
  return [
    agent.id,
    agent.whenText ?? '',
    task.id,
    task.title,
    task.type,
    task.description,
    conversation,
  ].join('\u0000')
}

// Topes del render. La ventana de un issue con varias vueltas de
// build→review→build llega a decenas de comentarios y ~41k chars (medido en
// comment-window.ts); mandarlos enteros a un gate que corre en CADA scan es
// caro y además empeora la decisión, porque entierra lo reciente. Se recorta
// por la cola: lo último es lo que motiva el dispatch.
const MAX_CONVERSATION_COMMENTS = 10
const MAX_CONVERSATION_CHARS = 4000

/**
 * La conversación que `agentId` todavía no vio, lista para el prompt del gate.
 *
 * Usa la MISMA ventana que `Agent.run` le va a mostrar al agente si termina
 * corriendo (`selectCommentWindow`, cortada contra su último comentario
 * propio). Que el gate juzgue exactamente lo que el agente va a leer es lo que
 * hace que un `whenText` sobre la conversación signifique algo: si el gate
 * viera el historial completo podría activar por un comentario que el agente
 * ya atendió hace tres corridas.
 *
 * Es pura y sin I/O — los comentarios ya vienen cargados en el task (los trae
 * `TaskDispatcher` antes de llamar al orquestador), así que este gate no
 * agrega ni una llamada a la fuente.
 */
export function renderConversationWindow(task: Task, agentId: string): string {
  const unseen = selectCommentWindow(task.comments ?? [], agentId)
  if (!unseen.length) return ''

  const text = unseen
    .slice(-MAX_CONVERSATION_COMMENTS)
    .map((c) => {
      const where =
        c.origin === 'pr-review'
          ? `PR #${c.prNumber ?? '?'} · review${c.path ? ` · ${c.path}${c.line ? `:${c.line}` : ''}` : ''}`
          : c.origin === 'pr'
            ? `PR #${c.prNumber ?? '?'}`
            : 'issue'
      const who = c.author ? ` · ${c.author}` : ''
      return `[${c.created_at} · ${where}${who}]\n${c.body.trim()}`
    })
    .join('\n\n')

  // Recorta por el principio: el final es lo reciente.
  return text.length > MAX_CONVERSATION_CHARS ? `…\n${text.slice(-MAX_CONVERSATION_CHARS)}` : text
}

function rememberVerdict(key: string, value: boolean): void {
  // Evicción FIFO simple: el Map de JS itera en orden de inserción, así que la
  // primera key es la más vieja. No hace falta un LRU — el objetivo es acotar
  // memoria en un proceso de vida larga, no maximizar hit rate.
  if (verdicts.size >= MAX_CACHED_VERDICTS) {
    const oldest = verdicts.keys().next().value
    if (oldest !== undefined) verdicts.delete(oldest)
  }
  verdicts.set(key, value)
}

/** Sólo para tests — el cache es global al proceso a propósito (ver arriba). */
export function clearAgentTextVerdicts(): void {
  verdicts.clear()
}

export interface GatedAgentSelectionInput extends AgentSelectionInput {
  /** Ausente = `whenText` no se evalúa y la selección se comporta exactamente
   *  como `selectAgent`. Es el default de `AgentOrchestrator` para que los
   *  tests con fixtures mínimas (y cualquier deploy sin auth de Anthropic)
   *  sigan funcionando igual que antes de que este gate existiera. */
  classify?: AgentTextClassifier
}

/**
 * Selección completa: los cuatro filtros estructurales de `selectAgent` más el
 * gate semántico de `whenText`.
 *
 *   candidato sin `whenText`          → se elige, sin llamar al clasificador
 *   candidato con `whenText`, sí      → se elige
 *   candidato con `whenText`, no      → descartado (`reason: 'whenText'`), se
 *                                       prueba el siguiente
 *   el clasificador no pudo decidir   → `agent: null` (dispatch skipeado, se
 *                                       reintenta en el próximo scan)
 *   sin `classify` inyectado          → `whenText` se ignora
 */
export async function selectAgentGated({
  task,
  agents,
  status,
  classify,
}: GatedAgentSelectionInput): Promise<AgentSelectionResult> {
  const { candidates, rejected } = selectAgentCandidates({ task, agents, status })
  const allRejected: RejectedCandidate[] = [...rejected]

  for (const agent of candidates) {
    if (!agent.whenText || !classify) return { agent, rejected: allRejected }

    // Por candidato: la ventana depende de CUÁL agente pregunta.
    const conversation = renderConversationWindow(task, agent.id)
    const key = verdictKey(agent, task, conversation)
    const cached = verdicts.get(key)
    if (cached !== undefined) {
      if (cached) return { agent, rejected: allRejected }
      allRejected.push({ id: agent.id, reason: 'whenText' })
      continue
    }

    const matches = await classify({
      task,
      agent: { id: agent.id, whenText: agent.whenText },
      conversation,
    })
    if (matches === null) {
      log.warn(
        { taskId: task.id, agent: agent.id },
        'No se pudo evaluar whenText — dispatch skipeado, se reintenta en el próximo scan',
      )
      return { agent: null, rejected: allRejected }
    }

    rememberVerdict(key, matches)
    if (matches) return { agent, rejected: allRejected }
    log.info(
      { taskId: task.id, agent: agent.id },
      'El issue no cumple el whenText del agente — descartado',
    )
    allRejected.push({ id: agent.id, reason: 'whenText' })
  }

  return { agent: null, rejected: allRejected }
}
