import type { EditableTool } from '@ia-flow/shared'

/**
 * Persistencia de las tools editables.
 *
 * Sin `visibleTo` a diferencia de reglas y acciones, y no es un olvido: el
 * nombre de una tool es global (ver `ToolNameSchema`), así que no hay ámbito
 * contra el cual acotar la lectura. `projectId` en una tool definida dice quién
 * la creó, no quién la ve.
 */
export interface IToolRepository {
  isReadOnly(): boolean
  list(): Promise<EditableTool[]>
  getByName(name: string): Promise<EditableTool | null>
  upsert(tool: EditableTool): Promise<EditableTool>
  deleteByName(name: string): Promise<boolean>
}
