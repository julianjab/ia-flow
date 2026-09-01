// Precio de lista por modelo, para convertir tokens en dólares.
//
// Vive en `shared` y no en el server porque es la misma tabla que la web
// necesita para mostrar el costo de un run suelto sin pedírselo al server,
// y porque es dato puro: sin I/O ni estado, como `resolveCommentTarget`.
//
// No pretende ser exacta al centavo. Es lo que hace comparables a dos agentes
// que corren con modelos distintos — sin esto, "3M de tokens" no dice si
// costó 3 dólares o 30. Cuando Anthropic cambia un precio se edita acá y los
// paneles lo recalculan solos, porque el costo se deriva al leer, nunca se
// persiste.

/** USD por millón de tokens. */
export interface ModelPricing {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** Entrada, salida y cache de un run (o de una ventana entera). */
export interface TokenUsageLike {
  tokensIn: number
  tokensOut: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

// Ordenada de más específica a más general: `claude-opus-4-6` tiene que
// ganarle a `claude-opus`, y un id con sufijo de fecha
// (`claude-haiku-4-5-20251001`) matchea por prefijo.
const PRICING: ReadonlyArray<[prefix: string, price: ModelPricing]> = [
  ['claude-fable-5-1', { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 }],
  ['claude-mythos-5-1', { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 }],
  ['claude-fable-5', { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 }],
  ['claude-opus-5', { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
  ['claude-opus-4-8', { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
  ['claude-opus-4-7', { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
  ['claude-opus-4-6', { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
  ['claude-opus-4-5', { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
  ['claude-opus-4', { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }],
  ['claude-sonnet-5', { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }],
  ['claude-sonnet-4', { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  ['claude-haiku-4', { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }],
  ['claude-haiku-3', { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 }],
]

/** Precio de lista del modelo, o `undefined` si no está en la tabla. */
export function modelPricing(model: string | null | undefined): ModelPricing | undefined {
  if (!model) return undefined
  const id = model.trim().toLowerCase()
  return PRICING.find(([prefix]) => id.startsWith(prefix))?.[1]
}

/**
 * Costo estimado en USD, o `null` si el modelo no tiene precio conocido.
 *
 * Null y no 0 a propósito: un agente cuyo modelo no está en la tabla no es
 * gratis, es desconocido, y en una columna de costos un 0 lo mandaría al
 * fondo de la lista de prioridades, que es exactamente donde no va.
 */
export function estimateCostUsd(
  model: string | null | undefined,
  usage: TokenUsageLike,
): number | null {
  const price = modelPricing(model)
  if (!price) return null
  const perMillion =
    usage.tokensIn * price.input +
    usage.tokensOut * price.output +
    usage.cacheReadTokens * price.cacheRead +
    usage.cacheCreationTokens * price.cacheWrite
  return perMillion / 1_000_000
}
