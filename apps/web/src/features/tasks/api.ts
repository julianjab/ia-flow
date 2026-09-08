import {
  type Blocker,
  BlockersBatchSchema,
  type CancelExecutionResult,
  CancelExecutionResultSchema,
  type ExecutionLog,
  ExecutionLogArraySchema,
  type RunTaskNowResult,
  RunTaskNowResultSchema,
  type SlackMemberRef,
  type TaskDispositionEntry,
  TaskDispositionEntryArraySchema,
  type TaskFocus,
  TaskFocusSchema,
  type TaskGroups,
  TaskGroupsSchema,
  type TaskRunPreview,
  TaskRunPreviewSchema,
  type TaskRunSummary,
  TaskRunSummaryArraySchema,
} from '@ia-flow/shared'
import axios from 'axios'

export interface SlackReviewResult {
  kind: 'first' | 're-review'
  threadUrl?: string
  channel: string
  reviewers: SlackMemberRef[]
  prNumber: number
  /** El pedido salió, pero el link del hilo no se pudo guardar: el próximo va a
   *  abrir un hilo nuevo. Se muestra como warning, no como error. */
  threadNotPersisted?: string
}

/**
 * Pide review del PR de la tarea en Slack.
 *
 * `allowFailedCi` sólo se manda cuando el operador confirmó un CI en rojo — el
 * server lo exige para que un pedido con build roto no salga por accidente
 * desde la API.
 */
export async function requestSlackReview(
  projectId: string,
  taskId: string,
  opts: { allowFailedCi?: boolean } = {},
): Promise<SlackReviewResult> {
  const { data } = await axios.post<SlackReviewResult>(
    `/api/tasks/${encodeURIComponent(taskId)}/slack-review`,
    { projectId, ...(opts.allowFailedCi ? { allowFailedCi: true } : {}) },
  )
  return data
}

/**
 * Vuelve a evaluar las reglas de la tarea contra su status actual, sin tocar
 * el board.
 *
 * Existe porque la activación escucha `issue.created`/`issue.status_changed`:
 * una tarea que se queda quieta en su status no se vuelve a despachar sola, y
 * hasta ahora el único recurso era moverla a otro status y traerla de vuelta.
 */
export async function runTaskNow(projectId: string, taskId: string): Promise<RunTaskNowResult> {
  const { data } = await axios.post(`/api/tasks/${encodeURIComponent(taskId)}/run`, { projectId })
  // `.parse()` y no un cast: si el server suma un cuarto outcome, esto falla
  // acá con el valor a la vista en vez de caer al `else` de la UI y anunciar
  // "ninguna regla matcheó" sobre un run que sí arrancó.
  return RunTaskNowResultSchema.parse(data)
}

/**
 * Los runs de UNA tarea, más recientes primero.
 *
 * La llamada vive acá y no se importa de `features/executions` a propósito:
 * una feature no importa de otra (ver CLAUDE.md). Lo que sí se comparte es el
 * schema, que es de `@ia-flow/shared` — que es exactamente la frontera que la
 * regla protege.
 */
export async function fetchTaskExecutions(
  projectId: string,
  taskId: string,
  limit = 10,
): Promise<ExecutionLog[]> {
  const { data } = await axios.get<{ executions: unknown }>('/api/executions', {
    params: { projectId, taskId, limit },
  })
  return ExecutionLogArraySchema.parse(data.executions)
}

/**
 * Qué pasaría si corrieras la tarea ahora — y si no va a correr, por qué.
 *
 * Es de lectura: el server evalúa las mismas reglas que el motor contra el
 * mismo evento, sin publicar nada.
 */
export async function fetchTaskRunPreview(
  projectId: string,
  taskId: string,
): Promise<TaskRunPreview> {
  const { data } = await axios.get(`/api/tasks/${encodeURIComponent(taskId)}/run-preview`, {
    params: { projectId },
  })
  return TaskRunPreviewSchema.parse(data)
}

/**
 * El último run y el conteo de intentos de TODAS las tareas del proyecto.
 *
 * Una request para el listado entero: por tarea eran tantas como filas. Las
 * tareas sin ningún run no vienen — su ausencia ES el dato (`○ sin ejecutar`),
 * y por eso el listado sólo puede afirmarlo cuando esta llamada volvió.
 */
