import { z } from 'zod'
import type { Tool } from './AgentDefinition.js'

/** Sólo `z.strictObject(...)`: la API de Anthropic exige `input_schema` de tipo `object`, y
 *  `strict` rechaza claves que el modelo invente en vez de descartarlas en silencio. */
export type ToolInputSchema = z.ZodObject<z.core.$ZodShape, z.core.$strict>

/**
 * Base para una `Tool` cuyo input se declara UNA vez como schema zod: de ahí salen el tipo de
 * `execute`, el `inputSchema` (JSON Schema) que ve el modelo, y la validación en runtime. El
 * input de una tool lo escribe el MODELO — sin validar, un campo omitido llega como
 * `undefined` a una función tipada como si siempre estuviera (ej. `fs_edit` sin `newString`
 * escribía el literal "undefined" en el archivo).
 *
 * `handler` TIRA si el input no valida: `AnthropicProvider` ya convierte cualquier throw de
 * un handler en un `tool_result` con `is_error: true`, así que el modelo recibe el detalle
 * (`✖ Invalid input: expected string → at newString`) y puede corregirse. La interfaz `Tool`
 * no cambia — un consumidor que no use zod sigue viendo `inputSchema` como JSON Schema plano.
 */
export abstract class SchemaTool<S extends ToolInputSchema> implements Tool<unknown> {
  abstract readonly name: string
  abstract readonly description: string
  abstract readonly input: S
  protected abstract execute(input: z.infer<S>): Promise<string> | string

  private cachedInputSchema?: Record<string, unknown>

  // Getter perezoso, no field: `input` es un field de la SUBCLASE, que todavía no está
  // asignado cuando corre el constructor de esta base.
  get inputSchema(): Record<string, unknown> {
    if (!this.cachedInputSchema) {
      const { $schema: _, ...schema } = z.toJSONSchema(this.input)
      this.cachedInputSchema = schema
    }
    return this.cachedInputSchema
  }

  // `async` para que un input inválido sea SIEMPRE una promesa rechazada, nunca un throw
  // síncrono — el caller no tiene que cubrir las dos formas de fallar.
  async handler(raw: unknown): Promise<string> {
    const parsed = this.input.safeParse(raw)
    if (!parsed.success) {
      throw new Error(`${this.name}: input inválido\n${z.prettifyError(parsed.error)}`)
    }
    return this.execute(parsed.data)
  }
}
