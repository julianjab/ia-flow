/**
 * Lo que el runner sabe hacerle a una task fuera de GitHub: volver a despachar su último evento,
 * volver a correr su review, pedirle al agente que pare. Lo conecta `mountInbox` (tiene el engine y la base de actividad); las
 * actions `redispatch_task`, `rerun_review` y `stop_agent` lo piden por `services.tasks`. Mismo patrón que
 * `AssistantDesk`: los servicios se arman antes que el engine, y esto se enchufa después.
 */
export interface TaskDeskPort {
  /** Vuelve a despachar el último evento de la task, a nombre de `by`. */
  redispatch(ref: string, by: string): Promise<string>
  /** Vuelve a correr el pipeline de Review, como si la card acabara de llegar ahí. */
  rerunReview(ref: string, by: string): Promise<string>
  /** Le pide al agente que corre para la task que termine su turno. */
  stop(ref: string, by: string): string
}

export class TaskDesk {
  private port: TaskDeskPort | undefined

  connect(port: TaskDeskPort): void {
    this.port = port
  }

  private connected(): TaskDeskPort {
    if (!this.port) throw new Error('el runner no está sirviendo la bandeja (--serve)')
    return this.port
  }

  redispatch(ref: string, by: string): Promise<string> {
    return this.connected().redispatch(ref, by)
  }

  rerunReview(ref: string, by: string): Promise<string> {
    return this.connected().rerunReview(ref, by)
  }

  stop(ref: string, by: string): string {
    return this.connected().stop(ref, by)
  }
}
