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

  // ─── GitHub — issues y el board ──────────────────────────────────────────
  // El tipo es `<evento>.<action>` tal cual GitHub los manda — no una
  // taxonomía curada aparte. Éstas son las acciones más comunes; cualquier
  // otra (`issue_comment.deleted`, `issues.assigned`, …) se publica igual con
  // el mismo prefijo, aunque no esté listada acá (el catálogo es sólo para
  // autocomplete, no autoritativo).
  {
    type: 'issue_comment.created',
    description:
      'Comentario nuevo en un issue de GitHub. NO trae `item` — es el payload crudo del webhook de GitHub, sin status/labels resueltos. Para condicionar por eso, usá `issue.status_changed`/`issue.created` (los que sí resuelven `item`, vía el re-scan).',
    source: 'github',
    fields: ['action', 'body', 'author', 'commentUrl', 'issueNumber'],
  },
  {
    type: 'issues.opened',
    description:
      'Cambio en un issue de GitHub (abierto, cerrado, etc). `labelName`/`assignee` sólo vienen en labeled/unlabeled/assigned/unassigned. NO trae `item`: un `when` sobre `item.status`/`item.labels` acá nunca matchea — issuesEvent() (apps/server/src/adapters/github/webhook-events.ts) no lo resuelve. Para eso usá `issue.status_changed`/`issue.created`.',
    source: 'github',
    fields: ['action', 'issueNumber', 'title', 'state', 'labelName', 'assignee'],
  },
  {
    type: 'projects_v2_item.edited',
    description:
      'Un item del board de GitHub Projects cambió. GitHub avisa QUÉ campo, nunca a qué valor. NO trae `item` resuelto tampoco acá (projectItemEvent() sólo publica `itemId`/`fieldName`/`fieldType`) — para el valor actual hay que resolverlo aparte (`getItemById`) o esperar el `issue.status_changed`/`issue.created` que el re-scan dispara para el mismo delivery.',
    source: 'github',
    fields: ['action', 'itemId', 'fieldName', 'fieldType'],
  },
  {
    type: 'projects_v2.edited',
    description: 'Cambió la configuración del proyecto de GitHub Projects en sí (no un item).',
    source: 'github',
    fields: ['action'],
  },

  // ─── Pull requests ───────────────────────────────────────────────────────
  {
    type: 'pr.opened',
    description: 'Se abrió o se reabrió un pull request.',
    source: 'github',
    fields: [
      'action',
      'pr.number',
      'pr.title',
      'pr.state',
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
    type: 'pr.synchronize',
    description: 'Llegaron commits nuevos a un pull request abierto.',
    source: 'github',
    fields: ['action', 'pr.number', 'pr.head.ref', 'pr.head.sha', 'pr.author'],
  },
  {
    type: 'pr.ready_for_review',
    description: 'Un pull request salió de draft.',
    source: 'github',
    fields: ['action', 'pr.number', 'pr.title', 'pr.author'],
  },
  {
    type: 'pr.merged',
    description: 'Se mergeó un pull request.',
    source: 'github',
    fields: ['action', 'pr.number', 'pr.title', 'pr.base.ref', 'pr.author'],
  },
  {
    type: 'pr.closed',
    description: 'Se cerró un pull request SIN mergear.',
    source: 'github',
    fields: ['action', 'pr.number', 'pr.title', 'pr.author'],
  },
  {
    type: 'pr.review_submitted',
    description: 'Alguien dejó una review en un pull request.',
    source: 'github',
    fields: ['state', 'reviewer', 'body', 'pr.number', 'pr.author'],
  },

  // ─── CI ──────────────────────────────────────────────────────────────────
  {
    type: 'ci.finished',
    description: 'Terminó el CI de un commit. Unifica check_suite y workflow_run.',
    source: 'github',
    fields: ['conclusion', 'status', 'name', 'branch', 'sha', 'url', 'kind', 'prNumber'],
  },

  // ─── Slack ───────────────────────────────────────────────────────────────
  {
    type: 'slack.message',
    description:
      'Un mensaje en un canal o hilo. Entra SIN proyecto: sólo lo ven las reglas globales.',
    source: 'slack',
    fields: ['text', 'channel', 'author', 'ts', 'threadTs', 'isThreadReply'],
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
