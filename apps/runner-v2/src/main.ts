/**
 * runner-v2 — el runner headless de ia-flow sobre `@ia-tools/agent-pipeline`. La definición del
 * pipeline vive en `.config/` (engine.yaml + runner.yaml + projects/<id>/) y las ejecuciones en
 * SQLite, así que una pausa (esperar el CI) sobrevive a un reinicio.
 *
 * Sin evento, se queda en el arranque: carga, valida y reporta. Con un evento armado desde la CLI,
 * lo despacha. Con `--serve`, levanta el servidor de webhooks y despacha cada delivery de GitHub.
 *
 * Modos:
 *   --dry-run   sin credenciales: no verifica GitHub ni resuelve MCP; con evento, muestra qué
 *               pipelines corren y sus rutas efectivas sin llamar al modelo.
 *   (default)   GitHub y Messages API reales, pero las escrituras de las acciones se simulan e
 *               imprimen. El MCP de GitHub corre en Anthropic y SÍ puede escribir.
 *   --live      escrituras reales.
 *   --serve     servidor de webhooks (incompatible con --dry-run: traducir un delivery lee el board).
 *
 *   bun run src/main.ts --dry-run
 *   IA_FLOW_GITHUB_APP_PRIVATE_KEY_PATH=~/secrets/app.pem ANTHROPIC_API_KEY=... \
 *     bun run src/main.ts issue.status_changed la-haus/subscriptions#123 --status Refine
 *   IA_FLOW_WEBHOOK_SECRET=... bun run src/main.ts --serve
 *
 * Bun carga solo el `.env` del directorio desde el que corre (gitignoreado).
 */
import { resolve } from 'node:path'
import {
  BoundAction,
  isAgent,
  type Pipeline,
  providerRegistry,
  type Runnable,
} from '@ia-tools/agent-pipeline'
import { AnthropicProvider, parseAnthropicAgentConfig } from '@ia-tools/provider-anthropic'
import { createLogger } from '@ia-tools/telemetry'
import { type MountedRunner, mountRunner } from './boot.js'
import { applyRunnerEnv, loadRunnerConfig, type RunnerConfig } from './config/RunnerConfig.js'
import { projectFor, toDomainEvent } from './dispatch.js'
import { type EventArgs, parseArgs, parseIssueTarget, type RunnerArgs, USAGE } from './event.js'
import { replayPullRequest, serve } from './serve.js'
import { startTelemetry, type Telemetry } from './telemetry.js'

/** Lo que el runner imprime también sale como log OTLP, con la traza activa y el scope del evento. */
const runnerLog = createLogger('ia-flow-runner-v2')

const DEFAULT_CONFIG_DIR = resolve(import.meta.dir, '../.config')

function expandHome(path: string): string {
  return path.startsWith('~') ? path.replace('~', process.env.HOME ?? '~') : path
}

