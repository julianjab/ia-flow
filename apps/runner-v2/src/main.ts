/**
 * runner-v2 — el runner headless de ia-flow sobre `@ia-flow/agent-engine`. Lee `.config/`
 * (runner.yaml, las actions y las fuentes de cada scope), registra las actions, monta el engine y
 * levanta el servidor: no arma ni traduce eventos. Las ejecuciones viven en SQLite, así que una
 * pausa (esperar el CI) sobrevive a un reinicio.
 *
 * Modos:
 *   (nada)      verifica GitHub, resuelve MCP, carga y valida todo, y reporta. Todo es real:
 *               las actions escriben en GitHub y los agentes llaman a la Messages API.
 *   --serve     servidor de webhooks.
 *   --host      presta sus providers locales a otros runners (`type: remote` del otro lado).
 *   --event     un webhook crudo desde un archivo; --replay-pr, un PR real como `opened`.
 *
 *   bun run src/main.ts
 *   IA_FLOW_WEBHOOK_SECRET=... bun run src/main.ts --serve
 *   bun run src/main.ts --event github.issue_comment ./delivery.json
 *
 * Bun carga solo el `.env` del directorio desde el que corre (gitignoreado).
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createLogger } from '@ia-flow/telemetry'
import { type MountedRunner, mountRunner } from './boot.js'
import { parseArgs, parseIssueTarget, type RunnerArgs, USAGE } from './cli.js'
import { applyRunnerEnv, loadRunnerConfig, type RunnerConfig } from './config/RunnerConfig.js'
import { startHeartbeat } from './heartbeat.js'
import { mountInbox } from './inbox/mountInbox.js'
import { DEFAULT_HOST_PORT, type MountedHost, mountHost } from './providers/providerHost.js'
import { registerProviders } from './providers/providers.js'
import { dispatchRaw, replayPullRequest, serve } from './serve.js'
import { type ActivityStore, openActivityStore } from './storage/activityStore.js'
import { startTelemetry, type Telemetry, TraceRoute } from './telemetry.js'

/** Lo que el runner imprime también sale como log OTLP, con la traza activa y el scope del evento. */
const runnerLog = createLogger('ia-flow-runner-v2')

const DEFAULT_CONFIG_DIR = resolve(import.meta.dir, '../.config')

function expandHome(path: string): string {
  return path.startsWith('~') ? path.replace('~', process.env.HOME ?? '~') : path
}

function reportBoot(mounted: MountedRunner, env: ReturnType<typeof applyRunnerEnv>): void {
  console.log(`→ env: aplicado ${env.applied.join(', ') || '(nada)'}`)
  if (env.overriddenByEnv.length > 0) {
    console.log(`→ env: el ambiente pisa ${env.overriddenByEnv.join(', ')}`)
  }
  console.log(`→ github: ${mounted.githubAuthMode}`)
  console.log(`→ mcp: ${mounted.mcpServers.join(', ') || '(ninguno conectado)'}`)
  for (const project of mounted.projects) {
    console.log(
      `→ proyecto ${project.id}: board ${project.board.owner}#${project.board.number}, ${project.repos.length} repos`,
    )
  }
  for (const { id, source } of mounted.sources) {
    const actions = mounted.actions[id] ?? []
    console.log(
      `→ fuente ${id}: ${source.list().length} pipelines, ${actions.length} actions en su scope${actions.length > 0 ? ` (${actions.join(', ')})` : ''}`,
    )
  }
  if (mounted.executions) {
    const { running, waiting, paused } = mounted.executions.stats
    console.log(`→ ejecuciones: ${running} corriendo, ${waiting} esperando, ${paused} pausadas`)
  }
  for (const line of mounted.warnings) console.log(`→ aviso: ${line}`)
}

const VERSION = '0.1.0'

/** Un número positivo de un env var, o el default. */
function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

/** Cómo llegar a la traza de cada evento. */
function reportTraces(telemetry: Telemetry): void {
  if (!telemetry.endpoint) {
    console.log('→ telemetría apagada (OTEL_EXPORTER_OTLP_ENDPOINT)')
    return
  }
  for (const traceId of telemetry.traceIds) {
    console.log(`→ traza ${traceId}: Grafana → Explore → Tempo`)
  }
}

/** El servidor de webhooks. Un servidor no termina solo: al salir cierra la base y exporta lo
 *  pendiente. */
async function startServing(
  mounted: MountedRunner,
  cfg: RunnerConfig,
  telemetry: Telemetry,
  store: ActivityStore,
  log: (line: string) => void,
): Promise<void> {
  registerProviders(cfg.providers, {
    cwd: (ctx) => mounted.services.session.dirFor(ctx),
    log,
    onTrace: (record) => {
      store.writeTrace(record)
      telemetry.remote(record)
    },
  })
  const inbox = mountInbox(mounted, cfg, store, { version: VERSION, log })
  // Lo que se retoma tras un reinicio queda vencido: que corra ya, con los providers registrados
  // — no en el primer tick, y nunca en una validación o un evento suelto.
  mounted.engine.tick()
  const stopHeartbeat = startHeartbeat(
    () => mounted.engine.executions?.stats ?? { running: 0, waiting: 0, paused: 0 },
  )
  await serve(mounted, {
    // `applyRunnerEnv` ya volcó settings.port a este env var.
    port: positiveInt(process.env.IA_FLOW_SERVER_PORT, 3001),
    secret: process.env.IA_FLOW_WEBHOOK_SECRET,
    log: (line) => {
      console.log(line)
      runnerLog.info(line)
    },
    // Sin `SLACK_APP_TOKEN` no se levanta el ingreso de Slack.
    slack: {
      appToken: () => process.env.SLACK_APP_TOKEN,
      log: (line) => {
        console.log(line)
        runnerLog.info(line)
      },
    },
    api: inbox.api,
    onDelivery: () => inbox.board.invalidate(),
    onIgnored: (event, reason) => store.ignored(event, reason),
  })
  if (!process.env.IA_FLOW_API_TOKEN?.trim()) {
    console.log('→ aviso: sin IA_FLOW_API_TOKEN la API de la web responde 503')
  }
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      stopHeartbeat()
      inbox.close()
      mounted.stop()
      store.close()
      void telemetry.shutdown().finally(() => process.exit(0))
    })
  }
}

