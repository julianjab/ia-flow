/**
 * Los argumentos del runner. La CLI no arma eventos: o arranca y valida, o levanta el servidor, o
 * mete un webhook CRUDO por el mismo camino que el servidor (`--event`, `--replay-pr`).
 */

export interface RunnerArgs {
  /** La carpeta de la definición (argv `--config`, o RUNNER_CONFIG_DIR). Default: `.config`. */
  configDir?: string
  /** Levanta el servidor de webhooks. */
  serve: boolean
  /** Le presta su CLI `claude` a un runner: se suscribe y pide tareas (`@ia-flow/provider-remote`). */
  host: boolean
  /** Un webhook crudo: `github.<evento>` y el archivo JSON con su payload. */
  event?: { type: string; payloadPath: string }
  /** `owner/repo#n` de un PR real: entra como un `pull_request` `opened`, igual que el webhook. */
  replayPr?: string
}

export const USAGE = `uso: bun run src/main.ts [--config <dir>]
     bun run src/main.ts [--config <dir>] --serve
     bun run src/main.ts [--config <dir>] --host
     bun run src/main.ts [--config <dir>] --event github.<evento> <payload.json>
     bun run src/main.ts [--config <dir>] --replay-pr <owner>/<repo>#<n>

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
  --config <dir>         la carpeta de runner.yaml (default: RUNNER_CONFIG_DIR o
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
  const value = (i: number, missing: string) => {
    const found = argv[i]
    if (!found || found.startsWith('--')) throw new Error(`${missing}\n\n${USAGE}`)
    return found
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--serve') args.serve = true
    else if (arg === '--host') args.host = true
    else if (arg === '--config') args.configDir = value(++i, '--config necesita una carpeta')
    else if (arg === '--replay-pr')
      args.replayPr = value(++i, '--replay-pr necesita <owner>/<repo>#<n>')
    else if (arg === '--event') {
      const type = value(++i, '--event necesita github.<evento> y un archivo JSON')
      const payloadPath = value(++i, '--event necesita el archivo JSON del payload')
      if (!type.startsWith('github.'))
        throw new Error(`--event espera github.<evento>, no "${type}"\n\n${USAGE}`)
      args.event = { type, payloadPath }
    } else throw new Error(`argumento desconocido: ${arg}\n\n${USAGE}`)
  }
  const modes = [
    args.serve,
    args.host,
    args.event !== undefined,
    args.replayPr !== undefined,
  ].filter(Boolean)
  if (modes.length > 1) {
    throw new Error(`--serve, --host, --event y --replay-pr van de a uno\n\n${USAGE}`)
  }
  return args
}
