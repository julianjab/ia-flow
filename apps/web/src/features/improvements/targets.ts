import type { ImprovementTarget } from '@ia-flow/shared'

/** Dónde se arregla una mejora, como se lee en la fila y en su detalle. */
export const TARGETS: Record<ImprovementTarget, string> = {
  docs: 'Docs del repo',
  config: 'Config del runner',
  engine: 'Engine',
}
