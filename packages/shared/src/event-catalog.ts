// El vocabulario de eventos del engine, en UN lugar.
//
// Antes los 13 tipos vivían como constantes sueltas en cinco archivos
// (`shared/events.ts`, `shared/waits.ts`, `rules/status-diff.ts`,
// `rules/schedule.ts`, `adapters/github`, `@ia-flow/slack`), así que nada podía
// listarlos: ni el autocomplete del editor, ni una validación que avise "ese
// evento no lo emite nadie", ni la documentación.
//
// **El catálogo es descripción, no autoridad.** Publicar un tipo que no está
// acá sigue siendo válido —el bus no consulta esta lista— y tiene que seguir
// siéndolo: un agent-host de otra versión, o un `emit` con un tipo propio del
// operador, son casos legítimos. Por eso el autocomplete sugiere estos y acepta
// cualquier cosa.
//
// `fields` es lo que más se usa: son las claves que una condición `when` puede
// evaluar, y hoy hay que adivinarlas leyendo el código del normalizador.
//
// ─── El universo de eventos de GitHub, y qué parte usamos ────────────────
//
// GitHub manda ~70 tipos de webhook (`X-GitHub-Event`); `routes/webhooks.ts`
// sólo deja pasar 8 al bus (`BUS_EVENTS` en `adapters/github/
// webhook-events.ts`): `issues`, `issue_comment`, `pull_request`,
// `pull_request_review`, `check_suite`, `workflow_run`, `projects_v2_item`,
// `projects_v2`. El resto se descarta en el borde HTTP con `200
// {ignored:true}` — ni scan ni bus, cero costo. Son los ocho que describen el
// ciclo de vida de un issue/PR sobre un board de Projects, que es lo único
// que este pipeline orquesta. La lista de `actions` de cada uno abajo sale
// de https://docs.github.com/en/webhooks/webhook-events-and-payloads,
// verificada evento por evento (no son ejemplos: son el set completo que
// GitHub documenta a esta fecha).
//
// Deliberadamente AFUERA, evaluados y descartados:
//   - `pull_request_review_comment` — el comentario línea-por-línea DENTRO de
//     una review (`pull_request_review` sólo cubre el veredicto de la review
//     como un todo). Hoy ese contenido se lee vía GraphQL, perezoso, cuando
//     un agente vuelve a correr (`loadComments`,
//     `github-shared/conversation.ts`) — no hay push de "llegó un comentario
//     de review nuevo". Es el candidato más claro a sumar si se necesita
//     reaccionar más rápido que "la próxima vez que el agente mire".
//   - `check_run` — granularidad de un check individual dentro de un
//     `check_suite`; `ci.finished`/`check_suite` ya alcanza para "el CI de
//     este commit terminó", que es todo lo que una regla necesita hoy.
//   - `push` — commits nuevos en cualquier branch, no sólo la de una task.
//     Podría servir para detectar "un humano pusheó a mano sobre la branch
//     del agente", pero ninguna regla lo pide todavía y es el evento de
//     mayor volumen de todo GitHub (cada push a cualquier branch de main
//     entra acá también) — abrirlo sin un filtro por branch antes sería
//     repetir el problema que motivó `ISSUE_EVENTS`/`BUS_EVENTS` (41 CI
//     deliveries por 2 minutos).
//   - `status` — el status API legacy de un commit, para CI que no usa
//     Actions. No aplica hoy: todo el CI de los repos de este pipeline corre
//     en Actions.
//   - `discussion`/`discussion_comment`, `release`, `deployment_status`,
//     `milestone`, `label`, `commit_comment`, y el resto (~55 eventos de
//     administración de org/marketplace/seguridad) — no describen nada que
//     el board de Projects o un PR necesiten para este pipeline.
//   - `projects_v2_status_update` — el post de "estado del proyecto" tipo
//     roadmap (verde/amarillo/rojo + narrativa), un campo del PROYECTO como
//     un todo. Distinto de `projects_v2_item` (que es por ITEM, lo que este
//     pipeline trackea). No hay caso de uso: nada en el pipeline resume
//     estado a nivel de proyecto entero.

export interface EventTypeDef {
  type: string
  /** Qué pasó, en una línea, en el idioma del operador. */
  description: string
  /** De dónde viene. Agrupa el listado — `polling` son los dos eventos que
   *  produce el re-scan de la fuente (`issue.created`/`issue.status_changed`),
   *  separados de `engine` (el resto de los sintéticos: chat, esperas, el
   *  cierre de un run) porque uno lo dispara el ciclo de polling/webhook de
   *  una fuente y el otro no depende de ninguna fuente externa. */
  source: 'github' | 'polling' | 'slack' | 'engine' | 'cron' | 'rule'
  /** Claves del payload que una condición `when` puede usar. Los caminos
   *  anidados se escriben con punto, igual que en el DSL. */
  fields: string[]
  /** Sólo en `source: 'github'`. El set COMPLETO de valores que GitHub
   *  documenta para `payload.action` en este evento — no una muestra. Es lo
   *  que un `when: {field: 'action', op: '=', value: '…'}` puede distinguir;
   *  ver el bloque de arriba para la fuente. */
  actions?: string[]
  /** `true` cuando el mismo hecho se re-emite solo, sin que nada cambie. Hoy
   *  ningún evento del catálogo lo es — el scan sólo publica cuando algo
   *  cambió (`issue.created`/`issue.status_changed`) — pero el campo queda
   *  para el día que un productor nuevo sí lo necesite. */
  recurring?: boolean
}