export async function fetchTaskRunSummaries(projectId: string): Promise<TaskRunSummary[]> {
  const { data } = await axios.get<{ summaries: unknown }>('/api/executions/latest-by-task', {
    params: { projectId },
  })
  return TaskRunSummaryArraySchema.parse(data.summaries)
}

/**
 * La disposición de cada tarea del proyecto — quién mueve la próxima pieza.
 *
 * Es UNA request y no una por fila: sin el agregado, un listado de 40 tareas
 * eran 40 llamadas. Y se calcula en el server porque depende de las reglas de
 * retry, los blockers y el PR — tres cosas que el browser no tiene.
 *
 * Un 502 es "no se pudo hablar con la fuente", no "no hay nada": el llamador
 * tiene que distinguirlo para no afirmar "nada te espera" sobre datos que
 * nunca llegaron.
 */
export async function fetchTaskDispositions(projectId: string): Promise<TaskDispositionEntry[]> {
  const { data } = await axios.get<{ dispositions: unknown }>('/api/tasks/dispositions', {
    params: { projectId },
  })
  return TaskDispositionEntryArraySchema.parse(data.dispositions)
}

/**
 * El foco del proyecto — qué mirar primero de lo que ya está ordenado.
 *
 * `null` es una respuesta legítima y frecuente: no hay nada que decir, o la
 * feature está apagada. Un error se propaga, y ES la diferencia que la
 * pantalla dibuja: "no se pudo pensar" no es "no hay nada que hacer".
 */
export async function fetchTaskFocus(
  projectId: string,
  opts: { refresh?: boolean } = {},
): Promise<TaskFocus | null> {
  const { data } = await axios.get<{ focus: unknown }>('/api/tasks/focus', {
    params: { projectId, ...(opts.refresh ? { refresh: '1' } : {}) },
  })
  return data.focus ? TaskFocusSchema.parse(data.focus) : null
}

/**
 * Los grupos por tema del bucket `waiting-on-you` — hermano de
 * `fetchTaskFocus`, misma semántica de `null`/error.
 */
export async function fetchTaskGroups(
  projectId: string,
  opts: { refresh?: boolean } = {},
): Promise<TaskGroups | null> {
  const { data } = await axios.get<{ groups: unknown }>('/api/tasks/groups', {
    params: { projectId, ...(opts.refresh ? { refresh: '1' } : {}) },
  })
  return data.groups ? TaskGroupsSchema.parse(data.groups) : null
}

/** El tope que declara la ruta (`MAX_BLOCKER_IDS` en project-source.ts). */
const BLOCKERS_BATCH_SIZE = 100

/**
 * Los blockers de varias tareas de una.
 *
 * Un id que no aparece en el mapa es "no se pudo saber", no "no está
 * bloqueada": el llamador no debe rellenarlo con `[]`.
 */
export async function fetchBlockersBatch(
  projectId: string,
  ids: string[],
): Promise<Record<string, Blocker[]>> {
  if (!ids.length) return {}
  const out: Record<string, Blocker[]> = {}
  // El server rechaza más de 100 ids de una (freno para que un `?ids=` armado
  // a mano no dispare cientos de llamadas a la fuente). Un board de 150 tareas
  // es normal, así que se parte acá: sin esto el 400 se comía los blockers del
  // listado ENTERO, en silencio.
  for (let i = 0; i < ids.length; i += BLOCKERS_BATCH_SIZE) {
    const { data } = await axios.get<{ blockers?: unknown }>(
      `/api/projects/${encodeURIComponent(projectId)}/source/blockers`,
      { params: { ids: ids.slice(i, i + BLOCKERS_BATCH_SIZE).join(',') } },
    )
    Object.assign(out, BlockersBatchSchema.parse(data.blockers ?? {}))
  }
  return out
}

/**
 * Aborta el run en vuelo de una tarea.
 *
 * Las cuatro ramas vienen en la respuesta y hay que distinguirlas: la más
 * importante es `cancelRequested`, donde el run vive en OTRO daemon y lo único
 * que se hizo fue dejarle un aviso — el contenedor sigue corriendo, y decir
 * "abortado" sería mentir.
 */
export async function cancelTaskRun(executionId: string): Promise<CancelExecutionResult> {
  const { data } = await axios.post(`/api/executions/${encodeURIComponent(executionId)}/cancel`)
  return CancelExecutionResultSchema.parse(data)
}
