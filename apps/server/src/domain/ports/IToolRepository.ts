import type { EditableTool } from '@ia-flow/shared'

/**
 * Persistencia de las tools editables.
 *
 * Mismo contrato de ámbito que reglas y acciones —`visibleTo` para leer,
 * `list(scope)` para el CRUD— con una asimetría que no es un olvido: el NOMBRE
 * de una tool sigue siendo global (ver `ToolNameSchema`). El ámbito decide
 * quién la VE y quién la puede editar; no desambigua nombres, porque
 * `ProviderInput.tools` viaja como lista de nombres hasta un registry único del
 * proceso. Dos proyectos con una `deploy_staging` distinta tienen que llamarlas
 * distinto.
 */
export interface IToolRepository {
  isReadOnly(): boolean

  /**
   * Tools candidatas para un proyecto: las suyas MÁS las globales.
   *
   * `projectId` undefined devuelve sólo las globales — el ámbito General.
   */
  visibleTo(projectId?: string): Promise<EditableTool[]>

  /**
   * Sin `scope`, TODAS — cruzando ámbitos.
   *
   * Es lo que necesita `applyEditableTools`: el registry del proceso es uno
   * solo y tiene que registrar las de todos los proyectos, porque el dispatch
   * resuelve por nombre sin saber de ámbito. Acotarlo acá dejaría a un agente
   * de proyecto sin su tool.
   */
  list(scope?: { projectId?: string | null; global?: boolean }): Promise<EditableTool[]>

  getByName(name: string): Promise<EditableTool | null>
  upsert(tool: EditableTool): Promise<EditableTool>
  deleteByName(name: string): Promise<boolean>
}
