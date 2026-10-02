import type { PipelineExecutionContext } from '../pipeline/Runnable.js'

// Las plantillas `{{path}}` son puras y viven en `@ia-flow/rules` (también las usa la web); acá
// queda lo que necesita el contexto de una pipeline.
export { hasTemplate, render, renderText, substituteVars } from '@ia-flow/rules'

/** Contra qué se resuelve una plantilla al correr: el payload del evento en la raíz (igual que un
 *  `when`) y `steps`, más lo que agregue el paso (ej. `item` en un `forEach`). */
export function templateRoot(
  ctx: PipelineExecutionContext,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const payload = ctx.event.payload
  const base = typeof payload === 'object' && payload !== null ? payload : {}
  return { ...base, steps: ctx.steps, ...extra }
}
