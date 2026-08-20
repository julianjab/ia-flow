// Agent: owns the lifecycle of a single agent dispatch.
//   1. onStart  — marks the task as working in the task-source (setAgentWorking,
//                 onProcess).
//   2-4. runs   — calls the ai-provider (which owns its own tool-call loop —
//                 sync return, or an async tmux session awaited via
//                 waitForFinish) until it finishes or fails.
//   5. finalize — applies onFinish/onError per the outcome and records the
//                 execution log.
// AgentOrchestrator only resolves which agents apply to a task's status and
// loops calling `Agent.run` for each — this class is the "run one" part.
import { UpstreamAbortError } from '@ia-flow/ai-providers'
import type { PolicyLike, SessionHandle } from '@ia-flow/ai-providers'
import type { ITaskSource } from '@ia-flow/issue-sources'
import type {
  AgentDefinition,
  AgentToolEntry,
  McpServers,
  ProjectConfig,
  Task,
} from '@ia-flow/shared'
import { AgentLifecycle } from './AgentLifecycle.js'
import { type WorkspaceManager, hasWriteTools } from './WorkspaceManager.js'
import type {
  IBroadcast,
  IExecutionLogRepository,
  IMcpCatalogRepository,
  IProviderRegistry,
} from './contract.js'
import { safeInsertLog, safeUpdateLog } from './execution-log.js'
import { buildGitContext } from './git-context.js'
import {
  type LinkedBranchNamer,
  defaultLinkedBranchNamer,
  resolveLinkedBranch,
} from './linked-branch.js'
import { createLogger } from './logger.js'
import {
  getPendingTask,
  registerPendingTask,
  removePendingTask,
  waitForFinish,
} from './pending-tasks.js'
import type { RunContext } from './run-context.js'
import { watchSession } from './session-watchdog.js'
import { resolveSystemPromptBlocks } from './system-prompt-blocks.js'
import { type ResolveVariable, resolveVariables } from './variable-resolver.js'
import { resolveWorkspaceScopes } from './workspace-scopes.js'

const log = createLogger('agent')

/** Host-owned policy compiler (packages/tools's policy.ts — coupled to the
 *  tool registry, which is apps/server-internal to wire). Injected so this
 *  package never imports the tools engine directly. */
export type CompilePolicy = (input: { tools?: AgentToolEntry[] }) => PolicyLike | undefined

export interface AgentRunInput {
  task: Task
  /** El agente elegido por `selectAgent` — trae su prompt, provider y outcomes. */
  agentDef: AgentDefinition
  manager: ITaskSource
  config: ProjectConfig
  /** Repo layout resuelto por `resolveRunContext` — reemplaza los campos
   *  sueltos (`projectRepos`/`repoPaths`/`primaryPath`/...) que antes se
   *  threadeaban uno por uno; `run` los saca de acá. */
  runCtx: RunContext
}

/**
 * Mutated in place by `run` so a terminal-worktree run is still visible to
 * the orchestrator's cleanup even when `run` throws — su `finally` lo
 * necesita sin importar por qué salida terminó el run. Mirrors the
 * outer-scope variable AgentOrchestrator used to mutate directly before this
 * class existed.
 */
export interface AgentRunState {
  terminalWorktreeBranch?: string
}

// Replaces ${VAR} placeholders in every string value inside an McpServers map
// with the matching Bun.env entry. Empty / unset vars collapse to '', so the
// downstream provider sees a literal Authorization header without the token,
// which fails loudly at the API instead of leaking a raw placeholder.
function interpolateMcpServers(servers: McpServers): McpServers {
  const walk = (val: unknown): unknown => {
    if (typeof val === 'string')
      return val.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, name) => Bun.env[name] ?? '')
    if (Array.isArray(val)) return val.map(walk)
    if (val && typeof val === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(val)) out[k] = walk(v)
      return out
    }
    return val
  }
  return walk(servers) as McpServers
}

export class Agent {
  constructor(
    private providers: IProviderRegistry,
    private broadcast: IBroadcast,
    private mcpCatalogRepo?: IMcpCatalogRepository,
    private executionLogRepo?: IExecutionLogRepository,
    private workspaceManager?: WorkspaceManager,
    private compilePolicyPort?: CompilePolicy,
    private linkedBranchNamer: LinkedBranchNamer = defaultLinkedBranchNamer,
    private resolveVariable: ResolveVariable = () => undefined,
  ) {}

