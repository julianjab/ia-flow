// Qué comentarios de un issue ve un agente cuando arranca: los posteriores a
// la última vez que ESE agente comentó.
//
// ## Por qué existe
//
// Un agente que despierta necesita responder una sola pregunta: *¿qué pasó
// desde la última vez que terminé?*. La respuesta es el handoff del agente
// anterior — el `fail_task` del ci-watcher, el reporte del e2e-tester, el
// comentario de un humano.
//
// Antes esto no funcionaba en ninguno de los dos extremos:
//
// - **Filtrando por autor** (todo lo que el engine escribe lleva un marker
//   `<!-- ia-flow: -->` y se descartaba): el handoff entre agentes se
//   clasificaba como "ruido del engine" junto al stack trace de `postError`,
//   así que `{{task.comments}}` llegaba VACÍO. Un implementer re-despachado
//   por un e2e fallido no tenía forma de saber por qué lo despertaron.
// - **Sin filtrar**: sobre un issue con varias vueltas de build→review→build,
//   el prompt recibe todo el historial (medido sobre un caso real: 26
//   comentarios, 41k chars) — y con TRES `❌ falló` distintos delante, un
//   prompt que dice "el comentario `❌ falló` es la razón por la que estás
//   corriendo" pasa de no tener información a tener una respuesta confiada y
//   equivocada, apuntando a un fallo ya arreglado hace días.
//
// El corte correcto no es por autor sino por **recencia**: todo lo anterior al
// último comentario propio ya lo vio la corrida pasada. La ventana se corre
// sola en cada run, así que no crece con los reintentos.
//
// ## Por qué vive acá y no en cada source
//
// Es pura (cero I/O) y depende de QUÉ AGENTE corre, no de dónde viven los
// issues. `ITaskSource.loadComments(item)` no tiene agente en su firma —
// meterlo ahí empujaría una preocupación de run al contrato del source y
// obligaría a cada source futuro a reimplementar esto. Lo que reconoce es el
// formato de comentario que escribe el propio engine (`# <agentId>`, ver
// formatProgressComment/formatFailComment en @ia-flow/tools y el comentario
// de cierre en Agent.ts), que no es conocimiento de GitHub.
//
// Se aplica UNA vez, en `Agent.run`, contra el `agentDef` definitivo — no en
// `TaskDispatcher`, cuyo match puede no ser el agente que termina corriendo
// (el orquestador re-selecciona contra el status fresco).

/** Marker de un comentario humano ya consumido por un run. */
export const USED_COMMENT_MARKER = '<!-- ia-flow:comment-used -->'

/** Marker de un comentario escrito por un agente vía `ITaskSource.postComment`
 *  — el cierre de un run (`complete_task`/`fail_task`/texto final) o un hito
 *  parcial (`add_task_comment`). Es el handoff del pipeline: SÍ se muestra. */
export const SYSTEM_COMMENT_MARKER = '<!-- ia-flow:system-comment -->'

/** Marker de `ITaskSource.postError` — el stack trace crudo. Nunca se muestra:
 *  siempre viene acompañado del `fail_task` que dice lo mismo en legible, y
 *  repetirlo en cada prompt es puro ruido. */
export const ERROR_COMMENT_MARKER = '<!-- ia-flow:agent-error -->'

/** Cualquier marker del engine. Un body que lo contiene no es feedback humano. */
export const IA_FLOW_MARKER_PREFIX = '<!-- ia-flow:'

export interface WindowableComment {
  body: string
}

/**
 * ¿Este comentario lo escribió `agentId`?
 *
 * Dos señales, ambas necesarias: el marker de `postComment` (lo escribió el
 * engine, no un humano) y el encabezado `# <agentId>` con el que los
 * formatters abren todo comentario de agente — opcionalmente seguido de
 * ` · <headline>` (`· ❌ falló`, `· 🟡 pausado`, el headline de
 * `add_task_comment`).
 *
 * El match del id es exacto contra el primer segmento para que un agente
 * `e2e-tester` no se reconozca en los comentarios de `e2e-tester-mac`.
 */
