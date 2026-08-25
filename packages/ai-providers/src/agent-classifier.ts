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
}

/** `true` = el issue cumple el criterio; `false` = no lo cumple; `null` = no se
 *  pudo decidir (ver el comentario de arriba). */
export type AgentClassifier = (input: AgentClassifierInput) => Promise<boolean | null>

/** Construye la función inyectable en `AgentOrchestrator`. `log` sigue el mismo
 *  shape mínimo que el resto del paquete (ver `CreateAllProvidersDeps.log`). */
export function createAgentClassifier(deps: { log: AgentClassifierLog }): AgentClassifier {
  return async function classifyAgent(input: AgentClassifierInput): Promise<boolean | null> {
    const { task, agent } = input

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

    const system = [
      'Decidís si un issue cumple el criterio de activación de un agente automatizado.',
      `Criterio del agente "${agent.id}":`,
      agent.whenText,
      'Respondé SIEMPRE llamando a la tool `decide_activation`.',
      'Ante la duda, `matches: false` — el agente se saltea y un humano puede forzarlo,',
      'que es más barato que correrlo de más.',
    ].join('\n')
    const userMessage = [
      `Título: ${task.title}`,
      `Tipo: ${task.type}`,
      task.description ? `Descripción:\n${task.description}` : undefined,
    ]
      .filter(Boolean)
      .join('\n')

    try {
      const res = await requestAnthropicApi(
        {
          model: HAIKU_MODEL,
          max_tokens: 256,
          system,
          messages: [{ role: 'user', content: userMessage || '(sin descripción)' }],
          tools: [
            {
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
            },
          ],
          tool_choice: { type: 'tool', name: 'decide_activation' },
        },
        { headers, signal: AbortSignal.timeout(TIMEOUT_MS) },
      )

      if (!res.ok) {
        const errBody = await res.text().catch(() => '')
        deps.log.warn(
          { status: res.status, err: errBody.slice(0, 500), agent: agent.id },
          'agent classifier request failed',
        )
        return null
      }

      const data = (await res.json()) as {
        content?: Array<{
          type: string
          name?: string
          input?: { matches?: boolean; reason?: string }
        }>
      }
      const toolUse = (data.content ?? []).find(
        (b) => b.type === 'tool_use' && b.name === 'decide_activation',
      )
      const matches = toolUse?.input?.matches
      if (typeof matches !== 'boolean') {
        deps.log.warn(
          { agent: agent.id, got: toolUse?.input },
          'agent classifier returned no verdict',
        )
        return null
      }
      deps.log.debug?.(
        { agent: agent.id, matches, reason: toolUse?.input?.reason },
        'agent classifier verdict',
      )
      return matches
    } catch (err) {
      deps.log.warn({ err: (err as Error).message, agent: agent.id }, 'agent classifier errored')
      return null
    }
  }
}
