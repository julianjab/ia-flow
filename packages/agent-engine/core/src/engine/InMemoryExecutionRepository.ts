import type { DomainEvent } from '../events/DomainEvent.js'
import type { ExecutionRecord } from './Execution.js'
import type { ExecutionRepository } from './ExecutionRepository.js'

/** Repositorio en memoria: alcanza para un proceso. Un reinicio lo pierde todo. */
export class InMemoryExecutionRepository implements ExecutionRepository {
  private readonly records = new Map<string, ExecutionRecord>()
  private readonly inboxes = new Map<string, Array<{ event: DomainEvent<any>; read: boolean }>>()
  save(record: ExecutionRecord): void {
    if (record.status === 'running' || record.status === 'paused') {
      this.records.set(record.id, record)
      return
    }
    // Una ejecución cerrada ya no se recupera: en memoria no hace falta guardarla.
    this.records.delete(record.id)
    this.inboxes.delete(record.id)
  }

  delivered(executionId: string, event: DomainEvent<any>): void {
    const inbox = this.inboxes.get(executionId) ?? []
    inbox.push({ event, read: false })
    this.inboxes.set(executionId, inbox)
  }

  read(executionId: string): void {
    for (const entry of this.inboxes.get(executionId) ?? []) entry.read = true
  }

  live(): ExecutionRecord[] {
    return [...this.records.values()]
  }

  unread(executionId: string): DomainEvent<any>[] {
    return (this.inboxes.get(executionId) ?? [])
      .filter((entry) => !entry.read)
      .map((entry) => entry.event)
  }
}
