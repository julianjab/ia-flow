/**
 * La capa proyecto del runner: la fuente de un proyecto (`projects/<id>/`) sólo recibe los eventos
 * de su scope (`scope.projectId`, que fija `resolve_task`). Es lo único que agrega: el engine no
 * sabe de proyectos, sabe de fuentes.
 */
import type { DomainEvent, ExitDefaults, PipelineSource } from '@ia-tools/agent-engine'

export class ProjectSource implements PipelineSource {
  constructor(
    private readonly inner: PipelineSource,
    readonly id: string,
  ) {}

  get defaults(): ExitDefaults | undefined {
    return this.inner.defaults
  }

  list(): ReturnType<PipelineSource['list']> {
    return this.inner.list()
  }

  explainMismatch(event: DomainEvent<any>): string | undefined {
    const owner = event.scope?.projectId
    if (owner === this.id) return this.inner.explainMismatch?.(event)
    return owner === undefined
      ? `proyecto ${this.id}: el evento no es de ningún proyecto`
      : `proyecto ${this.id}: el evento es del proyecto ${String(owner)}`
  }
}
