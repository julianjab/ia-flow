import type { UiContract, UiPrimitive } from '@ia-flow/shared'
import { runTaskNow, updateTaskStatus } from '@/features/tasks/api'

/**
 * **El contrato visual del asistente de tareas — la única fuente de verdad de
 * lo que el modelo puede dibujar.**
 *
 * Todo lo demás se deriva de acá y nada lo duplica: el server interpola estas
 * `description` en el prompt y estos `props` en el JSON Schema que le fuerza
 * al modelo (`buildResponseSchema`/`buildViewPromptBlock` en
 * `TaskChatUseCase.ts`), y verifica contra estos `id` sin saber qué
 * significan. Por eso **sumar una capacidad es editar este archivo y escribir
 * su renderer** — no hay prompt que tocar, ni tipo que ampliar en
 * `@ia-flow/shared`, ni rama nueva en el use-case, ni migración.
 *
 * Se publica en cada turno (`TaskChatRequest.uiContract`) en vez de vivir en
 * la base: quien renderiza es quien declara. Un bundle recién desplegado
 * ofrece sus primitivas nuevas en el turno siguiente, y uno viejo nunca
 * recibe un bloque que no sabría dibujar.
 *
 * **El contrato se CONSTRUYE por turno, no es una constante**, porque parte de
 * él es dato de runtime: los statuses posibles salen del board del proyecto
 * activo, así que hornearlos en el módulo dejaría al modelo eligiendo de una
 * lista inventada. Todo lo que el modelo tenga que elegir de un conjunto real
 * entra por `TaskUiContext`.
 */

/** Lo que el contrato necesita saber del proyecto activo para armarse. */
export interface TaskUiContext {
  /** Los statuses reales del board — `GET /source/statuses`, ya cargados por
   *  `TareasSection`. Vacío significa que no se pudieron leer: las
   *  operaciones que dependan de ellos se omiten del contrato en vez de
   *  ofrecerse con un enum vacío que el modelo no puede completar. */
  statuses: string[]
}

/**
 * Las operaciones que este cliente sabe ejecutar contra la API — el "qué
 * hace" de un botón.
 *
 * Están separadas de las primitivas porque son ejes distintos: una primitiva
 * es cómo se DIBUJA algo, una operación es qué API se LLAMA. Un botón nuevo
 * que corre algo ya soportado es una entrada acá y nada más; una forma nueva
 * de dibujar las mismas operaciones es una primitiva y nada más.
 *
 * `params` es el JSON Schema de lo que el MODELO tiene que completar para que
 * la operación tenga sentido (a qué status mover, por ejemplo). Sin él, la
 * operación es un verbo suelto — que es lo que era `run`.
 *
 * `available` deja que una operación se retire del contrato cuando el
 * contexto no alcanza para ofrecerla. Es lo que evita el peor resultado
 * posible: un botón que el modelo propone, el operador aprieta, y falla.
 */
export interface TaskUiOperation {
  id: string
  /** Lo que el modelo lee para decidir si esta operación es la que le pidieron. */
  describe(ctx: TaskUiContext): string
  params?(ctx: TaskUiContext): Record<string, unknown>
  available?(ctx: TaskUiContext): boolean
  exec(ctx: {
    projectId: string
    taskId: string
    params: Record<string, unknown>
  }): Promise<{ ok: boolean; message: string }>
}

export const TASK_UI_OPERATIONS: TaskUiOperation[] = [
  {
    id: 'run',
    describe: () =>
      'dispara el agente que corresponda a esa tarea, re-emitiendo su status actual (lo mismo que el botón "Correr ahora" del detalle). Útil en tareas que están esperando que alguien las arranque. No lleva `params`',
    async exec({ projectId, taskId }) {
      const res = await runTaskNow(projectId, taskId)
      // Los tres outcomes son estados distintos y el operador tiene que poder
      // distinguirlos: "no matcheó ninguna regla" es config, no un error del
      // server, y verlo como éxito sería peor que verlo como fallo.
      if (res.outcome === 'skipped')
        return { ok: false, message: `Ninguna regla matchea el status "${res.status}"` }
      return {
        ok: true,
        message:
          res.outcome === 'deferred' ? 'En cola por capacidad' : `Corriendo (status ${res.status})`,
      }
    },
  },
  {
    id: 'set-status',
    describe: (ctx) =>
      `mueve la tarea a otro status del board (esto SÍ toca el board real, no es una preferencia de vista). Requiere \`params.status\`, que tiene que ser uno de: ${ctx.statuses.join(', ')}. Poné un botón por cada destino distinto que propongas`,
    params: (ctx) => ({
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ctx.statuses,
          description: 'El status destino, EXACTAMENTE como figura en la lista.',
        },
      },
      required: ['status'],
    }),
    // Sin statuses leídos no hay enum que ofrecer, y un botón "mover a…" sin
    // destino válido sólo puede terminar en un 500.
    available: (ctx) => ctx.statuses.length > 0,
    async exec({ projectId, taskId, params }) {
      const status = String(params.status ?? '')
      if (!status) return { ok: false, message: 'El botón no trae status destino' }
      await updateTaskStatus(projectId, taskId, status)
      return { ok: true, message: `Movida a "${status}"` }
    },
  },
]