const ISSUE_FIELDS = [
  'status',
  'title',
  'description',
  'type',
  'repos',
  'labels',
  'assignees',
  'issueNumber',
]

export const EVENT_CATALOG: EventTypeDef[] = [
  // ─── El scan de la fuente ────────────────────────────────────────────────
  {
    type: 'issue.status_changed',
    description: 'El issue cambió de status desde el scan anterior.',
    source: 'polling',
    fields: ['from', 'to', ...ISSUE_FIELDS, 'item'],
  },
  {
    type: 'issue.created',
    description: 'El scan vio este issue por primera vez.',
    source: 'polling',
    fields: ['status', ...ISSUE_FIELDS, 'item'],
  },

  // ─── GitHub — nombres crudos, sin taxonomía propia ──────────────────────
  // `type` es EXACTAMENTE el nombre de evento que manda GitHub
  // (`X-GitHub-Event`) — nunca `<evento>.<action>` ni una fusión de dos
  // eventos. Cada uno se publica para CUALQUIER `action`; `action` viaja en
  // el payload y es lo que un `when` usa para distinguir (`{field: 'action',
  // op: '=', value: 'edited'}`). Ver apps/server/src/adapters/github/
  // webhook-events.ts.
  {
    type: 'issue_comment',
    description:
      'Comentario en un issue de GitHub — `action` distingue created/edited/deleted/pinned/unpinned. NO trae `item` — es el payload crudo del webhook, sin status/labels resueltos. Para condicionar por eso, usá `issue.status_changed`/`issue.created` (los que sí resuelven `item`, vía el re-scan).',
    source: 'github',
    fields: ['action', 'body', 'author', 'commentUrl', 'commentId', 'issueNumber'],
    actions: ['created', 'deleted', 'edited', 'pinned', 'unpinned'],
  },
  {
    type: 'issues',
    description:
      'Cambio en un issue de GitHub — `action` distingue opened/closed/labeled/assigned/edited/… `labelName`/`assignee` sólo vienen en labeled/unlabeled/assigned/unassigned. NO trae `item`: un `when` sobre `item.status`/`item.labels` acá nunca matchea — issuesEvent() no lo resuelve. Para eso usá `issue.status_changed`/`issue.created`.',
    source: 'github',
    fields: ['action', 'issueNumber', 'title', 'state', 'labelName', 'assignee', 'labels'],
    actions: [
      'assigned',
      'closed',
      'deleted',
      'demilestoned',
      'edited',
      'field_added',
      'field_removed',
      'labeled',
      'locked',
      'milestoned',
      'opened',
      'pinned',
      'reopened',
      'transferred',
      'typed',
      'unassigned',
      'unlabeled',
      'unlocked',
      'unpinned',
      'untyped',
    ],
  },
  {
    type: 'projects_v2_item',
    description:
      'Un item del board de GitHub Projects cambió — `action` distingue edited/created/deleted/archived/… GitHub avisa QUÉ campo cambió, nunca a qué valor. NO trae `item` resuelto tampoco acá (sólo `itemId`/`fieldName`/`fieldType`) — para el valor actual hay que resolverlo aparte o esperar el `issue.status_changed`/`issue.created` que el re-scan dispara para el mismo delivery.',
    source: 'github',
    fields: ['action', 'itemId', 'fieldName', 'fieldType'],
    actions: ['archived', 'converted', 'created', 'deleted', 'edited', 'reordered', 'restored'],
  },
  {
    type: 'projects_v2',
    description: 'Cambió la configuración del proyecto de GitHub Projects en sí (no un item).',
    source: 'github',
    fields: ['action'],
    actions: ['closed', 'created', 'deleted', 'edited', 'reopened'],
  },

  // ─── Pull requests ───────────────────────────────────────────────────────
  {
    type: 'pull_request',
    description:
      'Cualquier cambio de estado de un pull request — `action` distingue opened/reopened/synchronize/ready_for_review/edited/closed/… Un `closed` mergeado vs sin mergear se distingue por `pr.merged`, no por el tipo.',
    source: 'github',
    fields: [
      'action',
      'pr.number',
      'pr.title',
      'pr.state',
      'pr.merged',
      'pr.isDraft',
      'pr.additions',
      'pr.deletions',
      'pr.changedFiles',
      'pr.author',
      'pr.head.ref',
      'pr.base.ref',
      'pr.url',
    ],
    actions: [
      'assigned',
      'auto_merge_disabled',
      'auto_merge_enabled',
      'closed',
      'converted_to_draft',
      'demilestoned',
      'dequeued',
      'edited',
      'enqueued',
      'labeled',
      'locked',
      'milestoned',
      'opened',
      'ready_for_review',
      'reopened',
      'review_request_removed',
      'review_requested',
      'stacked',
      'synchronize',
      'unassigned',
      'unlabeled',
      'unlocked',
    ],
  },
  {
    type: 'pull_request_review',
    description:
      'Alguien interactuó con una review de un pull request — `action` distingue submitted/edited/dismissed. `state`/`reviewer`/`body` sólo tienen sentido cuando `action = submitted`.',
    source: 'github',
    fields: ['action', 'state', 'reviewer', 'body', 'pr.number', 'pr.author'],
    actions: ['dismissed', 'edited', 'submitted'],
  },

  // ─── CI ──────────────────────────────────────────────────────────────────
  {
    type: 'check_suite',
    description:
      'El check suite de un commit cambió de estado — `action` distingue requested/in_progress/completed. `conclusion` sólo tiene sentido cuando `action = completed`. `kind` siempre es `check_suite`, útil sólo si la regla escucha los dos tipos a la vez.',
    source: 'github',
    fields: ['action', 'conclusion', 'status', 'name', 'branch', 'sha', 'url', 'prNumber', 'kind'],
    actions: ['completed', 'requested', 'rerequested'],
  },
  {
    type: 'workflow_run',
    description:
      'Un workflow run de GitHub Actions cambió de estado — `action` distingue requested/in_progress/completed. Mismo hecho que `check_suite` para "terminó el CI"; una regla que no distingue el mecanismo escucha `on: [check_suite, workflow_run]` y usa `kind` en el `when` si necesita separarlos.',
    source: 'github',
    fields: ['action', 'conclusion', 'status', 'name', 'branch', 'sha', 'url', 'prNumber', 'kind'],
    actions: ['completed', 'in_progress', 'requested'],
  },

  // ─── Slack ───────────────────────────────────────────────────────────────
  {
    type: 'slack.message',
    description:
      'Un mensaje en un canal o hilo. Entra SIN proyecto: sólo lo ven las reglas globales.',
    source: 'slack',
    fields: ['text', 'channel', 'author', 'ts', 'threadTs', 'isThreadReply'],
  },

  // ─── Asistente conversacional ────────────────────────────────────────────
  {
    type: 'chat.message',
    description:
      'Mensaje nuevo del bubble button de apps/web. Entra ya scopeado al proyecto reservado del chat — dispara al asistente vía la regla fija de base-agents.yaml.',
    source: 'engine',
    fields: ['sessionId', 'text'],
  },

  // ─── Esperas y mensajes ──────────────────────────────────────────────────
  {
    type: 'task.message',
    description: 'Se inyectó un mensaje en una tarea. Es lo que despierta una pausa.',
    source: 'engine',
    fields: ['body', 'author', 'messageId'],
  },
  {
    type: 'wait.expired',
    description: 'Una espera venció sin que llegara el evento que aguardaba.',
    source: 'engine',
    fields: ['waitId', 'agentId', 'taskId'],
  },
  {
    type: 'wait.resumed',
    description: 'Llegó el evento que una espera aguardaba y el run retoma.',
    source: 'engine',
    fields: ['waitId', 'agentId', 'taskId'],
  },

  // ─── Engine ──────────────────────────────────────────────────────────────
  {
    type: 'run.finished',
    description: 'Terminó el run de un agente. Lo emite la acción `agent` con `emitOn: exit`.',
    source: 'engine',
    fields: ['agentId', 'outcome', 'exit'],
  },
  {
    type: 'schedule.tick',
    description: 'El cron de una regla llegó a su horario.',
    source: 'cron',
    fields: ['ruleId', 'at'],
  },
]

const BY_TYPE = new Map(EVENT_CATALOG.map((e) => [e.type, e]))

export function describeEventType(type: string): EventTypeDef | undefined {
  return BY_TYPE.get(type)
}

/**
 * Las claves que una condición `when` puede evaluar, dados los tipos de evento
 * que una regla escucha.
 *
 * Union y no intersección: una regla sobre `pr.opened` + `ci.finished` puede
 * condicionar sobre campos de cualquiera de los dos —el matcher evalúa contra
 * el payload del evento que llegó— y ofrecer sólo la intersección escondería
 * campos perfectamente usables.
 */
export function fieldsForEventTypes(types: readonly string[]): string[] {
  const out = new Set<string>()
  for (const t of types) for (const f of BY_TYPE.get(t)?.fields ?? []) out.add(f)
  return [...out].sort()
}

/** Los tipos que se re-emiten solos. Una regla sobre uno de ellos sin ninguna
 *  condición se re-dispara sobre el mismo issue indefinidamente. */
export function isRecurringEventType(type: string): boolean {
  return BY_TYPE.get(type)?.recurring === true
}
