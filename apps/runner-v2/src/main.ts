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
 *   --host      le presta su CLI `claude` a un runner: se suscribe y pide tareas (`remote:<name>`).
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
import { createLogger, type TraceJournal } from '@ia-flow/telemetry'
import { type MountedRunner, mountRunner } from './boot.js'
import { registerVirtualModules } from './bundle/register.js'
import { parseArgs, parseIssueTarget, type RunnerArgs, USAGE } from './cli.js'
import { applyRunnerEnv, loadRunnerConfig, type RunnerConfig } from './config/RunnerConfig.js'
import { dispatchRaw, replayPullRequest, serve } from './http/serve.js'
import { mountInbox } from './inbox/mountInbox.js'
import { type McpHost, startMcpHost } from './mcp/mcpHost.js'
import { hostTelemetryIngest } from './providers/hostTelemetry.js'
import { hostSettings, type MountedHost, mountHost } from './providers/providerHost.js'
import { registerProviders } from './providers/providers.js'
import { listenHosts, mountRemoteHosts, nodeHandler } from './providers/remoteHosts.js'
import { type ActivityStore, openActivityStore } from './storage/activityStore.js'
import { startHeartbeat } from './telemetry/heartbeat.js'
import { startTelemetry, type Telemetry, TraceRoute } from './telemetry/telemetry.js'

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

/** La del bundle publicado (`scripts/package-release.ts` la fija con `--define`); desde el árbol
 *  de trabajo, `dev`. */
const VERSION = process.env.IA_FLOW_RUNNER_VERSION ?? 'dev'

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
  mcpHost: McpHost | undefined,
  log: (line: string) => void,
): Promise<void> {
  registerProviders(cfg.providers, { cwd: (ctx) => mounted.services.session.dirFor(ctx), log })
  const inbox = mountInbox(mounted, cfg, store, { version: VERSION, log })
  // Los hosts que se suscriben (`remote:<name>`), en el mismo puerto que los webhooks — y su
  // telemetría, que se anota y reexporta como la del runner.
  const hosts = mountRemoteHosts(hostIngest({ write: (record) => store.writeTrace(record) }))
  const hostsApi = nodeHandler((req) => hosts.fetch(req))
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
    api: {
      handle: async (req, res) =>
        (await mcpHost?.handle(req, res)) ||
        (await hostsApi.handle(req, res)) ||
        inbox.api.handle(req, res),
    },
    onDelivery: () => inbox.board.invalidate(),
    onIgnored: (event, reason) => store.ignored(event, reason),
  })
  if (!process.env.IA_FLOW_API_TOKEN?.trim()) {
    console.log('→ aviso: sin IA_FLOW_API_TOKEN la API de la web responde 503')
  }
  if (!process.env.IA_FLOW_HOST_TOKEN?.trim()) {
    console.log('→ aviso: sin IA_FLOW_HOST_TOKEN ningún host se puede suscribir (remote:*)')
  }
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      stopHeartbeat()
      mcpHost?.close()
      hosts.close()
      inbox.close()
      mounted.stop()
      store.close()
      void telemetry.shutdown().finally(() => process.exit(0))
    })
  }
}

/** El host: se suscribe al runner y toma tareas hasta que lo apaguen. Sin servidor propio. */
function startHosting(
  { client, settings, githubAuthMode }: MountedHost,
  telemetry: Telemetry,
): void {
  console.log(`→ github: ${githubAuthMode}`)
  console.log(
    `→ host ${settings.name}: presta ${settings.provider.id} a ${settings.runner} (hasta ${settings.maxConcurrent} a la vez${settings.accepts.length > 0 ? `, ${settings.accepts.length} condiciones` : ''})`,
  )
  client.start()
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void client
        .stop()
        .then(() => telemetry.shutdown())
        .finally(() => process.exit(0))
    })
  }
}

