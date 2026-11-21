/** Nuestro prompt y el del cliente van como DOS bloques `system`, no mezclados en un texto: el
 *  nuestro queda solo y primero. Sin `system` del cliente (ausente o vacío), sale sólo el nuestro;
 *  sin prompt nuestro, el del cliente pasa intacto. Pura; la comparten las dos rutas. */
export function prependSystemPrompt(system: unknown, prompt: string): unknown {
  if (!prompt) return system
  if (system == null || system === '') return prompt
  if (typeof system === 'string') {
    return [
      { type: 'text', text: prompt },
      { type: 'text', text: system },
    ]
  }
  if (Array.isArray(system)) return [{ type: 'text', text: prompt }, ...system]
  return system
}
