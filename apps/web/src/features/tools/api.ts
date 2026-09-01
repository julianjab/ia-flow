import {
  type ConfigScope,
  type EditableTool,
  EditableToolSchema,
  type NamedAction,
  NamedActionSchema,
  scopeQuery,
} from '@ia-flow/shared'
import axios from 'axios'

export interface ToolDefinition {
  name: string
  description: string
  input_schema: object
}

/**
 * El catálogo de tools que se le puede ofrecer a un agente.
 *
 * Con `scope` trae las de ese ámbito —las globales, más las definidas por el
 * proyecto—; el registry del daemon es uno solo, así que el filtro lo hace el
 * server contra la tabla. Sin `scope` devuelve el catálogo entero, que es lo
 * que necesita un consumidor sin ámbito propio (el panel de asistencia).
 */
export async function getTools(scope?: ConfigScope): Promise<ToolDefinition[]> {
  const { data } = await axios.get<ToolDefinition[]>(
    scope ? `/api/tools?${scopeQuery(scope)}` : '/api/tools',
  )
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
  /** Las de ESTE ámbito: se crean, editan y borran acá. */
  editable: EditableTool[]
  /** Las globales vistas desde un proyecto: se ven, se editan en General. */
  inherited: EditableTool[]
  /** Las del código. Siempre globales: su descripción se ajusta con un
   *  `override`, que pisa el registry del PROCESO — uno solo para todos los
   *  proyectos. Por eso sólo se pueden tocar desde General. */
  builtIns: BuiltInTool[]
  readOnly: boolean
}

export async function fetchEditableTools(scope: ConfigScope): Promise<EditableToolsResult> {
  const { data } = await axios.get<{
    editable: unknown[]
    inherited?: unknown[]
    builtIns: BuiltInTool[]
    readOnly: boolean
  }>(`/api/tools-crud?${scopeQuery(scope)}`)
  return {
    editable: data.editable.map((t) => EditableToolSchema.parse(t)),
    inherited: (data.inherited ?? []).map((t) => EditableToolSchema.parse(t)),
    builtIns: data.builtIns,
    readOnly: data.readOnly,
  }
}

export async function saveEditableTool(
  scope: ConfigScope,
  tool: EditableTool,
): Promise<EditableTool> {
  const { data } = await axios.put<{ tool: unknown }>(
    `/api/tools-crud/${encodeURIComponent(tool.name)}?${scopeQuery(scope)}`,
    tool,
  )
  return EditableToolSchema.parse(data.tool)
}

/** Para un override, esto es "revertir". El server avisa que la descripción
 *  original vuelve al reiniciar: vive en el código, y el registry del proceso
 *  ya la tiene pisada. */
export async function deleteEditableTool(
  scope: ConfigScope,
  name: string,
): Promise<{ note?: string }> {
  const { data } = await axios.delete<{ note?: string }>(
    `/api/tools-crud/${encodeURIComponent(name)}?${scopeQuery(scope)}`,
  )
  return data
}

/**
 * Las acciones que una tool de este ámbito puede ejecutar.
 *
 * Desde un proyecto son las suyas MÁS las heredadas; desde General, sólo las
 * globales. La unión se arma con las dos listas que el endpoint devuelve — con
 * sólo `actions` una tool del proyecto no podía referenciar una acción global,
 * que es el caso más común.
 *
 * Devuelve las acciones ENTERAS y no sus ids: el formulario necesita el cuerpo
 * para leer qué campos del payload interpola (`extractPayloadFields`), que es
 * lo que le permite ofrecer los parámetros de la tool en vez de pedir un JSON
 * Schema a ciegas.
 *
 * Esta feature hace su propia llamada en vez de importar la de `rules`: una
 * feature no importa a otra (ver el CLAUDE.md de apps/web). El tipo sí es
 * compartido —vive en `@ia-flow/shared`— que es donde el repo dice que suba lo
 * común; duplicar la URL es el costo aceptado de esa frontera.
 */
export async function fetchActions(scope: ConfigScope): Promise<NamedAction[]> {
  const { data } = await axios.get<{ actions: unknown[]; inherited?: unknown[] }>(
    `/api/actions?${scopeQuery(scope)}`,
  )
  return [...data.actions, ...(data.inherited ?? [])].map((a) => NamedActionSchema.parse(a))
}
