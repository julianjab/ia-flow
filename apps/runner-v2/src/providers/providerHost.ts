/**
 * `--host`: esta máquina corre agentes para un runner (`@ia-flow/provider-remote`). Se suscribe a
 * él y le pide tareas por long-poll — todas las conexiones salen de acá, así que no necesita puerto
 * ni URL pública. Del otro lado aparece como `remote:<name>`.
 *
 * Cada tarea es la corrida de un agente, y se corre con el provider de ESTE runner.yaml
 * (`host.provider`: el CLI `claude`, la Messages API…) exactamente como el runner corre el suyo:
 * `provider.run(ctx)` sobre el worktree de esta máquina (armado desde el evento que viaja con la
 * tarea). Del runner vienen las tools del engine (`submit_*`, GitHub…: se llaman allá), la bandeja,
 * la conversación a retomar; acá se rearman las de workspace (`fs_*`, `bash_run`), si el provider
 * las usa. El resultado vuelve al runner.
 *
 * Un host no despacha: monta sólo su identidad de GitHub (para clonar), su workspace y su
 * provider. Ni engine, ni fuentes, ni base de ejecuciones, ni la marca Working.
 */

import { join } from 'node:path'
import {
  EventBus,
  type McpServerRef,
  type PipelineExecutionContext,
  type Provider,
  type Tool,
} from '@ia-flow/agent-engine'
import {
  CLOSED_BY_RUNNER,
  HostClient,
  type HostTask,
  RunnerLink,
  type RunResult,
  type TaskRunner,
  type WorkspaceToolSpec,
} from '@ia-flow/provider-remote'
import { createLogger } from '@ia-flow/telemetry'
import { NodeShellRunner, type WorkspaceSession } from '@ia-flow/workspace'
import {
  HOST_WORKSPACE_TOOLS,
  type WorkspaceToolDeps,
  workspaceTool,
} from '../actions/builtin/workspace.js'
import type { RunnerConfig } from '../config/RunnerConfig.js'
import { defaultHostWorkspaceRoot } from '../config/runnerHome.js'
import { resolveGithubAuth, verifyGithubAuth } from '../github/githubAuth.js'
import { HostWorktrees } from '../workspace/HostWorktrees.js'
import { mountWorkspace } from '../workspace/mountWorkspace.js'
import { CLAUDE_CLI_TYPE, createProvider, providerIds } from './providers.js'

export interface HostSettings {
  name: string
  runner: string
  token: string
  maxConcurrent: number
  accepts: NonNullable<RunnerConfig['host']['accepts']>
  /** El id del provider con que corre las tareas (de `providers`). */
  provider: string
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
    provider: hostProvider(cfg),
  }
}

/** El provider del host: el que nombra `host.provider`, o la única entrada `type: claude-cli`. */
function hostProvider(cfg: RunnerConfig): string {
  const known = providerIds(cfg.providers)
  if (cfg.host.provider) {
    if (!known.includes(cfg.host.provider)) {
      throw new Error(
        `host.provider: "${cfg.host.provider}" no está en providers (hay: ${known.join(', ')})`,
      )
    }
    return cfg.host.provider
  }
  const clis = Object.entries(cfg.providers).filter(([, config]) => config.type === CLAUDE_CLI_TYPE)
  const [only] = clis
  if (clis.length === 1 && only) return only[0]
  throw new Error(
    `--host: nombrá con qué provider corre en host.provider (hay: ${known.join(', ')})`,
  )
}

export interface MountedHost {
  client: HostClient
  settings: HostSettings
  githubAuthMode: string
  /** El worktree de cada corrida, y el respaldo que barre lo que quedó (`sweep`). */
  worktrees: HostWorktrees
}

/** Cada cuánto barre los worktrees que quedaron en disco (además de al arrancar). */
export const SWEEP_INTERVAL_MS = 6 * 60 * 60_000