/** `update_issue{status: Build}` — el id del paso más lo que fijó la config con `bind`. */
function label(step: Runnable | undefined): string {
  if (!step) return 'END'
  if (step instanceof BoundAction) {
    const fixed = Object.entries(step.fixed)
      .map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`)
      .join(', ')
    return `${step.id}{${fixed}}`
  }
  return step.id ?? '(paso)'
}

function describeRoutes(mounted: MountedRunner, pipeline: Pipeline): void {
  for (const step of pipeline.do) {
    if (!isAgent(step)) {
      console.log(`    · ${step.id ?? '(paso)'}`)
      continue
    }
    const routes = mounted.routesOf(pipeline, step.id as string)
    const onStart = [step.definition.onStart ?? []].flat()
    const start = onStart.length > 0 ? ` (onStart ${onStart.map(label).join(' → ')})` : ''
    console.log(`    · ${step.id}${start}`)
    for (const exit of routes.exits) {
      const targets = exit.targets.map(label).join(' → ') || 'END'
      const report = exit.report ? ` [report ${label(exit.report)} (${exit.reportOrigin})]` : ''
      console.log(`        ${exit.name} (${exit.origin}) → ${targets}${report}`)
    }
    if (routes.onError) {
      const targets = [routes.onError.route.to]
        .flat()
        .map((t) => (typeof t === 'symbol' || t === undefined ? 'END' : label(t)))
      console.log(`        onError (${routes.onError.origin}) → ${targets.join(' → ')}`)
    }
  }
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
  console.log(
    `→ ${mounted.pipelines().length} pipelines montadas y validadas, ${mounted.intake().length} de entrada (intake/)`,
  )
  if (mounted.executions) {
    const { running, waiting, paused } = mounted.executions.stats
    console.log(`→ ejecuciones: ${running} corriendo, ${waiting} esperando, ${paused} pausadas`)
  }
  for (const line of mounted.warnings) console.log(`→ aviso: ${line}`)
  if (mounted.missingTools.size > 0) {
    console.log(`→ tools sin equivalente: ${[...mounted.missingTools].sort().join(', ')}`)
  }
}

/** `anthropic-api` con su config de `providers.anthropic-api` del runner.yaml: los defaults de
 *  todos sus agentes, con la misma estructura que el `providerConfig` de cada uno. */
function registerProvider(log: (line: string) => void, config: Record<string, unknown> = {}): void {
  const { resumeMessages: _, ...defaults } = parseAnthropicAgentConfig(config)
  providerRegistry.register(
    new AnthropicProvider({
      id: 'anthropic-api',
      ...defaults,
      model: process.env.ANTHROPIC_MODEL ?? defaults.model ?? 'claude-sonnet-5',
      onToolCall: (name, input) => log(`[tool] ${name} ${JSON.stringify(input).slice(0, 200)}`),
      onToolResult: (name, result) => log(`[tool:${name}] ${result.slice(0, 200)}`),
    }),
  )
}

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

/** `--dry-run` no lee GitHub: los modos que lo necesitan no lo admiten. */
function assertModes(args: RunnerArgs): void {
  if (args.replayPr && args.dryRun) {
    throw new Error(
      `--replay-pr no admite --dry-run: el PR y el board se leen de GitHub\n\n${USAGE}`,
    )
  }
  if (args.serve && args.dryRun) {
    throw new Error(
      `--serve no admite --dry-run: traducir un delivery lee el board de GitHub\n\n${USAGE}`,
    )
  }
}

/** El servidor de webhooks. Un servidor no termina solo: al salir cierra la base y exporta lo
 *  pendiente. */
async function startServing(
  mounted: MountedRunner,
  cfg: RunnerConfig,
  telemetry: Telemetry,
  log: (line: string) => void,
): Promise<void> {
  registerProvider(log, cfg.providers['anthropic-api'])
  await serve(mounted, {
    // `applyRunnerEnv` ya volcó settings.port a este env var.
    port: positiveInt(process.env.IA_FLOW_SERVER_PORT, 3001),
    secret: process.env.IA_FLOW_WEBHOOK_SECRET,
    log: (line) => {
      console.log(line)
      runnerLog.info(line)
    },
  })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      mounted.stop()
      void telemetry.shutdown().finally(() => process.exit(0))
    })
  }
}

/** Un PR real, por el intake como un `pull_request` `opened`. */
async function replay(
  mounted: MountedRunner,
  cfg: RunnerConfig,
  replayPr: string,
  log: (line: string) => void,
): Promise<void> {
  const target = parseIssueTarget(replayPr.replace('/pull/', '/issues/'))
  if (!target) throw new Error(`--replay-pr: "${replayPr}" no es <owner>/<repo>#<n>\n\n${USAGE}`)
  registerProvider(log, cfg.providers['anthropic-api'])
  await replayPullRequest(mounted, target, log)
}

/** Un evento armado en la CLI: qué pipelines corren y sus rutas; sin `--dry-run`, lo despacha. */
async function dispatchEvent(
  mounted: MountedRunner,
  cfg: RunnerConfig,
  args: RunnerArgs & { event: EventArgs },
  telemetry: Telemetry,
  log: (line: string) => void,
): Promise<void> {
  const { event } = args
  const project = projectFor(mounted, event.repo)
  if (!project) {
    throw new Error(`ningún proyecto montado declara el repo "${event.repo}"\n\n${USAGE}`)
  }
  const domainEvent = await toDomainEvent(project, event, args.dryRun)
  const selected = await mounted.engine.select(domainEvent)
  console.log(
    `→ evento ${event.eventType} ${event.owner}/${event.repo}#${event.number} (${project.id})`,
  )
  if (selected.length === 0) {
    console.log('→ ninguna pipeline matchea este evento')
    // Igual se despacha: la traza guarda por qué no corrió cada una.
    if (!args.dryRun) await mounted.engine.dispatch(domainEvent)
    reportTraces(telemetry)
    return
  }
  console.log(`→ pipelines que corren: ${selected.map((p) => p.id).join(', ')}`)
  for (const pipeline of selected) {
    console.log(`  ${pipeline.id}`)
    describeRoutes(mounted, pipeline)
  }
  if (args.dryRun) return

  registerProvider(log, cfg.providers['anthropic-api'])
  try {
    console.log(`→ ${await mounted.engine.dispatch(domainEvent)}`)
  } finally {
    reportTraces(telemetry)
  }
}

async function main(telemetry: Telemetry): Promise<'serving' | 'done'> {
  const args = parseArgs(process.argv.slice(2))
  assertModes(args)
  const configDir = expandHome(
    args.configDir ?? process.env.RUNNER_CONFIG_DIR ?? DEFAULT_CONFIG_DIR,
  )
  const cfg = loadRunnerConfig(configDir)
  const envReport = applyRunnerEnv(cfg)
  console.log(
    `→ config: ${configDir} — ${cfg.projects.length} proyecto(s), ${cfg.repos.length} repos, ${cfg.mcp.length} mcp`,
  )

  const log = (line: string) => {
    console.log(`  ${line}`)
    runnerLog.info(line)
  }
  const mounted = await mountRunner(cfg, {
    dryRun: args.dryRun,
    live: args.live,
    workspaceDir: process.env.WORKSPACE_DIR,
    log,
  })
  reportBoot(mounted, envReport)

  if (args.serve) {
    await startServing(mounted, cfg, telemetry, log)
    return 'serving'
  }
  try {
    const { event } = args
    if (args.replayPr) await replay(mounted, cfg, args.replayPr, log)
    else if (event) await dispatchEvent(mounted, cfg, { ...args, event }, telemetry, log)
    return 'done'
  } finally {
    mounted.stop()
  }
}

const telemetry = startTelemetry('0.1.0')
main(telemetry)
  .then(async (outcome) => {
    // El servidor sigue vivo (y exporta en batch); una corrida de CLI exporta y termina.
    if (outcome !== 'serving') await telemetry.shutdown()
  })
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err)
    await telemetry.shutdown()
    process.exit(1)
  })
