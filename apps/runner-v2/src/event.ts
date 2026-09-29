/**
 * Arma el evento que dispara el runner, con la forma que esperan las reglas y los prompts de
 * claw-agents: `item.*` (los filtros de las reglas), `task.*` y `event.payload.*` (las variables
 * de los prompts y briefs), más los campos propios de cada tipo de evento.
 */
import type { GithubClient } from '@ia-tools/github-api'

export interface EventArgs {
  eventType: string
  owner: string
  repo: string
  number: number
  status?: string
  type: string
  labels: string[]
  comment?: string
  author: string
  commentId: number
  pr?: number
  sets: Array<[string, string]>
  /** Campos propios del evento que no tienen flag (`from`/`to`, `state`, `conclusion`, …): los
   *  aporta el traductor de webhooks, se mezclan al payload ANTES de los `--set`. */
  extra?: Record<string, unknown>
  /** Lo que se mezcla en `task.*` además de lo que sale del issue (`comments`, `ci`, `pr`): lo
   *  arma el intake (`taskPayload`, `intake/task.ts`); la CLI no lo trae. */
  taskExtra?: Record<string, unknown>
  /** Lo que se mezcla en `item.*` (lo que filtran las reglas): p. ej. `blocked`, del intake. */
  itemExtra?: Record<string, unknown>
}

export interface RunnerArgs {
  /** La carpeta de la definición (argv `--config`, o RUNNER_CONFIG_DIR). Default: `.config`. */
  configDir?: string
  dryRun: boolean
  live: boolean
  /** Levanta el servidor de webhooks en vez de despachar un evento de la CLI. */
  serve: boolean
  /** `owner/repo#n` de un PR real: lo mete al intake como un `pull_request` `opened`, igual que
   *  lo haría el webhook — para probar el reviewer sin túnel. */
  replayPr?: string
  /** Sin evento, el runner sólo arranca: carga, valida y monta el engine. */
  event?: EventArgs
}

export const USAGE = `uso: bun run src/main.ts [--config <dir>] [--dry-run] [--live]
         [<evento> <owner>/<repo>#<n> [opciones del evento]]
     bun run src/main.ts [--config <dir>] [--live] --serve
     bun run src/main.ts [--config <dir>] [--live] --replay-pr <owner>/<repo>#<n>

  Sin evento: carga la definición, valida todo y monta el engine.
  --serve                escucha webhooks de GitHub en POST /api/webhooks/github (puerto
                         settings.port / IA_FLOW_SERVER_PORT, default 3001; secreto
                         IA_FLOW_WEBHOOK_SECRET; paralelismo executions.maxConcurrent de engine.yaml)
  --replay-pr <pr>       lee ese PR de GitHub y lo despacha por el intake como un
                         \`pull_request\` \`opened\` — el mismo camino que el webhook, sin túnel
  --config <dir>         la carpeta de la definición: engine.yaml, runner.yaml y projects/
                         (default: RUNNER_CONFIG_DIR o apps/runner-v2/.config)

eventos: issue.created | issue.status_changed | projects_v2_item.edited | issue_comment |
         pull_request | pull_request_review | check_suite | workflow_run

opciones:
  --status <columna>     item.status del issue (Refine, Refined, Build, Review, ...)
  --type <tipo>          item.type: technical (default) | functional
  --label <label>        repetible — labels del issue (default: las reales del issue)
  --comment <texto>      body de un issue_comment (action=created)
  --author <login>       autor del comentario (default: tester)
  --comment-id <n>       id del comentario (default: 1)
  --pr <n>               número de PR (pr.number / prNumber)
  --set <campo=valor>    cualquier otro campo del payload, con path punteado (repetible)
  --dry-run              sólo resolver: qué reglas matchean y sus rutas efectivas — no llama al modelo
  --live                 escrituras REALES a GitHub (sin esto, se simulan e imprimen)

ejemplos:
  ... issue_comment la-haus/subscriptions#123 --status Refine --comment "falta paginar" --dry-run
  ... issue.status_changed la-haus/subscriptions#123 --status Build --set to=Build --set from=Refined`

/** Los flags del runner sin valor. */
const RUNNER_SWITCHES: Record<string, (runner: RunnerArgs) => void> = {
  '--dry-run': (runner) => {
    runner.dryRun = true
  },
  '--live': (runner) => {
    runner.live = true
  },
  '--serve': (runner) => {
    runner.serve = true
  },
}

/** Los flags del runner con valor, y qué decir si falta. */
const RUNNER_OPTIONS: Record<
  string,
  { missing: string; apply: (runner: RunnerArgs, value: string) => void }
