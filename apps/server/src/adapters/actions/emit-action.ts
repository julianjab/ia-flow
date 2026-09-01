import type { ActionContext, ActionHandler, ActionResult } from '@ia-flow/rules'
import { EmitActionSchema } from '@ia-flow/shared'
import type { z } from 'zod'

type EmitConfig = z.infer<typeof EmitActionSchema>

/**
 * Publicar un evento derivado.
 *
 * Es la acción que hace que el sistema se cierre sobre sí mismo: encadenar
 * reglas sin inventar un DSL de workflow, y convertir un evento crudo (un
 * mensaje suelto de Slack, sin scope) en uno ya ruteable.
 *
 * El scope del evento nuevo **hereda** el del que lo causó, y lo declarado en
 * la acción lo pisa campo por campo. Esa dirección importa: un agente de triage
 * que resuelve el proyecto sólo declara `projectId` y no tiene que repetir el
 * `issueId` que ya venía.
 *
 * No llama al bus directo: usa `ctx.emit`, que es quien aplica `deriveEvent` —
 * y con él `causationId` y `depth+1`. Publicar con `createEvent` reiniciaría la
 * profundidad en 0 y el tope del bus dejaría de frenar los ciclos.
 */
export class EmitAction implements ActionHandler<EmitConfig> {
  readonly kind = 'emit'
  readonly configSchema = EmitActionSchema

  async execute(ctx: ActionContext, config: EmitConfig): Promise<ActionResult> {
    await ctx.emit(config.type, config.payload ?? {}, {
      ...ctx.event.scope,
      ...(config.scope ?? {}),
    })
    return { ok: true, detail: `emit ${config.type}` }
  }
}
