import type { z } from 'zod'
import type { ToolInputSchema } from '../agent/SchemaTool.js'

/**
 * Algo que el engine (o un paquete) necesita de un modelo sin atarse a cuál: decidir un
 * `whenText`, enfocar un archivo largo, resumir. La capacidad declara SÓLO el contrato — qué
 * entra y qué sale —; quién la cumple es un `Runnable` que la app enchufa por nombre en
 * `EngineOptions.capabilities` (típicamente un `Agent` con un modelo chico, pero puede ser
 * cualquier paso). Sin nadie enchufado, la capacidad está apagada y quien la pide degrada.
 *
 * La declara quien la consume: `whenText` el core (`condition/CapabilityTextClassifier.ts`),
 * `fileFocus` las fs-tools.
 */
export interface Capability<I extends ToolInputSchema, O extends ToolInputSchema> {
  /** El nombre con el que la app la enchufa. */
  readonly name: string
  /** Qué hace, para quien escribe el agente que la cumple. */
  readonly description: string
  /** Lo que recibe el `Runnable`: como `payload` del evento (`{{campo}}` en un prompt) y como
   *  su `input`, si declara uno. */
  readonly input: I
  /** Lo que tiene que devolver. Un `Agent` lo entrega en su `submit_*`, bajo `result`. */
  readonly output: O
}

export type CapabilityInput<C> = C extends Capability<infer I, ToolInputSchema> ? z.input<I> : never
export type CapabilityOutput<C> =
  C extends Capability<ToolInputSchema, infer O> ? z.infer<O> : never

/** Declara una capacidad conservando los tipos de su input y su output. */
export function defineCapability<I extends ToolInputSchema, O extends ToolInputSchema>(
  capability: Capability<I, O>,
): Capability<I, O> {
  return capability
}
