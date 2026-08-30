import { type EditableTool, EditableToolSchema, NamedActionSchema } from '@ia-flow/shared'
import axios from 'axios'

export interface ToolDefinition {
  name: string
  description: string
  input_schema: object
}

export async function getTools(): Promise<ToolDefinition[]> {
  const { data } = await axios.get<ToolDefinition[]>('/api/tools')
  return data
}

// ─── Tools editables ───────────────────────────────────────────────────────
//
// Dos cosas con el mismo endpoint porque comparten identidad (el nombre): las
// tools DEFINIDAS por config, que ejecutan una acción, y los OVERRIDES de
// descripción sobre una built-in.

export interface BuiltInTool {
  name: string
  description: string
  /** Su descripción está pisada por un override. La UI lo marca y ofrece
   *  revertir: una descripción mal editada degrada en silencio a todos los
   *  agentes que usan esa tool, y ningún test lo agarra. */
  overridden: boolean
}

export interface EditableToolsResult {
  editable: EditableTool[]
  builtIns: BuiltInTool[]
  readOnly: boolean
}

export async function fetchEditableTools(): Promise<EditableToolsResult> {
  const { data } = await axios.get<{
    editable: unknown[]
    builtIns: BuiltInTool[]
    readOnly: boolean
  }>('/api/tools-crud')
  return {
    editable: data.editable.map((t) => EditableToolSchema.parse(t)),
    builtIns: data.builtIns,
    readOnly: data.readOnly,
  }
}

export async function saveEditableTool(tool: EditableTool): Promise<EditableTool> {
  const { data } = await axios.put<{ tool: unknown }>(
    `/api/tools-crud/${encodeURIComponent(tool.name)}`,
    tool,
  )
  return EditableToolSchema.parse(data.tool)
}

/** Para un override, esto es "revertir". El server avisa que la descripción
 *  original vuelve al reiniciar: vive en el código, y el registry del proceso
 *  ya la tiene pisada. */
export async function deleteEditableTool(name: string): Promise<{ note?: string }> {
  const { data } = await axios.delete<{ note?: string }>(
    `/api/tools-crud/${encodeURIComponent(name)}`,
  )
  return data
}

/**
 * Las acciones que una tool puede ejecutar, para el ámbito que se mire.
 *
 * Desde un proyecto trae las suyas MÁS las globales; desde General, sólo las
 * globales. El nombre de la tool sigue siendo global —eso no cambia— pero la
 * acción que ejecuta puede ser de un proyecto: el server resuelve por id sin
 * filtrar ámbito, así que funciona. Ofrecer sólo las globales dejaba una acción
 * de proyecto inalcanzable desde el formulario.
 *
 * Esta feature hace su propia llamada en vez de importar la de `rules`: una
 * feature no importa a otra (ver el CLAUDE.md de apps/web). El tipo sí es
 * compartido —vive en `@ia-flow/shared`— que es donde el repo dice que suba lo
 * común; duplicar la URL es el costo aceptado de esa frontera.
 */
export async function fetchActionIds(projectId?: string | null): Promise<string[]> {
  const q = projectId ? `projectId=${encodeURIComponent(projectId)}` : 'scope=global'
  const { data } = await axios.get<{ actions: unknown[] }>(`/api/actions?${q}`)
  return data.actions.map((a) => NamedActionSchema.parse(a).id)
}
