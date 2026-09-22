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

export interface EventTypeDef {
  type: string
  /** Qué pasó, en una línea, en el idioma del operador. */
  description: string
  /** De dónde viene. Agrupa el listado. */
  source: 'github' | 'slack' | 'engine' | 'cron' | 'rule'
  /** Claves del payload que una condición `when` puede usar. Los caminos
   *  anidados se escriben con punto, igual que en el DSL. */
  fields: string[]
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
    source: 'engine',
    fields: ['from', 'to', ...ISSUE_FIELDS, 'item'],
  },
  {
    type: 'issue.created',
    description: 'El scan vio este issue por primera vez.',
    source: 'engine',
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
      'Comentario en un issue de GitHub — `action` distingue created/edited/deleted. NO trae `item` — es el payload crudo del webhook, sin status/labels resueltos. Para condicionar por eso, usá `issue.status_changed`/`issue.created` (los que sí resuelven `item`, vía el re-scan).',
    source: 'github',
    fields: ['action', 'body', 'author', 'commentUrl', 'commentId', 'issueNumber'],
  },
  {
    type: 'issues',
    description:
      'Cambio en un issue de GitHub — `action` distingue opened/closed/labeled/assigned/edited/… `labelName`/`assignee` sólo vienen en labeled/unlabeled/assigned/unassigned. NO trae `item`: un `when` sobre `item.status`/`item.labels` acá nunca matchea — issuesEvent() no lo resuelve. Para eso usá `issue.status_changed`/`issue.created`.',
    source: 'github',
    fields: ['action', 'issueNumber', 'title', 'state', 'labelName', 'assignee', 'labels'],
  },
  {
    type: 'projects_v2_item',
    description:
      'Un item del board de GitHub Projects cambió — `action` distingue edited/created/deleted/archived/… GitHub avisa QUÉ campo cambió, nunca a qué valor. NO trae `item` resuelto tampoco acá (sólo `itemId`/`fieldName`/`fieldType`) — para el valor actual hay que resolverlo aparte o esperar el `issue.status_changed`/`issue.created` que el re-scan dispara para el mismo delivery.',
    source: 'github',
    fields: ['action', 'itemId', 'fieldName', 'fieldType'],
  },
  {
    type: 'projects_v2',
    description: 'Cambió la configuración del proyecto de GitHub Projects en sí (no un item).',
    source: 'github',
    fields: ['action'],
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
  },
  {
    type: 'pull_request_review',
    description:
      'Alguien interactuó con una review de un pull request — `action` distingue submitted/edited/dismissed. `state`/`reviewer`/`body` sólo tienen sentido cuando `action = submitted`.',
    source: 'github',
    fields: ['action', 'state', 'reviewer', 'body', 'pr.number', 'pr.author'],
  },

  // ─── CI ──────────────────────────────────────────────────────────────────
  {
    type: 'check_suite',
    description:
      'El check suite de un commit cambió de estado — `action` distingue requested/in_progress/completed. `conclusion` sólo tiene sentido cuando `action = completed`.',
    source: 'github',
    fields: ['action', 'conclusion', 'status', 'name', 'branch', 'sha', 'url', 'prNumber'],
  },
  {
    type: 'workflow_run',
    description:
      'Un workflow run de GitHub Actions cambió de estado — `action` distingue requested/in_progress/completed. Mismo hecho que `check_suite` para "terminó el CI"; una regla que no distingue el mecanismo escucha `on: [check_suite, workflow_run]`.',
    source: 'github',
    fields: ['action', 'conclusion', 'status', 'name', 'branch', 'sha', 'url', 'prNumber'],
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
