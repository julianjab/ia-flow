/**
 * `--host`: esta máquina le presta su CLI `claude` a un runner (`@ia-flow/provider-remote`). Se
 * suscribe a él y le pide tareas por long-poll — todas las conexiones salen de acá, así que no
 * necesita puerto ni URL pública. Del otro lado aparece como `remote:<name>`.
 *
 * Cada tarea es una sesión de `claude` en el worktree de ESTA máquina (su `WORKSPACE_DIR`, armado
 * desde el evento que viaja con la tarea) apuntando al canal de la corrida en el runner: las tools
 * del agente y los hooks van contra la API del runner, que es el que espera el resultado. El host
 * no conduce nada: lanza, y corta la sesión cuando el runner cierra la corrida.
 *
 * Un host no despacha: monta sólo su identidad de GitHub (para clonar), su workspace y el CLI. Ni
 * engine, ni fuentes, ni base de ejecuciones, ni la marca Working.
 */

import { join } from 'node:path'
import { EventBus, type McpServerRef, type PipelineExecutionContext } from '@ia-flow/agent-engine'
import {
  type ClaudeCliConfig,
  closeOrphan,
  launchCli,
  mergeClaudeCliConfig,
  parseClaudeCliConfig,
  sessionName,
} from '@ia-flow/provider-anthropic-cli'
import {
  HostClient,
  type HostTask,
  type RunReport,
  type TaskRunner,
} from '@ia-flow/provider-remote'
import { NodeShellRunner, type WorkspaceSession } from '@ia-flow/workspace'
import type { RunnerConfig } from '../config/RunnerConfig.js'
import { resolveGithubAuth, verifyGithubAuth } from '../github/githubAuth.js'
import { mountWorkspace } from '../workspace/mountWorkspace.js'
import { DEFAULT_WORKTREE_TTL_HOURS, WorktreeSweeper } from '../workspace/WorktreeSweeper.js'
import { CLAUDE_CLI_TYPE } from './providers.js'
import { forwardTranscript, type TranscriptForwarder } from './transcriptForwarder.js'

const DEFAULT_TIMEOUT_MINUTES = 120
/** Lo que se deja pasar entre que el runner cierra la corrida y se corta la sesión: que la
 *  respuesta de la tool terminal le llegue al CLI. */
const CLOSE_GRACE_MS = 500

export interface HostSettings {
  name: string
  runner: string
  token: string
  maxConcurrent: number
  accepts: NonNullable<RunnerConfig['host']['accepts']>
  /** Horas sin uso tras las que borra un worktree (`0`: nunca). */
  worktreeTtlHours: number
  /** El provider que presta y sus defaults. */
  provider: { id: string; defaults: ClaudeCliConfig; bin?: string }
}

/** Qué presta y a quién, de `host:` y `providers:` de su runner.yaml, más el ambiente (gana). */
export function hostSettings(cfg: RunnerConfig, env = process.env): HostSettings {
  const name = env.IA_FLOW_HOST_NAME?.trim() || cfg.host.name
  const runner = env.IA_FLOW_HOST_RUNNER_URL?.trim() || cfg.host.runner
  const token = env.IA_FLOW_HOST_TOKEN?.trim()
  const missing = [
    !name && 'host.name (o IA_FLOW_HOST_NAME)',
    !runner && 'host.runner (o IA_FLOW_HOST_RUNNER_URL)',
    !token && 'IA_FLOW_HOST_TOKEN (el token de hosts del runner)',
  ].filter(Boolean)
  if (missing.length > 0) throw new Error(`--host necesita ${missing.join(', ')}`)
  return {
    name: name as string,
    runner: runner as string,
    token: token as string,
    maxConcurrent: cfg.host.maxConcurrent ?? 1,
    accepts: cfg.host.accepts ?? [],
    worktreeTtlHours: cfg.host.worktreeTtlHours ?? DEFAULT_WORKTREE_TTL_HOURS,
    provider: lentProvider(cfg),
  }
}