/** El host de providers: los locales de este runner, para los `type: remote` de otros. Como el
 *  servidor de webhooks, no termina solo. */
function startHosting(
  { host, providers, githubAuthMode }: MountedHost,
  cfg: RunnerConfig,
  telemetry: Telemetry,
  route: TraceRoute,
): void {
  console.log(`→ github: ${githubAuthMode}`)
  // Lo que corre acá vuelve, por el sync, al runner que pidió cada corrida.
  route.to({ write: (record) => host.trace(record) })
  const port = positiveInt(
    process.env.IA_FLOW_PROVIDER_HOST_PORT,
    cfg.host.port ?? DEFAULT_HOST_PORT,
  )
  // Bun corta una conexión inactiva a los 10 s por default, y cada sync del runner espera hasta
  // 15 s (long-poll): sin esto, todos se cortarían a mitad de la espera.
  const server = Bun.serve({ port, fetch: host.fetch, idleTimeout: 60 })
  console.log(
    `→ host: ${providers.map((provider) => provider.id).join(', ')} en http://localhost:${server.port}/v1${cfg.host.rules?.length ? ` (${cfg.host.rules.length} reglas de admisión)` : ''}`,
  )
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      host.close()
      void server.stop()
      void telemetry.shutdown().finally(() => process.exit(0))
    })
  }
}

/** Un webhook crudo: `--event` (desde un archivo) o `--replay-pr` (un PR real, como `opened`). */
async function dispatchOne(
  mounted: MountedRunner,
  cfg: RunnerConfig,
  args: RunnerArgs,
  telemetry: Telemetry,
  store: ActivityStore,
  log: (line: string) => void,
): Promise<void> {
  registerProviders(cfg.providers, {
    cwd: (ctx) => mounted.services.session.dirFor(ctx),
    log,
    onTrace: (record) => {
      store.writeTrace(record)
      telemetry.remote(record)
    },
  })
  try {
    if (args.replayPr) {
      const target = parseIssueTarget(args.replayPr)
      if (!target)
        throw new Error(`--replay-pr: "${args.replayPr}" no es <owner>/<repo>#<n>\n\n${USAGE}`)
      await replayPullRequest(mounted, target, log)
    } else if (args.event) {
      const payload = JSON.parse(readFileSync(args.event.payloadPath, 'utf8')) as Record<
        string,
        unknown
      >
      await dispatchRaw(mounted, { event: args.event.type.slice('github.'.length), payload }, log)
    }
  } finally {
    reportTraces(telemetry)
  }
}

let telemetry: Telemetry | undefined

async function main(): Promise<'serving' | 'done'> {
  const args = parseArgs(process.argv.slice(2))
  const configDir = expandHome(
    args.configDir ?? process.env.RUNNER_CONFIG_DIR ?? DEFAULT_CONFIG_DIR,
  )
  const cfg = loadRunnerConfig(configDir)
  const envReport = applyRunnerEnv(cfg)
  // Después de la config: `telemetry:` de runner.yaml ya está en las `OTEL_*`.
  const route = new TraceRoute()
  const started = startTelemetry(VERSION, route)
  telemetry = started
  const log = (line: string) => {
    console.log(`  ${line}`)
    runnerLog.info(line)
  }
  if (args.host) {
    console.log(`→ config: ${configDir} — host`)
    const mountedHost = await mountHost(cfg, {
      ...(process.env.WORKSPACE_DIR ? { workspaceDir: process.env.WORKSPACE_DIR } : {}),
      token: process.env.IA_FLOW_PROVIDER_HOST_TOKEN,
      log,
    })
    startHosting(mountedHost, cfg, started, route)
    return 'serving'
  }

  // La memoria de lo que pasa (bandeja, asistente).
  const store = openActivityStore(cfg)
  route.to({ write: (record) => store.writeTrace(record) })
  console.log(
    `→ config: ${configDir} — ${cfg.projects.length} proyecto(s), ${cfg.repos.length} repos, ${cfg.mcp.length} mcp`,
  )

  const mounted = await mountRunner(cfg, {
    workspaceDir: process.env.WORKSPACE_DIR,
    log,
    dispatchJournal: store.dispatchJournal,
  })
  reportBoot(mounted, envReport)

  if (args.serve) {
    await startServing(mounted, cfg, started, store, log)
    return 'serving'
  }
  try {
    if (args.replayPr || args.event) await dispatchOne(mounted, cfg, args, started, store, log)
    return 'done'
  } finally {
    mounted.stop()
    store.close()
  }
}

main()
  .then(async (outcome) => {
    // El servidor sigue vivo (y exporta en batch); una corrida de CLI exporta y termina.
    if (outcome !== 'serving') await telemetry?.shutdown()
  })
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err)
    await telemetry?.shutdown()
    process.exit(1)
  })