export function findTaskUiOperation(id: string): TaskUiOperation | undefined {
  return TASK_UI_OPERATIONS.find((o) => o.id === id)
}

/**
 * Dónde se monta cada primitiva. Lo declara el contrato en vez de que cada
 * consumidor lo adivine: `row` lo dibuja `TaskChatRowOverlay` dentro de las
 * filas que el bloque nombra, `list` iría al pie de la lista entera.
 *
 * No viaja al server (no está en `UiPrimitiveSchema`) porque es información
 * puramente de layout: al modelo no le sirve saber en qué slot cae un bloque,
 * y mandarla sería contexto que paga tokens sin cambiar ninguna decisión suya.
 */
export type TaskUiSlot = 'row' | 'list'

export interface TaskUiPrimitiveDef {
  id: string
  slot: TaskUiSlot
  taskIdProps: string[]
  /** La mitad que depende del contexto: descripción y JSON Schema del payload. */
  build(ctx: TaskUiContext): Pick<UiPrimitive, 'description' | 'props'>
}

/**
 * La parte ESTÁTICA de cada primitiva — la que el store necesita para repartir
 * los bloques por fila sin reconstruir el contrato entero (`rowBlocksByTask`).
 */
export const TASK_UI_PRIMITIVES: TaskUiPrimitiveDef[] = [
  {
    id: 'row-action',
    slot: 'row',
    taskIdProps: ['taskIds'],
    build(ctx) {
      const ops = TASK_UI_OPERATIONS.filter((o) => o.available?.(ctx) ?? true)
      return {
        description: [
          'un botón dentro de la fila de las tareas que indiques. Sirve cuando te piden "agregá un',
          'botón para …" sobre la lista. `op` dice qué hace el botón, y cada `op` acepta los',
          'campos que su rama del schema declara:',
          ops.map((o) => `"${o.id}" — ${o.describe(ctx)}`).join('; '),
          '. Un botón es una afordancia, no un cambio: ponelo sólo en las filas donde tenga',
          'sentido usarlo, no en todas por las dudas.',
        ].join(' '),
        // `anyOf` con una rama por operación — el mismo patrón que el server
        // usa para las primitivas. Es lo que permite que cada `op` traiga sus
        // propios `params` obligatorios sin que el schema tenga que aceptar
        // un objeto libre: la API garantiza que un "set-status" venga con su
        // status, en vez de que lo descubra el renderer al fallar.
        props: {
          anyOf: ops.map((o) => {
            const params = o.params?.(ctx)
            return {
              type: 'object',
              properties: {
                op: { type: 'string', const: o.id },
                label: { type: 'string', description: 'El texto del botón (1-3 palabras).' },
                taskIds: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Las tareas en cuya fila aparece, con los ids EXACTOS del contexto.',
                },
                ...(params ? { params } : {}),
              },
              required: ['op', 'label', 'taskIds', ...(params ? ['params'] : [])],
            }
          }),
        },
      }
    },
  },
]

/** Lo que se manda en cada turno — sólo la parte del contrato que el modelo
 *  necesita ver (el `slot` se queda de este lado). */
export function buildTaskUiContract(ctx: TaskUiContext): UiContract {
  return {
    primitives: TASK_UI_PRIMITIVES.map((def) => ({
      id: def.id,
      taskIdProps: def.taskIdProps,
      ...def.build(ctx),
    })),
  }
}