/** Lo que un host necesita, y nada más (ver arriba). */
export async function mountHost(
  cfg: RunnerConfig,
  opts: { workspaceDir?: string; log: (line: string) => void },
): Promise<MountedHost> {
  const settings = hostSettings(cfg)
  const github = await resolveGithubAuth()
  await verifyGithubAuth(github)
  // Una raíz propia (no la del runner): en una máquina con los dos, la misma task tendría el mismo
  // path y el host podría borrarle al runner un worktree en uso.
  const root = opts.workspaceDir ?? defaultHostWorkspaceRoot()
  const { session, workspace } = mountWorkspace({
    root,
    githubToken: () => github.auth.getToken(),
    log: opts.log,
  })
  const worktrees = new HostWorktrees({
    shell: new NodeShellRunner(),
    workspace,
    log: createLogger('ia-flow-runner-v2.host'),
    // Lo que armó el host: sólo eso se borra.
    ledgerPath: join(root, 'host-worktrees.json'),
  })
  const provider = createProvider(settings.provider, cfg.providers, {
    cwd: (ctx) => session.dirFor(ctx),
    log: opts.log,
  })
  const client = new HostClient({
    runnerUrl: settings.runner,
    token: settings.token,
    name: settings.name,
    maxConcurrent: settings.maxConcurrent,
    accepts: settings.accepts,
    run: providerTaskRunner({
      provider,
      session,
      gitCredential: () => github.auth.getToken(),
      log: opts.log,
      worktrees,
    }),
  })
  return { client, settings, githubAuthMode: github.mode, worktrees }
}

/**
 * Una tarea del runner, corrida con `provider` como la correría el runner: su `ProviderRunContext`
 * armado con lo que viajó, el worktree de la task en este disco, las tools del engine contra el
 * runner y las de workspace rearmadas acá (si el provider no trae las suyas). Devuelve lo que dio
 * el provider; si el runner la cierra (`signal`), el provider se corta.
 */
export function providerTaskRunner(opts: {
  provider: Provider
  session: WorkspaceSession
  gitCredential: WorkspaceToolDeps['gitCredential']
  log: (line: string) => void
  /** Quién arma el worktree de cada corrida y lo borra al terminar (`HostWorktrees`). Sin él, el
   *  worktree queda en disco. */
  worktrees?: Pick<HostWorktrees, 'begin' | 'end'>
  fetchImpl?: typeof fetch
}): TaskRunner {
  return async (task, runner, signal): Promise<RunResult> => {
    const ctx = contextOf(task)
    const prepare = () => opts.session.dirFor(ctx)
    const cwd = opts.worktrees ? await opts.worktrees.begin(prepare) : await prepare()
    const link = new RunnerLink({
      task,
      base: runner.base,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    })
    link.start()
    try {
      const tools = [
        ...link.tools(),
        ...(opts.provider.workspace === 'native'
          ? []
          : workspaceTools(task.workspaceTools, ctx, {
              session: opts.session,
              gitCredential: opts.gitCredential,
            })),
      ]
      const output = await opts.provider.run({
        agentId: task.agentId,
        prompt: task.prompt,
        systemPrompts: task.systemPrompts,
        variables: task.variables,
        providerConfig: task.providerConfig,
        mcpServers: task.mcpServers as McpServerRef[],
        tools,
        ctx,
        inbox: () => link.inbox(),
        saveConversation: (conversation) => link.saveConversation(conversation),
        onText: (delta) => link.onText(delta),
        ...(task.resume ? { resume: task.resume } : {}),
        signal,
      })
      opts.log(`${task.agentId}: ${opts.provider.id} terminó (${output.outcome})`)
      return { status: 'output', output }
    } finally {
      await link.stop()
      // Cómo cerró el modelo, si llamó una tool terminal; cortada por el runner, no cerró.
      await opts.worktrees?.end(cwd, signal.reason === CLOSED_BY_RUNNER ? undefined : link.ending)
    }
  }
}

/** Las tools de workspace del agente, rearmadas sobre el worktree de esta máquina. Una que el host
 *  no sabe rearmar (`run_agent`, una propia de un deploy) le contesta al modelo por qué no está. */
function workspaceTools(
  specs: WorkspaceToolSpec[],
  ctx: PipelineExecutionContext,
  deps: WorkspaceToolDeps,
): Tool[] {
  return specs.map(({ name, origin }) => {
    if (HOST_WORKSPACE_TOOLS.has(origin.action)) {
      const action = workspaceTool(origin.action, origin.options, deps)
      return action.asTool(ctx)
    }
    return unavailable(
      name,
      `${name} no corre en un host remoto (sólo ${[...HOST_WORKSPACE_TOOLS].join(', ')})`,
    )
  })
}

function unavailable(name: string, why: string): Tool {
  return {
    name,
    description: why,
    inputSchema: { type: 'object', properties: {} },
    workspace: true,
    handler: () => {
      throw new Error(why)
    },
  }
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
