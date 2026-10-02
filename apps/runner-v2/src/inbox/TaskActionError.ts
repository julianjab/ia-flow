/** Una acción que no se puede hacer, con el status HTTP que le corresponde. */
export class TaskActionError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}
