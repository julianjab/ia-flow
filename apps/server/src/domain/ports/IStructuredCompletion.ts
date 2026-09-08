/**
 * Una vuelta de modelo cuya respuesta es un objeto, no prosa.
 *
 * Existe para que un caso de uso pueda pedirle algo a un modelo sin saber
 * cuál, ni con qué credencial, ni por qué mecanismo se fuerza la forma de la
 * salida (hoy: una tool sintética con `tool_choice`). El `schema` viaja opaco
 * —lo pone el que llama y el port no lo mira— por la misma razón que
 * `ProviderInput.saveCheckpoint` no mira el `state`: quien conoce la forma es
 * el dueño del dato, no el canal.
 *
 * `available` es una pregunta aparte de `complete` porque las respuestas son
 * distintas para quien las consume: sin credencial la feature **no existe**
 * (no se dibuja nada), mientras que un fallo de la llamada es un estado
 * degradado que sí se muestra y se puede reintentar.
 */
export interface StructuredCompletionRequest {
  system: string
  user: string
  /** JSON Schema del objeto esperado. Opaco para el port. */
  schema: unknown
  /** Cómo se llama la tool sintética, y qué dice su descripción. Es lo que el
   *  modelo lee para saber qué está llenando. */
  toolName: string
  toolDescription: string
  maxTokens: number
  /** Para el log: quién pide y sobre qué. */
  scope: Record<string, unknown>
}

export interface IStructuredCompletion {
  /** Hay con qué llamar al modelo. `false` ⇒ la feature está apagada, no rota. */
  isAvailable(): boolean
  /**
   * El objeto que devolvió el modelo, sin validar contra el schema — validar
   * es del que llama, que es el único que sabe qué hacer con un campo de más.
   *
   * Tira cuando la llamada falla (red, 429, credencial vencida). `null`
   * cuando la llamada salió bien pero el modelo no llenó la tool: son dos
   * cosas distintas y sólo la primera se reintenta.
   */
  complete(req: StructuredCompletionRequest): Promise<Record<string, unknown> | null>
}