export function isCommentByAgent(body: string, agentId: string): boolean {
  if (!body.includes(SYSTEM_COMMENT_MARKER)) return false
  const firstLine = body.split('\n', 1)[0]?.trim() ?? ''
  if (!firstLine.startsWith('# ')) return false
  const header = firstLine.slice(2).trim()
  // `·` separa el id del headline; sin él, el encabezado ES el id pelado.
  const idPart = header.split('·', 1)[0]?.trim() ?? ''
  return idPart === agentId
}

/**
 * Los comentarios posteriores al último que escribió `agentId`.
 *
 * `comments` viene en orden cronológico (oldest→newest), que es como lo
 * devuelven los sources y como lo renderiza `formatComments`.
 *
 * **Sin comentario propio devuelve la lista entera**, no vacía: significa "este
 * agente nunca corrió sobre este issue", y ahí el contexto completo es
 * exactamente lo que hace falta. Fallar hacia una ventana más ANCHA es
 * deliberado — de más cuesta tokens, de menos cuesta que un agente no se entere
 * de por qué lo despertaron, que es el bug que esto arregla.
 */
export function selectCommentWindow<T extends WindowableComment>(
  comments: readonly T[],
  agentId: string,
): T[] {
  let boundary = -1
  for (let i = comments.length - 1; i >= 0; i--) {
    if (isCommentByAgent(comments[i].body, agentId)) {
      boundary = i
      break
    }
  }
  return comments.slice(boundary + 1)
}

/** Lo mínimo que `renderConversationWindow` necesita de un comentario para
 *  describir de dónde salió — el resto de `TaskComment` (id, threadId) no
 *  aporta nada a un texto que un modelo va a leer una vez y descartar. */
export interface RenderableComment extends WindowableComment {
  created_at: string
  origin?: 'issue' | 'pr' | 'pr-review'
  prNumber?: number
  author?: string
  path?: string
  line?: number
}

// Topes del render. La ventana de un issue con varias vueltas de
// build→review→build llega a decenas de comentarios y ~41k chars; mandarlos
// enteros a un gate que puede correr en cada evento es caro y además empeora
// la decisión, porque entierra lo reciente. Se recorta por la cola: lo
// último es lo que motiva la evaluación.
const MAX_CONVERSATION_COMMENTS = 10
const MAX_CONVERSATION_CHARS = 4000

/**
 * La conversación que `agentId` todavía no vio, lista para el prompt de un
 * gate semántico (`whenText`).
 *
 * Usa la MISMA ventana que `Agent.run` le muestra al agente si termina
 * corriendo (`selectCommentWindow`, cortada contra su último comentario
 * propio) — que el gate juzgue exactamente lo que el agente va a leer es lo
 * que hace que un `whenText` sobre la conversación signifique algo: si viera
 * el historial completo podría activar por un comentario que el agente ya
 * atendió hace varias corridas.
 *
 * Pura: no hace I/O, sólo formatea lo que el caller ya cargó.
 */
export function renderConversationWindow<T extends RenderableComment>(
  comments: readonly T[],
  agentId: string,
): string {
  const unseen = selectCommentWindow(comments, agentId)
  if (!unseen.length) return ''

  const text = unseen
    .slice(-MAX_CONVERSATION_COMMENTS)
    .map((c) => {
      const where =
        c.origin === 'pr-review'
          ? `PR #${c.prNumber ?? '?'} · review${c.path ? ` · ${c.path}${c.line ? `:${c.line}` : ''}` : ''}`
          : c.origin === 'pr'
            ? `PR #${c.prNumber ?? '?'}`
            : 'issue'
      const who = c.author ? ` · ${c.author}` : ''
      return `[${c.created_at} · ${where}${who}]\n${c.body.trim()}`
    })
    .join('\n\n')

  // Recorta por el principio: el final es lo reciente.
  return text.length > MAX_CONVERSATION_CHARS ? `…\n${text.slice(-MAX_CONVERSATION_CHARS)}` : text
}
