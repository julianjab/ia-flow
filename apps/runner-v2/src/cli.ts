/**
 * Los argumentos del runner. La CLI no arma eventos: o arranca y valida, o levanta el servidor, o
 * mete un webhook CRUDO por el mismo camino que el servidor (`--event`, `--replay-pr`, `--issue`).
 */

export interface RunnerArgs {
  /** El `runner.yaml` a correr, o la carpeta que lo tiene (argv `--config`, o RUNNER_CONFIG). */
  config?: string
  /** Levanta el servidor de webhooks. */
  serve: boolean
  /** Le presta su CLI `claude` a un runner: se suscribe y pide tareas (`@ia-flow/provider-remote`). */
  host: boolean
  /** Un webhook crudo: `github.<evento>` y el archivo JSON con su payload. */
  event?: { type: string; payloadPath: string }
  /** `owner/repo#n` de un PR real: entra como un `pull_request` `opened`, igual que el webhook. */
  replayPr?: string
  /** Un issue real y lo que se simula que le pasó: su card llegó a `status`, o le pusieron
   *  `label`. Entra como el webhook que GitHub mandaría, por el intake (`--issue`). */
  issue?: IssueSimulation
}

/** `--issue <ref>` con `--status <columna>` o `--label <nombre>` (uno de los dos). */
export interface IssueSimulation {
  ref: string
  change: { status: string } | { label: string }
  /** El `login` que figura como quien lo hizo (`sender`). Default `ia-flow-cli`. */
  as: string
}

export const USAGE = `uso: bun run src/main.ts [--config <runner.yaml|dir>]
     bun run src/main.ts [--config <runner.yaml|dir>] --serve
     bun run src/main.ts [--config <runner.yaml|dir>] --host
     bun run src/main.ts [--config <runner.yaml|dir>] --event github.<evento> <payload.json>
     bun run src/main.ts [--config <runner.yaml|dir>] --replay-pr <owner>/<repo>#<n>
     bun run src/main.ts [--config <runner.yaml|dir>] --issue <owner>/<repo>#<n>
                         (--status <columna> | --label <nombre>) [--as <login>]

  Sin nada: carga la definición, valida todo y monta el engine.
  --serve                escucha webhooks de GitHub en POST /api/webhooks/github (puerto
                         settings.port / IA_FLOW_SERVER_PORT, default 3001; secreto
                         IA_FLOW_WEBHOOK_SECRET)
  --host                 le presta su CLI \`claude\` a un runner (\`remote:<name>\` del otro lado):
                         \`host:\` de runner.yaml, se suscribe a /v1/hosts del runner con
                         IA_FLOW_HOST_TOKEN — sólo conexiones de salida
  --event <tipo> <json>  despacha un webhook crudo (\`github.pull_request\`, …) con el payload del
                         archivo — el mismo camino que un delivery
  --replay-pr <pr>       lee ese PR de GitHub y lo despacha como un \`pull_request\` \`opened\`
  --issue <ref>          simula algo sobre ese issue real y lo despacha como el webhook que GitHub
                         mandaría, por el intake: corre lo que correría en producción
    --status <columna>   su card llegó a esa columna (ej. Review: el gate completo)
    --label <nombre>     le pusieron ese label (ej. e2e-test: el e2e a pedido, con la card en
                         Review). No lo pone en GitHub: sólo lo simula
    --as <login>         quién figura como autor (default ia-flow-cli)
                         Ojo: los agentes escriben de verdad (comentarios, la card, Slack)
  --config <yaml|dir>    el runner.yaml a correr (p. ej. runner.local.yaml), o la carpeta que
                         tiene un runner.yaml (default: RUNNER_CONFIG, RUNNER_CONFIG_DIR o
                         apps/runner-v2/.config)`

/**
 * El issue o PR, en cualquiera de las formas que se copian a mano: `la-haus/eks#9575`,
 * `la-haus/eks/#9575`, `https://github.com/la-haus/eks/issues/9575` o `…/pull/9575`.
 */
export function parseIssueTarget(
  target: string,
): { owner: string; repo: string; number: number } | undefined {
  const cleaned = target.trim().replace(/^https?:\/\/github\.com\//, '')
  const match =
    cleaned.match(/^([^/\s]+)\/([^/#\s]+)\/?#(\d+)$/) ??
    cleaned.match(/^([^/\s]+)\/([^/#\s]+)\/(?:issues|pull)\/(\d+)\/?$/)
  if (!match?.[1] || !match[2] || !match[3]) return undefined
  return { owner: match[1], repo: match[2], number: Number(match[3]) }
}

export function parseArgs(argv: string[]): RunnerArgs {
  const args: RunnerArgs = { serve: false, host: false }
  let issueRef: string | undefined
  let status: string | undefined
  let label: string | undefined
  let as: string | undefined
  const value = (i: number, missing: string) => {
    const found = argv[i]
    if (!found || found.startsWith('--')) throw new Error(`${missing}\n\n${USAGE}`)
    return found
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--serve') args.serve = true
    else if (arg === '--host') args.host = true
    else if (arg === '--config')
      args.config = value(++i, '--config necesita un runner.yaml o su carpeta')
    else if (arg === '--replay-pr')
      args.replayPr = value(++i, '--replay-pr necesita <owner>/<repo>#<n>')
    else if (arg === '--event') {
      const type = value(++i, '--event necesita github.<evento> y un archivo JSON')
      const payloadPath = value(++i, '--event necesita el archivo JSON del payload')
      if (!type.startsWith('github.'))
        throw new Error(`--event espera github.<evento>, no "${type}"\n\n${USAGE}`)
      args.event = { type, payloadPath }
    } else if (arg === '--issue') issueRef = value(++i, '--issue necesita <owner>/<repo>#<n>')
    else if (arg === '--status') status = value(++i, '--status necesita el nombre de la columna')
    else if (arg === '--label') label = value(++i, '--label necesita el nombre del label')
    else if (arg === '--as') as = value(++i, '--as necesita un login')
    else throw new Error(`argumento desconocido: ${arg}\n\n${USAGE}`)
  }
  args.issue = issueSimulation(issueRef, status, label, as)
  const modes = [
    args.serve,
    args.host,
    args.event !== undefined,
    args.replayPr !== undefined,
    args.issue !== undefined,
  ].filter(Boolean)
  if (modes.length > 1) {
    throw new Error(`--serve, --host, --event, --replay-pr y --issue van de a uno\n\n${USAGE}`)
  }
  if (!args.issue) delete args.issue
  return args
}

/** `--issue` con exactamente uno de `--status`/`--label`; ellos (y `--as`) sin `--issue`, no. */
function issueSimulation(
  ref: string | undefined,
  status: string | undefined,
  label: string | undefined,
  as: string | undefined,
): IssueSimulation | undefined {
  if (!ref) {
    if (status !== undefined || label !== undefined || as !== undefined) {
      throw new Error(`--status, --label y --as van con --issue\n\n${USAGE}`)
    }
    return undefined
  }
  if (!parseIssueTarget(ref))
    throw new Error(`--issue: "${ref}" no es <owner>/<repo>#<n>\n\n${USAGE}`)
  if ((status === undefined) === (label === undefined)) {
    throw new Error(
      `--issue necesita --status <columna> o --label <nombre> (uno de los dos)\n\n${USAGE}`,
    )
  }
  return {
    ref,
    change: status !== undefined ? { status } : { label: label as string },
    as: as ?? 'ia-flow-cli',
  }
}
