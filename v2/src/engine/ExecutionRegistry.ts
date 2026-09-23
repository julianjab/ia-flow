import { Execution, type ExecutionMessage } from './Execution.js'

/**
 * Dueño de las Execution en vuelo, indexado por taskId (único scope que
 * Execution.matchesTask conoce hoy). Responde la pregunta del paso 5 del
 * engine: "¿este evento le habla a un run que ya está corriendo?" — Engine
 * la consulta ANTES de matchear Pipelines desde cero, para no arrancar un
 * dispatch nuevo cuando el mensaje era en realidad para un run vivo.
 */
export class ExecutionRegistry {
  private readonly byTaskId = new Map<string, Execution[]>()

  register(execution: Execution): void {
    throw new Error(
      'not implemented — if (!execution.taskId) return; ' +
        'const list = this.byTaskId.get(execution.taskId) ?? []; list.push(execution); this.byTaskId.set(execution.taskId, list)',
    )
  }

  /** Se llama desde execution.complete()/fail(), nunca antes — mientras esté
   *  running tiene que seguir siendo matcheable. */
  remove(execution: Execution): void {
    throw new Error(
      'not implemented — sacar `execution` del array de this.byTaskId.get(execution.taskId)',
    )
  }

  findRunning(taskId: string | undefined): Execution | undefined {
    throw new Error(
      'not implemented — taskId == null ? undefined : (this.byTaskId.get(taskId) ?? []).find(e => e.isRunning())',
    )
  }

  /** true si encontró una Execution running de esa task y el append pegó —
   *  Engine.dispatch corta ahí y NO reevalúa Rules para este evento. */
  tryAppend(taskId: string | undefined, message: ExecutionMessage): boolean {
    throw new Error(
      'not implemented — const exec = this.findRunning(taskId); return exec != null && exec.append(message)',
    )
  }
}
