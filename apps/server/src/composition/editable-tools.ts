import { getActionHandler } from '@ia-flow/rules'
import type { ActionContext } from '@ia-flow/rules'
import type { EditableTool, EngineEvent, NamedAction } from '@ia-flow/shared'
import { createEvent } from '@ia-flow/shared'
import { type Tool, getTool, registerTool, setToolDescription } from '@ia-flow/tools'
import { createLogger } from '../logger.js'

const log = createLogger('editable-tools')

// Las tools que salen de la config, aplicadas sobre el registry del proceso.
//
// **Por qué van al registry global y no se resuelven por dispatch:**
// `ProviderInput.tools` viaja como lista de NOMBRES —no de objetos— hasta el
// provider, que los resuelve contra el registry. Un `Tool` lleva un `execute`,
// que no es serializable, así que threadearlo por el input rompería el camino
// remoto. El nombre global es la consecuencia de eso, no una preferencia.
//
// Se re-aplican en cada cambio del CRUD, no sólo al bootear: editar una
// descripción tiene que valer para el próximo dispatch, no para el próximo
// reinicio.

export interface EditableToolsDeps {
  listTools(): Promise<EditableTool[]>
  /** Para resolver el `actionId` de una tool definida. */
  getAction(actionId: string): Promise<NamedAction | null>
}

/** Los nombres que ya ocupa una built-in. Una definida NO puede tomarlos. */
export function isBuiltInName(name: string): boolean {
  return getTool(name) !== undefined
}

/**
 * Una tool definida, como `Tool` ejecutable.
 *
 * Su `execute` corre la acción referenciada por el MISMO camino que la corre una
 * regla: mismo handler, mismo schema, mismas guardas. Una tool que ejecutara por
 * un camino propio podría saltearse un gate sin que nadie lo notara.
 *
 * El evento sintético existe porque `ActionContext` lo exige: una acción está
 * escrita para reaccionar a algo. Acá el "algo" es la invocación del modelo, y
 * decirlo explícitamente —`source: 'tool'`— es mejor que pasarle un evento falso
 * de otro tipo que sus condiciones podrían malinterpretar.
 */
export function toolFromAction(
  tool: Extract<EditableTool, { kind: 'defined' }>,
  action: NamedAction,
): Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema ?? { type: 'object', properties: {} },
    // Sólo `sync`: la acción corre en el DAEMON, y en un provider de terminal
    // el modelo esperaría que corriera donde está su CLI. Mismo criterio que
    // `bash_run`.
    providerKinds: ['sync'],
    async execute(input, ctx) {
      // El ámbito se hace cumplir ACÁ, no sólo en el picker del editor.
      //
      // El registry es uno por proceso y `applyEditableTools` registra las de
      // todos los proyectos —tiene que hacerlo: el dispatch resuelve por nombre
      // sin saber de ámbito—. `GET /api/tools` filtra las ajenas, pero eso es
      // la UI: un agente que ya tenga el nombre en su `tools[]` (heredado de
      // antes, escrito a mano, o adivinado —los nombres son únicos y visibles
      // desde General) la ejecutaría igual, corriendo la acción de otro
      // proyecto. Una tool GLOBAL sigue siendo de todos; sólo se rechaza la que
      // pertenece a otro.
      if (tool.projectId != null && ctx.projectId !== tool.projectId) {
        return `La tool '${tool.name}' es del proyecto '${tool.projectId}' y este run no le pertenece`
      }

      const handler = getActionHandler(action.body.action)
      if (!handler) return `Este daemon no sabe ejecutar acciones de tipo '${action.body.action}'`

      const event: EngineEvent = createEvent({
        type: `tool.${tool.name}`,
        source: 'tool',
        scope: {
          ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
          ...(ctx.taskId ? { issueId: ctx.taskId } : {}),
        },
        // Lo que el modelo mandó viaja como payload, así que la acción puede
        // interpolarlo igual que interpola un evento real.
        payload: (input ?? {}) as Record<string, unknown>,
      })

      const actionCtx: ActionContext = {
        event,
        rule: { id: `tool:${tool.name}` } as ActionContext['rule'],
        emit: async () => {},
      }

      const parsed = handler.configSchema.safeParse(action.body)
      if (!parsed.success) return `La acción '${action.id}' tiene config inválida`

      const result = await handler.execute(actionCtx, parsed.data as never)
      return result.ok ? (result.detail ?? 'ok') : `Falló: ${result.detail ?? 'sin detalle'}`
    },
  }
}

/**
 * Aplica todo lo editable sobre el registry.
 *
 * Best-effort por entrada: una tool rota —su acción se borró, su nombre choca
 * con una built-in— se saltea con un log y el resto se aplica igual. Volcar el
 * arranque entero por una fila mala dejaría al daemon sin ninguna tool.
 */
export async function applyEditableTools(deps: EditableToolsDeps): Promise<void> {
  let tools: EditableTool[]
  try {
    tools = await deps.listTools()
  } catch (err) {
    log.error({ err }, 'No se pudieron leer las tools editables — se sigue con las built-in')
    return
  }

  for (const t of tools) {
    if (t.kind === 'override') {
      // Una override sobre un nombre que no existe no es un error del daemon:
      // puede ser una built-in que se removió en un update. Se avisa y sigue.
      if (!setToolDescription(t.name, t.description)) {
        log.warn({ name: t.name }, 'Override de una tool que no existe — ignorada')
      }
      continue
    }

    if (isBuiltInName(t.name)) {
      // No puede pasar por el CRUD, pero la fila pudo escribirse por otro
      // camino. Tapar una built-in cambiaría en silencio lo que hace un agente
      // que la declara.
      log.error({ name: t.name }, 'Una tool definida choca con una built-in — ignorada')
      continue
    }

    const action = await deps.getAction(t.actionId).catch(() => null)
    if (!action) {
      log.warn({ name: t.name, actionId: t.actionId }, 'Tool sin acción — ignorada')
      continue
    }

    registerTool(toolFromAction(t, action))
    log.info({ name: t.name, actionId: t.actionId }, 'Tool definida registrada')
  }
}
