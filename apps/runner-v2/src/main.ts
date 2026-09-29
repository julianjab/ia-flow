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
import { providerRegistry } from '@ia-flow/agent-engine'
import { AnthropicProvider, parseAnthropicAgentConfig } from '@ia-flow/provider-anthropic'
import { createLogger } from '@ia-flow/telemetry'
import { type MountedRunner, mountRunner } from './boot.js'
import { parseArgs, parseIssueTarget, type RunnerArgs, USAGE } from './cli.js'
import { applyRunnerEnv, loadRunnerConfig, type RunnerConfig } from './config/RunnerConfig.js'
import { dispatchRaw, replayPullRequest, serve } from './serve.js'
import { startTelemetry, type Telemetry } from './telemetry.js'

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

/** Un webhook crudo: `--event` (desde un archivo) o `--replay-pr` (un PR real, como `opened`). */
async function dispatchOne(
  mounted: MountedRunner,
  cfg: RunnerConfig,
  args: RunnerArgs,
  telemetry: Telemetry,
  log: (line: string) => void,
): Promise<void> {
  registerProvider(log, cfg.providers['anthropic-api'])
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

async function main(telemetry: Telemetry): Promise<'serving' | 'done'> {
  const args = parseArgs(process.argv.slice(2))
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
    workspaceDir: process.env.WORKSPACE_DIR,
    log,
  })
  reportBoot(mounted, envReport)

  if (args.serve) {
    await startServing(mounted, cfg, telemetry, log)
    return 'serving'
  }
  try {
    if (args.replayPr || args.event) await dispatchOne(mounted, cfg, args, telemetry, log)
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
