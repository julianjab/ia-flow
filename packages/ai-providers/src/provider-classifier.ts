// Desambigua entre providers candidatos usando Haiku, cuando el filtrado
// estructurado (`when`) de packages/agent-engine/src/provider-selection.ts
// deja >1 candidato y al menos uno trae `whenText`.
//
// Mismo patrón que el file simplifier de @ia-flow/tools (fs/fs.ts,
// `simplifyWithHaiku`): fetch crudo a la Messages API, mismo modelo Haiku,
// nunca lanza. A diferencia del simplifier (que degrada truncando), acá
// cualquier falla se traduce en `null` — la decisión del producto es que un
// dispatch que no puede resolver su provider falle ese ciclo y se reintente
// en el próximo scan, no que adivine un default silencioso.
//
// Usa tool-use forzado (`tool_choice`) en vez de parsear texto libre: la
// respuesta siempre es o bien uno de los `providerId` candidatos, o la
// llamada falla explícitamente — no hay que interpretar prosa.
import type { Task } from '@ia-flow/shared'
import { buildAnthropicHeaders, requestAnthropicApi } from './anthropic-api/auth.js'

const HAIKU_MODEL = 'claude-haiku-4-5-20251001'
const TIMEOUT_MS = 15_000

export interface ProviderClassifierLog {
  warn: (obj: object, msg?: string) => void
}

export interface ProviderClassifierInput {
  task: Pick<Task, 'title' | 'description' | 'type'>
  candidates: Array<{ providerId: string; whenText?: string }>
}

/** Construye la función `classify` inyectable en `AgentOrchestrator`. `log`
 *  sigue el mismo shape mínimo que el resto del paquete (ver
 *  `CreateAllProvidersDeps.log`). */
export function createProviderClassifier(deps: { log: ProviderClassifierLog }) {
  return async function classifyProvider(input: ProviderClassifierInput): Promise<string | null> {
    const { task, candidates } = input
    const candidateIds = candidates.map((c) => c.providerId)

    let headers: Record<string, string>
    try {
      headers = buildAnthropicHeaders()
    } catch (err) {
      deps.log.warn({ err: (err as Error).message }, 'provider classifier skipped: no auth')
      return null
    }

    const optionsText = candidates
      .map((c) => `- ${c.providerId}${c.whenText ? `: ${c.whenText}` : ''}`)
      .join('\n')
    const system = [
      'Elegís cuál de estos providers de ejecución es el más adecuado para la tarea dada.',
      'Providers candidatos:',
      optionsText,
      'Llamá SIEMPRE a la tool `choose_provider` con uno de esos ids exactos.',
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
              name: 'choose_provider',
              description: 'Elige el provider de ejecución más adecuado para esta tarea.',
              input_schema: {
                type: 'object',
                properties: { providerId: { type: 'string', enum: candidateIds } },
                required: ['providerId'],
              },
            },
          ],
          tool_choice: { type: 'tool', name: 'choose_provider' },
        },
        { headers, signal: AbortSignal.timeout(TIMEOUT_MS) },
      )

      if (!res.ok) {
        const errBody = await res.text().catch(() => '')
        deps.log.warn(
          { status: res.status, err: errBody.slice(0, 500), candidateIds },
          'provider classifier request failed',
        )
        return null
      }

      const data = (await res.json()) as {
        content?: Array<{ type: string; name?: string; input?: { providerId?: string } }>
      }
      const toolUse = (data.content ?? []).find(
        (b) => b.type === 'tool_use' && b.name === 'choose_provider',
      )
      const chosen = toolUse?.input?.providerId
      if (!chosen || !candidateIds.includes(chosen)) {
        deps.log.warn({ chosen, candidateIds }, 'provider classifier returned an invalid choice')
        return null
      }
      return chosen
    } catch (err) {
      deps.log.warn({ err: (err as Error).message, candidateIds }, 'provider classifier errored')
      return null
    }
  }
}