> = {
  '--config': {
    missing: '--config necesita una carpeta',
    apply: (runner, value) => {
      runner.configDir = value
    },
  },
  '--replay-pr': {
    missing: '--replay-pr necesita <owner>/<repo>#<n>',
    apply: (runner, value) => {
      runner.replayPr = value
    },
  },
}

export function parseArgs(argv: string[]): RunnerArgs {
  const runner: RunnerArgs = { dryRun: false, live: false, serve: false }
  const positional: string[] = []
  const eventFlags: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    const option = RUNNER_OPTIONS[arg]
    if (option) {
      const value = argv[++i]
      if (!value) throw new Error(`${option.missing}\n\n${USAGE}`)
      option.apply(runner, value)
    } else if (RUNNER_SWITCHES[arg]) RUNNER_SWITCHES[arg](runner)
    else if (arg.startsWith('--')) eventFlags.push(arg, argv[++i] as string)
    else positional.push(arg)
  }
  if (positional.length === 0 && eventFlags.length === 0) return runner
  if (runner.serve)
    throw new Error(`--serve no lleva evento: los eventos llegan por webhook\n\n${USAGE}`)
  runner.event = parseEvent(positional, eventFlags)
  return runner
}

function parseEvent(positional: string[], rest: string[]): EventArgs {
  const [eventType, target] = positional
  const match = target ? parseIssueTarget(target) : undefined
  if (!eventType || !match) throw new Error(USAGE)

  const args: EventArgs = {
    eventType,
    owner: match.owner,
    repo: match.repo,
    number: match.number,
    type: 'technical',
    labels: [],
    author: 'tester',
    commentId: 1,
    sets: [],
  }
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i] as string
    const apply = EVENT_OPTIONS[flag]
    if (!apply) throw new Error(`opción desconocida: ${flag}\n\n${USAGE}`)
    const value = rest[++i]
    if (value === undefined) throw new Error(`${flag} necesita un valor\n\n${USAGE}`)
    apply(args, value)
  }
  return args
}

/** Las opciones de un evento armado en la CLI: cada una pisa su campo. */
const EVENT_OPTIONS: Record<string, (args: EventArgs, value: string) => void> = {
  '--status': (args, value) => {
    args.status = value
  },
  '--type': (args, value) => {
    args.type = value
  },
  '--label': (args, value) => {
    args.labels.push(value)
  },
  '--comment': (args, value) => {
    args.comment = value
  },
  '--author': (args, value) => {
    args.author = value
  },
  '--comment-id': (args, value) => {
    args.commentId = Number(value)
  },
  '--pr': (args, value) => {
    args.pr = Number(value)
  },
  '--set': (args, value) => {
    const [path, ...parts] = value.split('=')
    if (!path || parts.length === 0) throw new Error(`--set espera campo=valor\n\n${USAGE}`)
    args.sets.push([path, parts.join('=')])
  },
}

function literal(value: string): unknown {
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?\d+$/.test(value)) return Number(value)
  return value
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.')
  let node = target
  for (const key of keys.slice(0, -1)) {
    if (typeof node[key] !== 'object' || node[key] === null) node[key] = {}
    node = node[key] as Record<string, unknown>
  }
  node[keys[keys.length - 1] as string] = value
}

export interface IssueData {
  title: string
  body: string
  url: string
  labels: string[]
}

/**
 * El issue del evento, en cualquiera de las formas que se copian a mano:
 * `la-haus/eks#9575`, `la-haus/eks/#9575` o `https://github.com/la-haus/eks/issues/9575`.
 */