/** La entrada `type: claude-cli` que presta: la que nombra `host.provider`, o la única. */
function lentProvider(cfg: RunnerConfig): HostSettings['provider'] {
  const clis = Object.entries(cfg.providers).filter(([, config]) => config.type === CLAUDE_CLI_TYPE)
  const chosen = cfg.host.provider
    ? clis.find(([id]) => id === cfg.host.provider)
    : clis.length === 1
      ? clis[0]
      : undefined
  if (!chosen) {
    const known = clis.map(([id]) => id).join(', ') || 'ninguna'
    throw new Error(
      cfg.host.provider
        ? `host.provider: "${cfg.host.provider}" no es una entrada type: claude-cli de providers (hay: ${known})`
        : `--host presta un CLI: nombrá cuál en host.provider (entradas type: claude-cli: ${known})`,
    )
  }
  const [id, config] = chosen
  const { type: _type, maxConcurrent: _max, bin, ...defaults } = config
  return {
    id,
    defaults: parseClaudeCliConfig(defaults),
    ...(typeof bin === 'string' ? { bin } : {}),
  }
}

export interface MountedHost {
  client: HostClient
  settings: HostSettings
  githubAuthMode: string
  /** La limpieza de worktrees sin uso; sin ella (`worktreeTtlHours: 0`), no se limpian. */
  sweeper?: WorktreeSweeper
}

/** Cada cuánto busca worktrees vencidos. */
export const SWEEP_INTERVAL_MS = 60 * 60_000

/** Lo que un host necesita, y nada más (ver arriba). */
export async function mountHost(
  cfg: RunnerConfig,
  opts: { workspaceDir?: string; log: (line: string) => void },
): Promise<MountedHost> {
  const settings = hostSettings(cfg)
  const github = await resolveGithubAuth()
  await verifyGithubAuth(github)
  const { session, workspace, root } = mountWorkspace({
    ...(opts.workspaceDir ? { root: opts.workspaceDir } : {}),
    githubToken: () => github.auth.getToken(),
    log: opts.log,
  })
  const sweeper =
    settings.worktreeTtlHours > 0
      ? new WorktreeSweeper({
          shell: new NodeShellRunner(),
          workspace,
          ledgerPath: join(root, 'host-worktrees.json'),
          ttlMs: settings.worktreeTtlHours * 3_600_000,
          log: opts.log,
        })
      : undefined
  const client = new HostClient({
    runnerUrl: settings.runner,
    token: settings.token,
    name: settings.name,
    maxConcurrent: settings.maxConcurrent,
    accepts: settings.accepts,
    run: cliTaskRunner({
      session,
      provider: settings.provider,
      log: opts.log,
      ...(sweeper ? { worktrees: sweeper } : {}),
    }),
  })
  return { client, settings, githubAuthMode: github.mode, ...(sweeper ? { sweeper } : {}) }
}

/**
 * Una tarea del runner como sesión del CLI: el worktree de la task en este disco, y `claude`
 * apuntando al canal de la corrida en el runner. Termina cuando la sesión termina (se lo reporta
 * al runner), cuando el runner cierra la corrida (el modelo ya eligió su salida: se corta sin
 * reportar), o al tope de minutos del provider.
 */
