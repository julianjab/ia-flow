import type { DefinitionSource } from '../DefinitionSource.js'
import type { SourceDocs } from '../SourceBuilder.js'

/** Un datasource en memoria: las definiciones tal cual, y una versión que el test sube. */
export class MemorySource implements DefinitionSource {
  private current = 0

  constructor(private docs: Omit<SourceDocs, 'source'> & Partial<Pick<SourceDocs, 'source'>>) {}

  set(docs: Partial<SourceDocs>): void {
    this.docs = { ...this.docs, ...docs }
    this.current++
  }

  version(): string {
    return String(this.current)
  }

  read(): SourceDocs {
    return { source: { path: 'mem:source', doc: {} }, ...this.docs }
  }
}

/** Una pipeline de un documento en memoria (`path` = dónde está, como lo diría un datasource). */
export const pipelineDoc = (doc: Record<string, unknown>, path = `mem:pipelines/${doc.id}`) => ({
  path,
  doc: doc as never,
})
