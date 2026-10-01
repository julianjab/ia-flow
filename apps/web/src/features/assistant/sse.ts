import { type AssistantStreamEvent, AssistantStreamEventSchema } from '@ia-flow/shared'

// Parseo del SSE del asistente, sin red ni Vue: `POST /api/assistant` responde
// `text/event-stream` y un `EventSource` no puede hacer POST, así que se lee con
// `fetch` + `ReadableStream` y se corta en eventos acá.

/**
 * Corta un buffer en eventos SSE completos.
 *
 * Un evento termina en una línea en blanco; lo que queda después de la última
 * es un evento a medias y vuelve en `rest` para sumarle el próximo chunk.
 * Devuelve el `data:` de cada evento (varias líneas `data:` se unen con `\n`,
 * como manda la spec); comentarios (`:`) y otros campos (`event:`, `id:`) se
 * ignoran.
 */
export function splitSse(buffer: string): { events: string[]; rest: string } {
  const text = buffer.replace(/\r\n?/g, '\n')
  const blocks = text.split('\n\n')
  const rest = blocks.pop() ?? ''
  const events: string[] = []
  for (const block of blocks) {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
    if (data.length) events.push(data.join('\n'))
  }
  return { events, rest }
}

/** El `data:` de un evento → un `AssistantStreamEvent` validado, o `null` si no cumple el contrato. */
export function parseAssistantEvent(data: string): AssistantStreamEvent | null {
  let raw: unknown
  try {
    raw = JSON.parse(data)
  } catch {
    return null
  }
  const parsed = AssistantStreamEventSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}