export function cliTaskRunner(opts: {
  session: Pick<WorkspaceSession, 'dirFor'>
  provider: HostSettings['provider']
  log: (line: string) => void
  launch?: typeof launchCli
  close?: typeof closeOrphan
  /** Quién anota el uso de cada worktree, para limpiar los que quedan sin uso. */
  worktrees?: Pick<WorktreeSweeper, 'begin' | 'end'>

  /** Dónde está la transcripción del CLI (default `~/.claude/projects`) y cómo se le habla al
   *  runner: los tests los inyectan. */
  transcriptsDir?: string
  fetchImpl?: typeof fetch
}): TaskRunner {
  const launch = opts.launch ?? launchCli
  const close = opts.close ?? closeOrphan
  return async (task, runner, signal) => {
    const config = mergeClaudeCliConfig(
      opts.provider.defaults,
      parseClaudeCliConfig(task.providerConfig),
    )
    const prepare = () => opts.session.dirFor(contextOf(task))
    const cwd = opts.worktrees ? await opts.worktrees.begin(prepare) : await prepare()
    try {
      return await runIn(cwd, task, runner, signal, config)
    } finally {
      opts.worktrees?.end(cwd)
    }
  }

  async function runIn(
    cwd: string,
    task: HostTask,
    runner: { base: string },
    signal: AbortSignal,
    config: ClaudeCliConfig,
  ): Promise<RunReport | undefined> {
    // Una sesión que quedó viva de antes (el host se reinició a mitad de camino) se cierra antes
    // de retomar su conversación en una nueva.
    if (config.mode === 'tmux') await close({ kind: 'tmux', name: sessionName(task.label) })
    const launched = await launch({
      endpoints: {
        mcp: `${runner.base}${task.endpoints.mcp}`,
        hooks: `${runner.base}${task.endpoints.hooks}`,
      },
      cwd,
      label: task.label,
      prompt: task.prompt,
      systemPrompts: task.systemPrompts,
      exits: task.exits,
      mcpServers: task.mcpServers as McpServerRef[],
      config,
      session: task.session,
      ...(opts.provider.bin ? { bin: opts.provider.bin } : {}),
    })
    opts.log(`${task.agentId}: sesión ${config.mode ?? 'print'} ${launched.session.describe}`)
    // El uso de cada request vive en la transcripción de ESTE disco: se lo manda al runner.
    const transcript = startTranscript(task, runner, opts)
    const minutes = config.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const ended = await Promise.race([
        launched.session.exited.then((exit) => ({ kind: 'exited' as const, exit })),
        aborted(signal).then(() => ({ kind: 'closed' as const })),
        new Promise<{ kind: 'timeout' }>((resolve) => {
          timer = setTimeout(() => resolve({ kind: 'timeout' }), minutes * 60_000)
          timer.unref?.()
        }),
      ])
      if (ended.kind === 'closed') return undefined
      if (ended.kind === 'timeout') {
        return { status: 'exited', code: null, message: `la sesión superó ${minutes} min` }
      }
      return report(ended.exit)
    } finally {
      if (timer) clearTimeout(timer)
      await delay(CLOSE_GRACE_MS)
      await transcript?.stop()
      await launched.session.close().catch(() => {})
      await launched.cleanup().catch(() => {})
    }
  }
}

/** El reenvío del uso al runner, si éste lo pide (`endpoints.transcript`: un runner viejo no). */
function startTranscript(
  task: HostTask,
  runner: { base: string },
  opts: { transcriptsDir?: string; fetchImpl?: typeof fetch },
): TranscriptForwarder | undefined {
  if (!task.endpoints.transcript) return undefined
  return forwardTranscript({
    url: `${runner.base}${task.endpoints.transcript}`,
    sessionId: task.session.id,
    since: new Date(),
    ...(opts.transcriptsDir ? { projectsDir: opts.transcriptsDir } : {}),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  })
}

/** Lo que el workspace necesita de la corrida: su evento (de él sale el worktree). */
function contextOf(task: HostTask): PipelineExecutionContext {
  return {
    event: {
      id: task.event.id,
      type: task.event.type,
      payload: task.event.payload as Record<string, unknown>,
      ...(task.event.scope ? { scope: task.event.scope } : {}),
      occurredAt: task.event.occurredAt,
      depth: 0,
    },
    steps: {},
    bus: new EventBus(),
    pipelineId: 'remote',
    ...(task.lane ? { lane: task.lane } : {}),
  }
}

function report(exit: { code: number | null; output: string }): RunReport {
  const text = exit.output.trim()
  return { status: 'exited', code: exit.code, ...(text ? { message: text.slice(-800) } : {}) }
}

function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve()
    else signal.addEventListener('abort', () => resolve(), { once: true })
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