export function parseIssueTarget(
  target: string,
): { owner: string; repo: string; number: number } | undefined {
  const cleaned = target.trim().replace(/^https?:\/\/github\.com\//, '')
  const match =
    cleaned.match(/^([^/\s]+)\/([^/#\s]+)\/?#(\d+)$/) ??
    cleaned.match(/^([^/\s]+)\/([^/#\s]+)\/issues\/(\d+)\/?$/)
  if (!match?.[1] || !match[2] || !match[3]) return undefined
  return { owner: match[1], repo: match[2], number: Number(match[3]) }
}

/** Ante un 404, distingue "no existe" de "la instalación de la App no ve el repo" — GitHub
 *  responde 404, no 403, para un repo privado fuera de la instalación. */
async function explainNotFound(client: GithubClient, args: EventArgs): Promise<string> {
  const full = `${args.owner}/${args.repo}`
  try {
    const visible: string[] = []
    for (let page = 1; page <= 20; page++) {
      const data = await client.requestJson<{ repositories: Array<{ full_name: string }> }>(
        `/installation/repositories?per_page=100&page=${page}`,
      )
      visible.push(...data.repositories.map((repo) => repo.full_name.toLowerCase()))
      if (data.repositories.length < 100) break
    }
    return visible.includes(full.toLowerCase())
      ? `la instalación ve ${full}, así que el issue #${args.number} no existe ahí`
      : `la instalación de la GitHub App NO tiene acceso a ${full} (ve ${visible.length} repos) — agregalo a la instalación, o usá IA_FLOW_GITHUB_AUTH_MODE=static con un token que lo vea`
  } catch {
    // Con un token personal `/installation/repositories` no existe: sin diagnóstico extra.
    return `o el issue no existe, o la identidad del runner no ve ${full}`
  }
}

async function fetchIssue(client: GithubClient | undefined, args: EventArgs): Promise<IssueData> {
  if (!client) {
    return {
      title: `(dry-run) ${args.owner}/${args.repo}#${args.number}`,
      body: '(dry-run: el issue no se lee)',
      url: `https://github.com/${args.owner}/${args.repo}/issues/${args.number}`,
      labels: [],
    }
  }
  let issue: {
    title: string
    body: string | null
    html_url: string
    labels: Array<{ name: string } | string>
  }
  try {
    issue = await client.requestJson(`/repos/${args.owner}/${args.repo}/issues/${args.number}`)
  } catch (err) {
    if (!(err as Error).message.includes('→ 404')) throw err
    throw new Error(
      `No se encontró ${args.owner}/${args.repo}#${args.number}: ${await explainNotFound(client, args)}`,
    )
  }
  return {
    title: issue.title,
    body: issue.body ?? '',
    url: issue.html_url,
    labels: issue.labels.map((label) => (typeof label === 'string' ? label : label.name)),
  }
}

/** El prefijo de rama de ia-flow: `task.branch` = `ia-flow/<número>`. */
export const DEFAULT_BRANCH_PREFIX = 'ia-flow/'

export async function buildPayload(
  args: EventArgs,
  client: GithubClient | undefined,
  project: {
    /** `{{project.repos}}` de los prompts: el catálogo de repos del proyecto, en texto. */
    repos: string
    branchPrefix: string
  },
): Promise<Record<string, unknown>> {
  return assemblePayload(args, await fetchIssue(client, args), project)
}

/** El payload de `args` sobre un issue ya leído — lo que comparten la CLI (`buildPayload`) y el
 *  intake (`task_payload`). */
export function assemblePayload(
  args: EventArgs,
  issue: IssueData,
  project: {
    /** `{{project.repos}}` de los prompts: el catálogo de repos del proyecto, en texto. */
    repos: string
    branchPrefix: string
  },
): Record<string, unknown> {
  const labels = args.labels.length > 0 ? args.labels : issue.labels
  const payload: Record<string, unknown> = {
    // Qué evento es: lo que miran los `when` de los pasos de una pipeline que escucha varios.
    eventType: args.eventType,
    owner: args.owner,
    repo: args.repo,
    number: args.number,
    issueNumber: args.number,
    repos: [args.repo],
    task_type: args.type,
    item: { status: args.status, type: args.type, repos: [args.repo], labels, ...args.itemExtra },
    project: { repos: project.repos },
    task: {
      id: `${args.owner}/${args.repo}#${args.number}`,
      title: issue.title,
      description: issue.body,
      issueUrl: issue.url,
      repos: args.repo,
      repo: { name: args.repo },
      branch: `${project.branchPrefix}${args.number}`,
      comments: '',
      ...(args.pr
        ? {
            pr: {
              number: args.pr,
              url: `https://github.com/${args.owner}/${args.repo}/pull/${args.pr}`,
            },
          }
        : {}),
      ...args.taskExtra,
    },
  }
  if (args.comment !== undefined) {
    Object.assign(payload, {
      action: 'created',
      body: args.comment,
      author: args.author,
      commentId: args.commentId,
    })
  }
  if (args.pr) Object.assign(payload, { pr: { number: args.pr }, prNumber: args.pr })
  if (args.extra) Object.assign(payload, args.extra)
  for (const [path, value] of args.sets) setPath(payload, path, literal(value))

  // `{{event.payload.x}}` en los briefs: el payload se ve a sí mismo bajo `event.payload`.
  return { ...payload, event: { payload: { ...payload } } }
}
