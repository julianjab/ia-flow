import { z } from 'zod'
import type { ToolInputSchema } from '../agent/SchemaTool.js'
import { createEvent } from '../events/DomainEvent.js'
import type { EventBus } from '../events/EventBus.js'
import type { PipelineExecutionContext, Runnable } from '../pipeline/Runnable.js'
import type { Capability } from './Capability.js'
import { RESULT_KEY, runForResult } from './runForResult.js'

/** Quién cumple cada capacidad, por nombre: fijo, o resuelto en cada pedido (una fuente que se
 *  recarga en caliente). `undefined` = apagada. */
export type CapabilityBindings =
  | Record<string, Runnable | undefined>
  | ((name: string) => Runnable | undefined)

/** La clave del `submit_*` donde un `Agent` entrega el resultado de la capacidad. */
export const CAPABILITY_RESULT = RESULT_KEY

/** Lo que un paso ve de las capacidades (`ctx.capabilities`). */
export interface CapabilityInvoker {
  /** Si alguien la cumple ahora mismo. */
  has(name: string): boolean
  /** El resultado, validado contra `capability.output` — `undefined` si está apagada. Tira si el
   *  `Runnable` falla o devuelve algo que no cumple el contrato: quien la pide decide cómo
   *  degradar. */
  invoke<I extends ToolInputSchema, O extends ToolInputSchema>(
    capability: Capability<I, O>,
    input: z.input<I>,
  ): Promise<z.infer<O> | undefined>
}

/**
 * Corre el `Runnable` enchufado a una capacidad, fuera de toda pipeline y ejecución: un evento
 * `capability.<nombre>` cuyo payload es el input (así un prompt lo lee como `{{campo}}`), sin
 * `steps` previos. Un `Agent` corre con TODAS sus salidas llevando a un paso `result` cuyo input
 * es `capability.output`: lo que el modelo entrega en `submit_<salida>.result` es la respuesta.
 * Sin reportes ni `onError`: el agente de una capacidad no publica nada.
 */
export class Capabilities implements CapabilityInvoker {
  constructor(
    private readonly bindings: CapabilityBindings,
    private readonly bus: EventBus,
  ) {}

  has(name: string): boolean {
    return this.bound(name) !== undefined
  }

  async invoke<I extends ToolInputSchema, O extends ToolInputSchema>(
    capability: Capability<I, O>,
    input: z.input<I>,
  ): Promise<z.infer<O> | undefined> {
    const runnable = this.bound(capability.name)
    if (!runnable) return undefined
    const payload = capability.input.parse(input) as Record<string, unknown>
    const ctx: PipelineExecutionContext = {
      event: createEvent(`capability.${capability.name}`, payload),
      steps: {},
      bus: this.bus,
      pipelineId: `capability:${capability.name}`,
      capabilities: this,
    }
    const raw = await runForResult(runnable, ctx, payload, capability.output)
    const parsed = capability.output.safeParse(raw)
    if (!parsed.success) {
      throw new Error(
        `capacidad "${capability.name}": ${runnable.id ?? 'el paso'} devolvió algo que no cumple el contrato\n${z.prettifyError(parsed.error)}`,
      )
    }
    return parsed.data
  }

  private bound(name: string): Runnable | undefined {
    return typeof this.bindings === 'function' ? this.bindings(name) : this.bindings[name]
  }
}
