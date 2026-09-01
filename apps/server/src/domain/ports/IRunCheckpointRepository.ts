/**
 * El estado de trabajo de un run en vuelo.
 *
 * Angosto a propósito: tiene exactamente los cuatro verbos que sus dos
 * consumidores necesitan —el loop, que guarda; y el resume, que lee y limpia—
 * y nada más.
 *
 * `state` es OPACO. Lo produce y lo interpreta el provider (ver
 * `ProviderInput.saveCheckpoint`): para `anthropic-api` es su array de
 * mensajes, y un provider de terminal directamente no guarda nada. Este port
 * no modela ninguno de los dos, igual que `ProviderOutput.checkpoint` nunca lo
 * modeló.
 */
export interface RunCheckpoint {
  runId: string
  taskId: string
  agentId?: string
  projectId?: string
  state: unknown
  /** Cuántas veces se reanudó ESTE run desde un checkpoint. Es lo que evita
   *  que un run que hace crashear al proceso lo vuelva a hacer para siempre:
   *  el barrido de boot deja de reanudarlo pasado el tope. */
  attempts: number
  updatedAt: string
}

export interface IRunCheckpointRepository {
  /** Pisa el checkpoint del run. Se llama una vez por vuelta del loop, así que
   *  es un UPSERT y no un insert: sólo interesa el último request enviado. */
  save(input: {
    runId: string
    taskId: string
    agentId?: string
    projectId?: string
    state: unknown
    /** Sólo lo usa el PRIMER save de un run reanudado, para arrastrar el
     *  contador de la fila que reemplaza. Los saves siguientes lo mandan
     *  igual y el upsert lo ignora — el conteo no puede depender de en qué
     *  vuelta del loop murió el proceso. */
    attempts?: number
  }): Promise<void>

  /** El checkpoint de una task, si dejó uno. Es la lectura del resume, que
   *  conoce la task (viene de la espera) pero no el run que la dejó. */
  getByTask(taskId: string): Promise<RunCheckpoint | null>

  /**
   * Un run que terminó no tiene estado que conservar.
   *
   * Se llama en el cierre de todo run, y TAMBIÉN sobre la fila vieja cuando
   * otra la reanuda: el run reanudado guarda bajo su propio `runId`, así que
   * sin este borrado la fila del run muerto sobreviviría al nuevo y
   * `getByTask` la volvería a ofrecer — reanimando para siempre un checkpoint
   * que ya se consumió.
   */
  delete(runId: string): Promise<void>
}