/** Un webhook crudo: `--event` (desde un archivo) o `--replay-pr` (un PR real, como `opened`). */
async function dispatchOne(
  mounted: MountedRunner,
  cfg: RunnerConfig,
  args: RunnerArgs,
  telemetry: Telemetry,
  log: (line: string) => void,
): Promise<void> {
  registerProviders(cfg.providers, { cwd: (ctx) => mounted.services.session.dirFor(ctx), log })
  // Un agente con `remote:*` necesita que sus hosts lo alcancen también en un evento suelto.
  const hosts = process.env.IA_FLOW_HOST_TOKEN?.trim()
    ? mountRemoteHosts(hostIngest(route))
    : undefined
  const server = hosts
    ? await listenHosts(hosts, positiveInt(process.env.IA_FLOW_SERVER_PORT, 3001), log)
    : undefined
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
    hosts?.close()
    server?.close()
    reportTraces(telemetry)
  }
}

let telemetry: Telemetry | undefined
/** A dónde van los registros de una ejecución de ESTE proceso (la base, en `--serve`). */
const route = new TraceRoute()

/** La telemetría que exportan los hosts: a `journal`, y reexportada al collector del runner. */
function hostIngest(journal: TraceJournal) {
  return hostTelemetryIngest(journal, {
    ...(process.env.OTEL_EXPORTER_OTLP_ENDPOINT
      ? { endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT }
      : {}),
    ...(process.env.OTEL_EXPORTER_OTLP_HEADERS
      ? { headers: process.env.OTEL_EXPORTER_OTLP_HEADERS }
      : {}),
  })
}

async function main(): Promise<'serving' | 'done'> {
  // Antes de cargar la config: sus actions resuelven `@ia-flow/*` y `zod` por acá, vivan donde vivan.
  registerVirtualModules()
  const args = parseArgs(process.argv.slice(2))
  const configDir = expandHome(
    args.configDir ?? process.env.RUNNER_CONFIG_DIR ?? DEFAULT_CONFIG_DIR,
  )
  const cfg = loadRunnerConfig(configDir)
  const envReport = applyRunnerEnv(cfg)
  // Después de la config: `telemetry:` de runner.yaml ya está en las `OTEL_*`. Un host le manda
  // su telemetría al runner al que presta.
  const host = args.host ? hostSettings(cfg) : undefined
  const started = startTelemetry(
    VERSION,
    route,
    host ? { name: host.name, runner: host.runner, token: host.token } : undefined,
  )
  telemetry = started
  const log = (line: string) => {
    console.log(`  ${line}`)
    runnerLog.info(line)
  }
  if (args.host) {
    console.log(`→ config: ${configDir} — host`)
    const mountedHost = await mountHost(cfg, {
      ...(process.env.WORKSPACE_DIR ? { workspaceDir: process.env.WORKSPACE_DIR } : {}),
      log,
    })
    startHosting(mountedHost, started)
    return 'serving'
  }

  // La memoria de lo que pasa (bandeja, asistente).
  const store = openActivityStore(cfg)
  route.to({ write: (record) => store.writeTrace(record) })
  console.log(
    `→ config: ${configDir} — ${cfg.projects.length} proyecto(s), ${cfg.repos.length} repos, ${cfg.mcp.length} mcp`,
  )

  // Los MCP propios arrancan antes que el catálogo: el que los nombra (`hosted`) los prueba vivos.
  const mcpHost =
    args.serve && Object.keys(cfg.mcpHost).length > 0
      ? await startMcpHost(cfg.mcpHost, { log })
      : undefined
  await mcpHost?.ready()

  const mounted = await mountRunner(cfg, {
    workspaceDir: process.env.WORKSPACE_DIR,
    log,
    dispatchJournal: store.dispatchJournal,
    ...(mcpHost ? { mcpHost } : {}),
  })
  reportBoot(mounted, envReport)

  if (args.serve) {
    await startServing(mounted, cfg, started, store, mcpHost, log)
    return 'serving'
  }
  try {
    if (args.replayPr || args.event) await dispatchOne(mounted, cfg, args, started, log)
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
