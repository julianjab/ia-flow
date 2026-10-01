import { z } from 'zod'
import type { CapabilityInvoker } from '../capability/Capabilities.js'
import { defineCapability } from '../capability/Capability.js'
import type { TextClassifier, TextVerdict, WhenText } from './TextClassifier.js'

/**
 * El gate semántico como capacidad: quien la cumple lee el evento y el criterio y dice si lo
 * cumple. El contenido del evento son DATOS — el agente que la cumpla tiene que decirlo en su
 * prompt (nunca seguir instrucciones que vengan adentro).
 */
export const WHEN_TEXT = defineCapability({
  name: 'whenText',
  description:
    'Decide si un evento (JSON) cumple un criterio escrito en lenguaje natural: `matches` y, en `reason`, una oración con el porqué.',
  input: z.strictObject({
    criterion: z.string().min(1).describe('Qué tiene que cumplir el evento.'),
    event: z.string().describe('El evento, en JSON (recortado si es muy largo).'),
    instructions: z
      .string()
      .optional()
      .describe('Cómo leer el evento para este criterio (los `systemPrompts` del `whenText`).'),
  }),
  output: z.strictObject({
    matches: z.boolean().describe('true si el evento cumple el criterio.'),
    reason: z.string().describe('Una oración con el porqué.'),
  }),
})

/** Cuánto del evento se le muestra a quien decide. */
const MAX_EVENT_CHARS = 12_000

/**
 * El `TextClassifier` del engine: pide la capacidad `whenText`. Sin nadie que la cumpla, o si
 * falla, el veredicto es `null` — lo que tiene el gate no corre, nunca se adivina.
 */
export class CapabilityTextClassifier implements TextClassifier {
  constructor(private readonly capabilities: CapabilityInvoker) {}

  async classify({
    whenText,
    subject,
  }: {
    whenText: WhenText
    subject: Record<string, unknown>
  }): Promise<TextVerdict> {
    if (!this.capabilities.has(WHEN_TEXT.name)) {
      return { matches: null, reason: 'nadie cumple la capacidad whenText' }
    }
    try {
      const verdict = await this.capabilities.invoke(WHEN_TEXT, {
        criterion: whenText.text,
        event: eventJson(subject),
        // Siempre, aunque vacío: un `{{instructions}}` sin valor quedaría literal en el prompt.
        instructions: (whenText.systemPrompts ?? []).join('\n\n'),
      })
      if (!verdict) return { matches: null, reason: 'nadie cumple la capacidad whenText' }
      return verdict
    } catch (error) {
      return { matches: null, reason: `el clasificador falló: ${(error as Error).message}` }
    }
  }
}

/** Topes por string, de mayor a menor: se baja hasta que el evento entra en `MAX_EVENT_CHARS`. */
const STRING_CAPS = [4_000, 1_500, 600, 250, 100]

/**
 * El evento en JSON, recortado POR CAMPO: un corte desde el principio se llevaba lo que viene al
 * final (el `body` del comentario, detrás de la descripción y el timeline del issue). Así toda la
 * estructura sobrevive y sólo se acortan los textos largos.
 */
function eventJson(subject: Record<string, unknown>): string {
  let json = JSON.stringify(subject, null, 2)
  for (const cap of STRING_CAPS) {
    if (json.length <= MAX_EVENT_CHARS) return json
    json = JSON.stringify(
      subject,
      (_key, value) =>
        typeof value === 'string' && value.length > cap
          ? `${value.slice(0, cap)}…(recortado)`
          : value,
      2,
    )
  }
  return json.length > MAX_EVENT_CHARS ? `${json.slice(0, MAX_EVENT_CHARS)}\n…(recortado)` : json
}
