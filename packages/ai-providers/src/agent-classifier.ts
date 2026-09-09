// Decide si un issue cumple el criterio en texto libre (`whenText`) que un
// agente declara además de su `when` estructurado — el quinto filtro de
// selección, evaluado por `agent-text-gate.ts` en @ia-flow/agent-engine.
//
// Hermano de `provider-classifier.ts`, no una copia: aquella elige UNO entre N
// candidatos ("¿cuál?"), ésta responde sí/no sobre UN candidato ("¿aplica?").
// Son dos preguntas distintas y la de acá tiene que poder rechazar al único
// candidato que hay — un `choose_x` con enum no puede expresar "ninguno".
//
// Comparte con ella la mecánica: fetch crudo a la Messages API, mismo modelo
// Haiku, tool-use forzado para no interpretar prosa, y nunca lanza.
//
// `null` NO es "no aplica": es "no pude decidir" (sin auth, timeout, error de
// la API, respuesta inválida). El caller lo distingue y aborta la selección en
// vez de adivinar — misma decisión de producto que en provider-selection.ts:
// un dispatch que no puede resolver su gate se reintenta en el próximo scan.
import type { Task } from '@ia-flow/shared'
import { buildAnthropicHeaders, requestAnthropicApi } from './anthropic-api/auth.js'

const HAIKU_MODEL = 'claude-haiku-4-5-20251001'
const TIMEOUT_MS = 15_000

export interface AgentClassifierLog {
  warn: (obj: object, msg?: string) => void
  debug?: (obj: object, msg?: string) => void
}

export interface AgentClassifierInput {
  task: Pick<Task, 'title' | 'description' | 'type'>
  agent: { id: string; whenText: string }
  /** La conversación que este agente todavía no vio (issue + PRs abiertos +
   *  review threads sin resolver), ya renderizada y recortada por el gate —
   *  ver `renderConversationWindow` en @ia-flow/agent-engine. Llega hecha
   *  para que el texto juzgado acá y el que entra en la key del cache del
   *  gate sean el mismo. Ausente/vacío = nada nuevo desde su última corrida. */
  conversation?: string
}

/** `true` = el issue cumple el criterio; `false` = no lo cumple; `null` = no se
 *  pudo decidir (ver el comentario de arriba). */
export type AgentClassifier = (input: AgentClassifierInput) => Promise<boolean | null>

type ClassifierToolUse = {
  type: string
  name?: string
  input?: { matches?: boolean; reason?: string }
}
type ClassifierResponseBody = { content?: ClassifierToolUse[] }

/** System prompt: describe el criterio del agente y, si hay `conversation`,
 *  aclara que es sólo la novedad desde la última corrida — sin esto el
 *  modelo la trata como contexto de fondo en vez de la señal que podría
 *  activarlo. */
function buildClassifierSystemPrompt(
  agent: AgentClassifierInput['agent'],
  conversation: string | undefined,
): string {
  return [
    'Decidís si un issue cumple el criterio de activación de un agente automatizado.',
    `Criterio del agente "${agent.id}":`,
    agent.whenText,
    conversation
      ? 'La sección "Conversación nueva" trae SÓLO lo publicado desde la última corrida de este agente (comentarios del issue, de sus PRs abiertos y reviews sin resolver). Es la novedad que podría activarlo, no el historial completo.'
      : 'No hay comentarios nuevos desde la última corrida de este agente.',
    'Respondé SIEMPRE llamando a la tool `decide_activation`.',
    'Ante la duda, `matches: false` — el agente se saltea y un humano puede forzarlo,',
    'que es más barato que correrlo de más.',
  ].join('\n')
}

function buildClassifierUserMessage(
  task: AgentClassifierInput['task'],
  conversation: string | undefined,
): string {
  return [
    `Título: ${task.title}`,
    `Tipo: ${task.type}`,
    task.description ? `Descripción:\n${task.description}` : undefined,
    conversation ? `Conversación nueva:\n${conversation}` : undefined,
  ]
    .filter(Boolean)
    .join('\n')
}

const DECIDE_ACTIVATION_TOOL = {
  name: 'decide_activation',
  description: 'Indica si el issue cumple el criterio de activación del agente.',
  input_schema: {
    type: 'object',
    properties: {
      matches: {
        type: 'boolean',
        description: 'true si el issue cumple el criterio, false si no.',
      },
      reason: {
        type: 'string',
        description: 'Una frase corta justificando la decisión (va al log).',
      },
    },
    required: ['matches', 'reason'],
  },
} as const

async function handleFailedClassifierResponse(
  res: Response,
  agentId: string,
  log: AgentClassifierLog,
): Promise<null> {
  const errBody = await res.text().catch(() => '')
  log.warn(
    { status: res.status, err: errBody.slice(0, 500), agent: agentId },
    'agent classifier request failed',
  )
  return null
}

/** Saca el veredicto del `tool_use` de la respuesta, o `null` si el modelo no
 *  llamó a la tool o no mandó un `matches` booleano — mismo criterio de "no
 *  pude decidir" que el resto de la función. */
function extractClassifierVerdict(
  data: ClassifierResponseBody,
  agentId: string,
  log: AgentClassifierLog,
): boolean | null {
  const toolUse = (data.content ?? []).find(
    (b) => b.type === 'tool_use' && b.name === 'decide_activation',
  )
  const matches = toolUse?.input?.matches
  if (typeof matches !== 'boolean') {
    log.warn({ agent: agentId, got: toolUse?.input }, 'agent classifier returned no verdict')
    return null
  }
  log.debug?.(
    { agent: agentId, matches, reason: toolUse?.input?.reason },
    'agent classifier verdict',
  )
  return matches
}

/** Construye la función inyectable en `AgentOrchestrator`. `log` sigue el mismo
 *  shape mínimo que el resto del paquete (ver `CreateAllProvidersDeps.log`). */
export function createAgentClassifier(deps: { log: AgentClassifierLog }): AgentClassifier {
  return async function classifyAgent(input: AgentClassifierInput): Promise<boolean | null> {
    const { task, agent, conversation } = input

    let headers: Record<string, string>
    try {
      headers = buildAnthropicHeaders()
    } catch (err) {
      deps.log.warn(
        { err: (err as Error).message, agent: agent.id },
        'agent classifier skipped: no auth',
      )
      return null
    }

    const system = buildClassifierSystemPrompt(agent, conversation)
    const userMessage = buildClassifierUserMessage(task, conversation)

    try {
      const res = await requestAnthropicApi(
        {
          model: HAIKU_MODEL,
          max_tokens: 256,
          system,
          messages: [{ role: 'user', content: userMessage || '(sin descripción)' }],
          tools: [DECIDE_ACTIVATION_TOOL],
          tool_choice: { type: 'tool', name: 'decide_activation' },
        },
        { headers, signal: AbortSignal.timeout(TIMEOUT_MS) },
      )

      if (!res.ok) return await handleFailedClassifierResponse(res, agent.id, deps.log)

      const data = (await res.json()) as ClassifierResponseBody
      return extractClassifierVerdict(data, agent.id, deps.log)
    } catch (err) {
      deps.log.warn({ err: (err as Error).message, agent: agent.id }, 'agent classifier errored')
      return null
    }
  }
}
