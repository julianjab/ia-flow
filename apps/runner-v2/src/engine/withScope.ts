/**
 * La capa proyecto del runner: las pipelines de `projects/<id>/` llevan `scope.projectId: <id>`
 * —una propiedad más de su definición—, así sólo corren con los eventos de ese proyecto (los que
 * publica `resolve_task`). Se pone sobre las definiciones, antes de armarlas: el datasource no
 * sabe de proyectos, y el engine sólo filtra por `scope`.
 */
import type { DefinitionSource } from '@ia-flow/agent-engine-definitions'

export function withScope(
  datasource: DefinitionSource,
  scope: Record<string, unknown>,
): DefinitionSource {
  return {
    version: () => datasource.version(),
    read: () => {
      const docs = datasource.read()
      return {
        ...docs,
        pipelines: docs.pipelines.map((located) => ({
          ...located,
          doc: { ...located.doc, scope: { ...located.doc.scope, ...scope } },
        })),
      }
    },
  }
}