  resolveMcpCatalog(agentDef: {
    id?: string
    mcpCatalogIds?: string[]
    providerConfig?: Record<string, unknown>
  }): Record<string, unknown> | undefined {
    const ids = agentDef.mcpCatalogIds ?? []
    if (!ids.length || !this.mcpCatalogRepo) return agentDef.providerConfig
    const merged: McpServers = {}
    for (const id of ids) {
      const entry = this.mcpCatalogRepo.get(id)
      if (!entry) {
        log.warn({ agentId: agentDef.id, mcpId: id }, 'MCP catalog entry not found — skipping')
        continue
      }
      merged[entry.id] = entry.config
    }
    // Inline mcpServers (per-agent overrides) take precedence over catalog entries.
    const inlineServers = (agentDef.providerConfig?.mcpServers as McpServers | undefined) ?? {}
    const mcpServers: McpServers = interpolateMcpServers({ ...merged, ...inlineServers })
    if (!Object.keys(mcpServers).length) return agentDef.providerConfig
    return { ...(agentDef.providerConfig ?? {}), mcpServers }
  }

  /**
   * Runs one agent dispatch end-to-end. Returns the updated task on every
   * normal exit path (cancelled, upstream-abort, truncated, moved-by-tool,
   * success). Throws only for a genuine failure (after applying onError) so
   * the orchestrator's chain stops — matching the pre-extraction behaviour
   * where such an error propagated out of `runAgent`.
   */
  async run(input: AgentRunInput, runState: AgentRunState): Promise<Task> {
    const { agentDef, manager, config, runCtx } = input
    const { projectRepos, repoPaths, primaryPath, primaryRepoName, primaryWorkflow } = runCtx
    let task = input.task
    const lifecycle = new AgentLifecycle(manager, this.broadcast)

    // PASO 1 — onStart: actualiza el task-source antes de llamar al provider.
    task = await lifecycle.start(task, agentDef)

    // Snapshot the pre-run status so both the success and error branches
    // below can decide whether a tool call already moved the task (in
    // which case we don't clobber it with onFinish/onError). This is
    // captured AFTER onProcess above, on purpose — it seeds both
    // `pending.initialStatus` (frozen — see registerPendingTask below and
    // its field doc in pending-tasks.ts) and `pending.reconciliationStatus`
    // (mutable, resynced by set_task_field mid-run). Capturing it post-
    // onProcess means SourceIssueManager's divergence-reconciliation loop
    // (packages/issue-sources/src/dispatch/source-issue-manager.ts), which
    // compares `reconciliationStatus` against the source's live status
    // every scan cycle, can never see this run's own onProcess as "drift" —
    // load-bearing ordering, see the comment on that loop.
    const initialStatus = task.status
    // Single correlation id per run: used as the execution_logs PK and
    // handed to the provider so every log line for this run carries the
    // same `runId`.
    const runId = crypto.randomUUID().slice(0, 8)
    const logId = runId
    // Declared outside the try so the catch below can read
    // `controller.signal.aborted` to disambiguate our manual cancel from an
    // upstream abort.
    const controller = new AbortController()

    try {
      // PASOS 2-4 — arma el ProviderInput y llama al ai-provider (que posee
      // su propio loop de tool-calls) hasta que termina o falla.
      const projectContext: Record<string, string> = {
        ...((config.project as Record<string, string> | undefined) ?? {}),
        ...(manager.getProjectContext?.() ?? {}),
      }
      const resolvedPrompt = resolveVariables(
        agentDef.prompt,
        { task, variables: agentDef.variables, project: projectContext, projectRepos },
        this.resolveVariable,
      )

      const systemPromptBlocks = resolveSystemPromptBlocks(agentDef, config)

      const provider = this.providers.get(agentDef.provider)
      // Git context de motor: preprendemos un bloque markdown al prompt del
      // agente indicando qué branch/worktree/repo tiene disponible, así los
      // prompts de agentes NO deciden nombre de branch ni si crear worktree.
      // buildGitContext recibe el IAgentProvider completo y decide la rama de
      // comportamiento por provider.kind (sync/async), no por su id.
      const sourceToolContext = manager.getSourceToolContext?.()

      // Auto-link branch (see resolveLinkedBranch for the gating rules).
      task = await resolveLinkedBranch({
        task,
        agentDef,
        manager,
        linkedBranchNamer: this.linkedBranchNamer,
      })

      const {
        repoPaths: effectiveRepoPaths,
        writePaths: effectiveWritePaths,
        branch: resolvedBranch,
      } = await resolveWorkspaceScopes({
        workspaceManager: this.workspaceManager,
        agentDef,
        task,
        primaryPath,
        primaryRepoName,
        repoPaths,
        runId,
      })
      // WorkspaceManager es dueño de nombrar el branch (linked branch de
      // GitHub si `resolveLinkedBranch` ya lo seteó, o su propio fallback
      // `task/<id>`) — lo reflejamos de vuelta en el Task, igual que ya hace
      // `resolveLinkedBranch` un poco más arriba.
      if (resolvedBranch) task = { ...task, branch: resolvedBranch }
      // Nota: terminal providers materializan su propio worktree en
      // `terminal-base` usando la misma convención de WorkspaceManager
      // (`/tmp/ia-flow/<repo>/.worktrees/<taskId>` + branch `task.branch`).

      // Prepend engine-provided git context to the resolved prompt.
      const gitContext = await buildGitContext({
        taskId: task.id,
        provider,
        cwd: primaryPath,
        workflow: primaryWorkflow,
        worktreePath: effectiveWritePaths?.[0],
        hasWriteAccess: hasWriteTools({ tools: agentDef.tools }),
        branch: task.branch,
      })
      const finalPrompt = gitContext ? `${gitContext}\n\n${resolvedPrompt}` : resolvedPrompt

      // Cancellation plumbing: the polling manager calls entry.cancel() when
      // it detects the source-side status has drifted from the one at
      // dispatch time (manual gate). For sync providers we abort the fetch;
      // for tmux we kill the session once it's known.

      // Register before run so in-process tools can resolve the manager
      registerPendingTask(task.id, {
        task,
        manager,
        onFinish: agentDef.onFinish,
        onError: agentDef.onError,
        broadcast: (msg: object) => this.broadcast.send(msg),
        initialStatus,
        // Starts equal to initialStatus, but unlike it gets resynced by
        // set_task_field when the agent moves its own task mid-run — see
        // the field doc on PendingTask.reconciliationStatus.
        reconciliationStatus: initialStatus,
        runId,
        agentId: agentDef.id,
        agentName: agentDef.id,
        projectId: task.projectId,
        cancel: async () => {
          const entryPending = getPendingTask(task.id)
          if (entryPending) entryPending.cancelled = true
          controller.abort()
          try {
            await entryPending?.killSession?.()
          } catch {}
          try {
            await manager.setAgentWorking(task, false)
          } catch {}
        },
      })

      safeInsertLog(this.executionLogRepo, {
        id: logId,
        projectId: task.projectId ?? '',
        taskId: task.id,
        taskTitle: task.title,
        agentId: agentDef.id,
        providerId: agentDef.provider,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        outcome: null,
        errorMsg: null,
        stopReason: null,
      })

      const output = await provider.run({
        step: 'implement',
        agentId: agentDef.id,
        projectId: task.projectId,
        runId,
        taskId: task.id,
        taskTitle: task.title,
        taskDescription: task.description,
        taskType: task.type,
        repos: task.repos,
        repoPaths: effectiveRepoPaths,
        prompt: finalPrompt,
        systemPromptBlocks,
        // Async/terminal providers render this as a curl appendix (they don't
        // consume `policy`), so they only need the plain tool names.
        tools: agentDef.tools?.map((t) => (typeof t === 'string' ? t : t.name)),
        providerConfig: this.resolveMcpCatalog(agentDef),
        sourceToolContext,
        cwd: primaryPath,
        workflow: primaryWorkflow,
        branch: task.branch,
        writePaths: effectiveWritePaths,
        policy: this.compilePolicyPort?.({ tools: agentDef.tools }),
        signal: controller.signal,
      })

      // Track terminal worktree runs so the orchestrator's finally block can
      // attempt cleanup. Captured now (before waitForFinish mutates `task`).
      if (output.mode === 'tmux' && primaryWorkflow === 'worktree') {
        runState.terminalWorktreeBranch = task.branch?.trim() || `task/${task.id}`
      }

      // PASO 5 — finaliza según el resultado.
      if (output.mode === 'tmux') {
        // Wire the provider-agnostic session handle: persist its coordinates
        // so the row in execution_logs can be looked up / cancelled later,
        // register close() as killSession, and start a liveness watchdog
        // that finalizes the run if the user closes the tab manually.
        let sessionHandle: SessionHandle | undefined
        let unwatchSessionLocal: (() => void) | undefined
        if (output.session) {
          const handle = output.session
          sessionHandle = handle
          const entryPending = getPendingTask(task.id)
          if (entryPending) {
            entryPending.killSession = () => handle.close()
            const unwatch = watchSession(handle, () => {
              log.warn(
                { taskId: task.id, sessionKind: handle.kind, sessionId: handle.id },
                'Session died before agent finalized — cancelling run',
              )
              removePendingTask(task.id, { cancelled: true })
              manager.setAgentWorking(task, false).catch(() => {})
            })
            entryPending.unwatchSession = unwatch
            unwatchSessionLocal = unwatch
          }
          try {
            this.executionLogRepo?.update(logId, { sessionKind: handle.kind, sessionId: handle.id })
          } catch (logErr) {
            log.warn({ err: logErr }, 'Failed to persist session metadata to execution log')
          }
        }
        log.info(
          { taskId: task.id, sessionKind: output.session?.kind, sessionId: output.session?.id },
          'async session started — awaiting tool callback',
        )

        // Block until the agent actually finishes (via complete_task /
        // fail_task / cancel) so the orchestrator's loop can't start a
        // second agent's session in parallel on the same task.
        const finish = await waitForFinish(task.id)
        unwatchSessionLocal?.()
        if (sessionHandle && !finish?.cancelled) {
          try {
            await sessionHandle.close()
          } catch (closeErr) {
            log.warn(
              { err: closeErr, sessionKind: sessionHandle.kind, sessionId: sessionHandle.id },
              'Failed to close terminal session after run finished',
            )
          }
        }
        if (finish) {
          task = finish.task
          if (finish.cancelled) {
            log.info(
              { taskId: task.id, agent: agentDef.id },
              'Async agent run cancelled — skipping transition',
            )
            safeUpdateLog(this.executionLogRepo, logId, {
              finishedAt: new Date().toISOString(),
              outcome: 'cancelled',
            })
            return task
          }
          // complete_task / fail_task have already applied their transitions
          // and cleared the working flag; the only remaining job is to
          // record success in the execution log.
          safeUpdateLog(this.executionLogRepo, logId, {
            finishedAt: new Date().toISOString(),
            outcome: 'success',
            stopReason: output.stopReason,
          })
        }
      } else {
        // Sync (API) — pick up any task mutations from in-process tool calls, then clean up
        const pendingAfterRun = getPendingTask(task.id)
        const cancelled = pendingAfterRun?.cancelled === true
        const finalizedByTool = pendingAfterRun === undefined
        task = pendingAfterRun?.task ?? task
        removePendingTask(task.id)

        if (cancelled) {
          log.info(
            { taskId: task.id, agent: agentDef.id },
            'Agent run cancelled — skipping transition',
          )
          safeUpdateLog(this.executionLogRepo, logId, {
            finishedAt: new Date().toISOString(),
            outcome: 'cancelled',
          })
          return task
        }

        // If a tool call moved the task while the loop ran, respect that
        // decision — the default onFinish/onError would clobber it.
        const freshPostStatus = (await manager.getCurrentStatus?.(task)) ?? task.status
        if (freshPostStatus !== task.status) {
          task = { ...task, status: freshPostStatus }
        }
        if (finalizedByTool || task.status.toLowerCase() !== initialStatus.toLowerCase()) {
          log.info(
            { taskId: task.id, agent: agentDef.id, from: initialStatus, to: task.status },
            'Task moved by tool call during run — skipping default transition',
          )
          safeUpdateLog(this.executionLogRepo, logId, {
            finishedAt: new Date().toISOString(),
            outcome: 'success',
            stopReason: output.stopReason,
          })
          try {
            await manager.setAgentWorking(task, false)
          } catch {}
          return task
        }

        task = await manager.setAgentWorking(task, false)

        if (output.truncated) {
          // Recoverable pause (task budget exhausted or safety cap). Don't
          // run onFinish — post a progress notice and, if there's an
          // onError transition, use it to revert so the user can retry.
          log.warn(
            { taskId: task.id, agent: agentDef.id, stopReason: output.stopReason ?? 'unknown' },
            'Agent run truncated — posting pause notice',
          )
          safeUpdateLog(this.executionLogRepo, logId, {
            finishedAt: new Date().toISOString(),
            outcome: 'truncated',
            stopReason: output.stopReason,
          })
          const notice = [
            `# ${agentDef.id} · 🟡 pausado`,
            '',
            `**Razón**: ${output.stopReason ?? 'unknown'}`,
            '',
            'Avancé pero no terminé. Los cambios ya aplicados quedan persistidos.',
            'Mueve la tarea al status anterior para continuar.',
          ].join('\n')
          await manager.postComment?.(task, notice)
          task = await lifecycle.fail(task, agentDef, `truncated:${output.stopReason ?? 'unknown'}`)
        } else if (agentDef.onFinish) {
          safeUpdateLog(this.executionLogRepo, logId, {
            finishedAt: new Date().toISOString(),
            outcome: 'success',
            stopReason: output.stopReason,
          })
          task = await lifecycle.end(task, agentDef)
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      const pendingEntry = getPendingTask(task.id)
      // Authoritative signal for "we cancelled it ourselves": the polling
      // divergence gate and graceful shutdown both go through entry.cancel().
      const explicitlyCancelled = pendingEntry?.cancelled === true || controller.signal.aborted
      // Upstream abort: the provider's fetch died on its own with no user
      // cancel involved.
      const upstreamAbort = err instanceof UpstreamAbortError && !explicitlyCancelled
      task = pendingEntry?.task ?? task
      removePendingTask(task.id)

      if (explicitlyCancelled) {
        log.info(
          {
            event: 'agent.cancelled',
            taskId: task.id,
            agent: agentDef.id,
            runId,
            reason: 'status-divergence',
          },
          'Agent run cancelled by status divergence',
        )
        safeUpdateLog(this.executionLogRepo, logId, {
          finishedAt: new Date().toISOString(),
          outcome: 'cancelled',
        })
        return task
      }

      if (upstreamAbort) {
        log.warn(
          {
            event: 'agent.aborted',
            taskId: task.id,
            agent: agentDef.id,
            runId,
            reason: 'upstream-abort',
            err: errMsg,
          },
          'Agent run aborted by upstream API (network/stream stall)',
        )
        safeUpdateLog(this.executionLogRepo, logId, {
          finishedAt: new Date().toISOString(),
          outcome: 'cancelled',
          errorMsg: `upstream-abort: ${errMsg}`,
        })
        try {
          task = await manager.setAgentWorking(task, false)
        } catch {}
        return task
      }

      // If a tool already moved the task before the throw, respect it —
      // don't re-apply onError on top of the intentional destination.
      try {
        const freshErrStatus = await manager.getCurrentStatus?.(task)
        if (freshErrStatus && freshErrStatus !== task.status) {
          task = { ...task, status: freshErrStatus }
        }
      } catch {
        // Fresh read failed (network, auth, …) — fall back to the in-memory
        // status rather than swallow the original throw with a secondary one.
      }
      if (task.status.toLowerCase() !== initialStatus.toLowerCase()) {
        log.info(
          { taskId: task.id, from: initialStatus, to: task.status, err: errMsg },
          'Task moved by tool call before error surfaced — skipping onError',
        )
        safeUpdateLog(this.executionLogRepo, logId, {
          finishedAt: new Date().toISOString(),
          outcome: 'error',
          errorMsg: errMsg,
        })
        try {
          await manager.setAgentWorking(task, false)
        } catch {}
        throw err
      }

      log.error(
        { event: 'agent.error', taskId: task.id, agent: agentDef.id, err: errMsg },
        'Agent run failed',
      )
      safeUpdateLog(this.executionLogRepo, logId, {
        finishedAt: new Date().toISOString(),
        outcome: 'error',
        errorMsg: errMsg,
      })
      task = await manager.setAgentWorking(task, false)
      if (agentDef.onError) {
        await manager.postError?.(task, errMsg)
      }
      task = await lifecycle.fail(task, agentDef, errMsg)
      throw err
    }

    return task
  }
}
