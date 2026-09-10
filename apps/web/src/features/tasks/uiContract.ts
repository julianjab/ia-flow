import type { UiContract } from '@ia-flow/shared'
import { runTaskNow } from '@/features/tasks/api'

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
 */

/**
 * Las operaciones que este cliente sabe ejecutar contra la API — el "qué
 * hace" de un botón.
 *
 * Están separadas de las primitivas porque son ejes distintos: una primitiva
 * es cómo se DIBUJA algo, una operación es qué API se LLAMA. Un botón nuevo
 * que corre algo ya soportado es una entrada acá y nada más; una forma nueva
 * de dibujar las mismas operaciones es una primitiva y nada más.
 *
 * `exec` recibe el proyecto y la tarea porque es lo único que toda operación
 * sobre una fila necesita. El resultado vuelve como texto para el toast: la
 * fila no sabe interpretar el veredicto de cada API, y quien la monta tampoco
 * debería tener un `switch` por operación.
 */
export interface TaskUiOperation {
  id: string
  /** Lo que el modelo lee para decidir si esta operación es la que le pidieron. */
  description: string
  exec(ctx: { projectId: string; taskId: string }): Promise<{ ok: boolean; message: string }>
}

export const TASK_UI_OPERATIONS: TaskUiOperation[] = [
  {
    id: 'run',
    description:
      'dispara el agente que corresponda a esa tarea, re-emitiendo su status actual (lo mismo que el botón "Correr ahora" del detalle). Útil en tareas que están esperando que alguien las arranque',
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
]

const OPERATION_IDS = TASK_UI_OPERATIONS.map((o) => o.id)

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
  slot: TaskUiSlot
  primitive: UiContract['primitives'][number]
}

export const TASK_UI_PRIMITIVES: TaskUiPrimitiveDef[] = [
  {
    slot: 'row',
    primitive: {
      id: 'row-action',
      description: [
        'un botón dentro de la fila de las tareas que indiques. Sirve cuando te piden "agregá un',
        'botón para …" sobre la lista. `op` dice qué hace el botón y sólo puede ser uno de estos:',
        TASK_UI_OPERATIONS.map((o) => `"${o.id}" — ${o.description}`).join('; '),
        '. Un botón es una afordancia, no un cambio: ponelo sólo en las filas donde tenga sentido',
        'usarlo, no en todas por las dudas.',
      ].join(' '),
      props: {
        type: 'object',
        properties: {
          op: {
            type: 'string',
            enum: OPERATION_IDS,
            description: 'Qué hace el botón al apretarlo.',
          },
          label: { type: 'string', description: 'El texto del botón (1-3 palabras).' },
          taskIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Las tareas en cuya fila aparece, con los ids EXACTOS del contexto.',
          },
        },
        required: ['op', 'label', 'taskIds'],
      },
      taskIdProps: ['taskIds'],
    },
  },
]

/** Lo que se manda en cada turno — sólo la parte del contrato que el modelo
 *  necesita ver (el `slot` se queda de este lado). */
export const TASK_UI_CONTRACT: UiContract = {
  primitives: TASK_UI_PRIMITIVES.map((d) => d.primitive),
}
