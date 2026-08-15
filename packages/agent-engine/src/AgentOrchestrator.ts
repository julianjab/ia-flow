import { join } from 'path'
import type { PolicyLike, SessionHandle } from '@ia-flow/ai-providers'
import { UpstreamAbortError } from '@ia-flow/ai-providers'
import { createLinkedBranch } from '@ia-flow/issue-sources'
import type { ITransitionManager } from '@ia-flow/issue-sources'
import type { McpServers, Permission, PermissionPresetId, Task } from '@ia-flow/shared'
import { type WorkspaceManager, hasWriteTools } from './WorkspaceManager.js'
import type {
  IBroadcast,
  IExecutionLogRepository,
  IMcpCatalogRepository,
  IProjectConfigRepository,
  IProviderRegistry,
  IRepoRepository,
  IToolRegistry,
} from './contract.js'
import { buildGitContext } from './git-context.js'
import { createLogger } from './logger.js'
import { applyOutcome, evalWhen } from './outcomes.js'
import {
  getPendingTask,
  registerPendingTask,
  removePendingTask,
  waitForFinish,
} from './pending-tasks.js'
import { watchSession } from './session-watchdog.js'
import { type ResolveVariable, resolveVariables } from './variable-resolver.js'

const log = createLogger('agent-orchestrator')

/** Host-owned policy compiler (apps/server's application/policy.ts — coupled
 *  to the tool registry + permission presets, both apps/server-internal).
 *  Injected so this package never imports the tools engine directly. */
export type CompilePolicy = (input: {
  presetId?: PermissionPresetId
  permissions?: Permission[]
}) => PolicyLike | undefined

export interface BranchNamerTaskLike {
  id: string
  title: string
  description?: string
  type?: string
}

/** Host-owned linked-branch namer (apps/server's application/branch-namer.ts
 *  — calls the Anthropic API directly and reads a system prompt from the DB).
 *  Injected for the same reason as `CompilePolicy`. Defaults to the
 *  deterministic `task/<id>` fallback branch-namer.ts itself falls back to,
 *  so omitting the port doesn't change behaviour when nothing needs it. */
export type LinkedBranchNamer = (task: BranchNamerTaskLike) => Promise<string>

const defaultLinkedBranchNamer: LinkedBranchNamer = async (task) => `task/${task.id}`

const HOME = Bun.env.HOME ?? ''
function expandHome(p: string): string {
  return p.startsWith('~/') ? join(HOME, p.slice(2)) : p
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

export class AgentOrchestrator {
  constructor(
    private providers: IProviderRegistry,
    private tools: IToolRegistry,
    private configRepo: IProjectConfigRepository,
    private repoRepo: IRepoRepository,
    private broadcast: IBroadcast,
    private mcpCatalogRepo?: IMcpCatalogRepository,
    private executionLogRepo?: IExecutionLogRepository,
    // WorkspaceManager is optional so existing tests (which build the
    // orchestrator with a minimal fixture) keep working; when absent the
    // orchestrator falls back to the pre-#35 behaviour — no worktree, no
    // writePaths, no per-task lock. The container wires the real one.
    private workspaceManager?: WorkspaceManager,
    // Host-owned ports (composable-engine refactor, Phase 3): policy.ts and
    // branch-namer.ts stay in apps/server (coupled to the tool registry /
    // permission presets and the DB-backed system-prompt lookup
    // respectively), so this package can't import them directly. Both are
    // optional with behavior-preserving defaults — omitting them just means
    // no policy gets compiled / the deterministic `task/<id>` branch name is
    // used, exactly like before an agent opted into either feature.
    private compilePolicyPort?: CompilePolicy,
    private linkedBranchNamer: LinkedBranchNamer = defaultLinkedBranchNamer,
    // Variable substitution ({{task.title}}, {{project.repos}}, …) is
    // resolved by apps/server's variables/ subsystem (system/task/project/
    // custom groups) — injected here for the same reason. Defaulting to
    // "no known variables" leaves `{{...}}` placeholders untouched, matching
    // `resolveVariables`' own behaviour for any variable it can't resolve.
    private resolveVariable: ResolveVariable = () => undefined,
  ) {}

  private resolveMcpCatalog(agentDef: {
    mcpCatalogIds?: string[]
    providerConfig?: Record<string, unknown>
  }): Record<string, unknown> | undefined {
    const ids = agentDef.mcpCatalogIds ?? []
    if (!ids.length || !this.mcpCatalogRepo) return agentDef.providerConfig
    const merged: McpServers = {}
    for (const id of ids) {
      const entry = this.mcpCatalogRepo.get(id)
      if (!entry) {
        log.warn(
          { agentId: (agentDef as { id?: string }).id, mcpId: id },
          'MCP catalog entry not found — skipping',
        )
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

  async runAgent(task: Task, manager: ITransitionManager): Promise<boolean> {
    // Scope the config lookup to the task's project when known — matches how
    // TaskDispatcher fetched it. Legacy callers without projectId fall back to
    // the default project (SqliteProjectConfigRepo.getConfig undefined path).
    const config = await this.configRepo.getConfig(task.projectId)
    if (!config) return false

    const statusConfig = config.statuses?.find(
      (s) => s.name.toLowerCase() === task.status.toLowerCase(),
    )
    if (!statusConfig) return false

    // Collect all entries whose conditions match (or have no conditions = always runs)
    const matchingEntries = statusConfig.agents.filter((entry) =>
      evalWhen(task as Record<string, unknown>, entry.when),
    )

    if (!matchingEntries.length) {
      if (statusConfig.agents.length > 0) {
        const conditionsSummary = statusConfig.agents
          .filter((e) => e.when)
          .map((e) => {
            const when = e.when!
            const parts = Array.isArray(when)
              ? when.map(
                  (c, i) =>
                    `${i > 0 ? ` ${(c.logic ?? 'AND').toUpperCase()} ` : ''}${c.field}${c.op === '=' ? '=' : c.op === '!=' ? '≠' : ` ${c.op}`}${c.value ?? ''}`,
                )
              : Object.entries(when).map(([k, v]) => `${k}=${v}`)
            return `${e.agent}: ${parts.join(' ')}`
          })
          .join(' | ')
        log.debug(
          {
            status: task.status,
            conditions: conditionsSummary,
            taskId: task.id,
            projectId: task.projectId,
            title: task.title,
            type: task.type,
          },
          'No agent matched — skipping',
        )
      }
      return false
    }
    // All project repos → name→path map so fs tools can resolve any repo
    // in the project (not just those on the task). The agent learns names
    // via `{{project.repos}}` in its prompt and navigates via read_file /
    // list_dir / grep_files.
    const projectRepos = task.projectId
      ? this.repoRepo.listByProject(task.projectId)
      : this.repoRepo.list()
    const repoPaths: Record<string, string> = {}
    for (const r of projectRepos) {
      if (r.path) repoPaths[r.name] = expandHome(r.path)
    }
    // Repo resolution: task.repos[0] es el repo primario que maneja cwd/workflow.
    //   []           → sin refinar; primaryPath undefined; agents API corren,
    //                  terminal fallan (o caen a process.cwd si no se blindan).
    //   ['X', …]     → primer elemento maneja cwd; el resto es contexto extra
    //                  al que el agent puede acceder vía fs tools (repoPaths).
    // Multi-repo (épica) no se bloquea acá — WorkspaceManager sigue teniendo
    // su propio guard en resolveScopes si un agent con write tools intenta
    // operar sobre >1 repo.
    const primaryRepoName = task.repos[0]
    const primaryTaskRepo = primaryRepoName
      ? projectRepos.find((r) => r.name === primaryRepoName)
      : undefined
    if (primaryRepoName && !primaryTaskRepo) {
      log.error(
        { taskId: task.id, repo: primaryRepoName, projectId: task.projectId },
        'Task apunta a repo no registrado en el proyecto. Registrarlo en ia-flow o corregir el custom "Repos" del ProjectV2.',
      )
      return false
    }
    const primaryPath = primaryTaskRepo?.path ? expandHome(primaryTaskRepo.path) : undefined
    const primaryWorkflow = primaryTaskRepo?.workflow

    // ── Workspace lock scope ──────────────────────────────────────────
    // The chain uses the WorkspaceManager only when a) the manager is
    // wired (production always; tests opt-in) and b) at least one agent
    // in the chain runs on `anthropic-api` (the only provider that gets
    // the worktree sandbox — terminal providers stay on the base repo).
    // The lock covers the *entire* chain so a second dispatch on the same
    // task fails fast at `acquireTask` instead of racing with the running
    // one. Releasing lives in the outer `finally` at the bottom so every
    // exit path (success, per-agent throw, upstream abort) cleans up.
    const chainNeedsWorkspace = !!(
      this.workspaceManager &&
      primaryPath &&
      matchingEntries.some((entry) => {
        const def = config.agents?.find((a) => a.id === entry.agent)
        return def?.provider === 'anthropic-api'
      })
    )
    let workspaceLockHeld = false
    if (chainNeedsWorkspace) {
      // May throw `task <id> ya está corriendo` — that's the intended
      // signal to the caller (e.g. a raced dispatcher), so propagate.
      this.workspaceManager!.acquireTask(task.id, primaryPath!)
      workspaceLockHeld = true
    }

    // Track whether a terminal (async) agent ran with workflow=worktree so
    // the finally block can attempt cleanup. Declared outside `try` so the
    // finally can always read it regardless of which exit path we take.
    let terminalWorktreeBranch: string | undefined

    try {
      // Run each matching agent in sequence
      for (const entry of matchingEntries) {
        // Between iterations: if a previous agent (or a tool it called) moved
        // the task out of the status that produced this chain, the remaining
        // agents were selected for a status that no longer applies — stop
        // here and let the next poll cycle re-evaluate against the new status.
        // Fresh-read from the source so we don't act on a stale in-memory
        // status that a prior tool wrote back through a mis-normalized field.
        const freshMidStatus = (await manager.getCurrentStatus?.(task)) ?? task.status
        if (freshMidStatus !== task.status) {
          task = { ...task, status: freshMidStatus }
        }
        if (task.status.toLowerCase() !== statusConfig.name.toLowerCase()) {
          log.info(
            {
              taskId: task.id,
              chainStatus: statusConfig.name,
              currentStatus: task.status,
              skippedAgent: entry.agent,
            },
            'Task status drifted mid-chain — skipping remaining agents',
          )
          break
        }

        const agentDef = config.agents?.find((a) => a.id === entry.agent)
        if (!agentDef) {
          log.error({ agent: entry.agent }, 'Agent not found in agents registry')
          continue
        }

        task = await manager.setAgentWorking(task, true)
        if (entry.onProcess) {
          task = await applyOutcome(task, entry.onProcess, manager)
        }
        // `$labels:` sibling. Kept as a separate applyOutcome call — not
        // concatenated with `$set:` — so the outcomes runtime can route it
        // through a labels-specific manager path (see sub-issue #47) without
        // parser sniffing. No-op when the entry doesn't declare label ops.
        if (entry.onProcessLabels) {
          task = await applyOutcome(task, entry.onProcessLabels, manager)
        }
        this.broadcast.send({ type: 'task:updated', task })

        // Snapshot the pre-run status so both the success and error branches
        // below can decide whether a tool call already moved the task (in
        // which case we don't clobber it with onFinish/onError).
        const initialStatus = task.status
        // Single correlation id per run: used as the execution_logs PK and
        // handed to the provider so every log line for this run carries the
        // same `runId`. Short form matches what the anthropic-api provider
        // used to generate locally.
        const runId = crypto.randomUUID().slice(0, 8)
        const logId = runId
        // Declared outside the try so the catch below can read
        // `controller.signal.aborted` to disambiguate our manual cancel from an
        // upstream abort. Being block-scoped to the try (previous shape) threw a
        // ReferenceError inside the catch and swallowed the original error,
        // leaving execution_logs rows open forever.
        const controller = new AbortController()

        try {
          const projectContext: Record<string, string> = {
            ...((config.project as Record<string, string> | undefined) ?? {}),
            ...(manager.getProjectContext?.() ?? {}),
          }
          const resolvedPrompt = resolveVariables(
            agentDef.prompt,
            {
              task,
              variables: agentDef.variables,
              project: projectContext,
              projectRepos,
            },
            this.resolveVariable,
          )

          const systemPromptBlocks = (agentDef.systemPrompts ?? [])
            .map((id) => config.systemPrompts?.find((sp) => sp.id === id))
            .filter((sp): sp is NonNullable<typeof sp> => sp !== undefined)
            .map((sp) => ({ type: 'text' as const, text: sp.text }))

          const provider = this.providers.get(agentDef.provider)
          // Git context de motor: preprendemos un bloque markdown al prompt
          // del agente indicando qué branch/worktree/repo tiene disponible,
          // así los prompts de agentes NO deciden nombre de branch ni si crear
          // worktree. Se calcula acá para que ambos providers (anthropic-api
          // y terminal) reciban la misma información — el terminal ya no arma
          // su propio gitContext.
          const gitCtxProvider =
            agentDef.provider === 'anthropic-api' ? 'anthropic-api' : 'terminal'
          // Tool instructions used to be assembled here and prepended to the
          // prompt. That responsibility now lives in the terminal provider
          // (see terminal-provider-base.buildToolsAppendix) so anthropic-api
          // stays lean and each provider owns its own contract.
          const sourceToolContext = manager.getSourceToolContext?.()

          // ── Per-agent workspace scope resolution ────────────────────
          // Only anthropic-api gets the WorkspaceManager sandbox: it's the
          // sync provider that runs tools inside `ToolContext` and honours
          // `writePaths`. Terminal providers keep the base repo path — they
          // exec commands directly in `cwd`.
          //
          // Read-only agents (no write tools) still call `resolveScopes` so
          // they *see* the worktree if a builder created one earlier in the
          // chain (visibility invariant): the second agent inherits the
          // worktree as read-only, no extra config. When no worktree exists
          // yet, resolveScopes returns the base repo path — cheap fallback.
          // Auto-link branch: aplica a CUALQUIER provider (anthropic-api o
          // terminal). Gate:
          //   - explícito: agentDef.requiresBranch (toggle en la UI).
          //   - default: derivado de hasWriteTools (agentes con
          //     write_file/edit_file/run_command). Cubre el caso más común
          //     sin obligar a marcar el toggle en cada agente builder.
          // Solo dispara cuando el source expone getLinkedBranchRef (adapter
          // GitHub) y aún no hay task.branch. Providers terminal reciben la
          // branch resuelta vía ProviderInput.branch y terminal-base la usa
          // en `claude --worktree <branch>` / `git checkout -b <branch>`.
          const agentNeedsBranch =
            agentDef.requiresBranch ?? hasWriteTools({ tools: agentDef.tools })
          if (agentNeedsBranch && !task.branch) {
            const ref = manager.getLinkedBranchRef?.(task)
            if (ref) {
              const proposed = await this.linkedBranchNamer({
                id: task.id,
                title: task.title,
                description: task.description,
                type: task.type,
              })
              try {
                const result = await createLinkedBranch(
                  ref.issueNodeId,
                  proposed,
                  ref.owner,
                  ref.repoName,
                )
                task = { ...task, branch: result.name }
                log.info(
                  {
                    taskId: task.id,
                    branch: result.name,
                    created: result.created,
                    provider: agentDef.provider,
                  },
                  'Linked branch resolved for agent',
                )
              } catch (err) {
                log.warn(
                  { err, taskId: task.id, proposed },
                  'createLinkedBranch failed — falling back to task/<id> for this run',
                )
              }
            }
          }

          let effectiveRepoPaths = repoPaths
          let effectiveWritePaths: string[] | undefined
          if (
            this.workspaceManager &&
            agentDef.provider === 'anthropic-api' &&
            primaryPath &&
            primaryRepoName
          ) {
            const wsm = this.workspaceManager
            const agentToolNames = agentDef.tools
            // Materialize the worktree only when the agent has write tools —
            // read-only agents don't create it, they just inherit it if it
            // exists. Recording the runId here lets the next reuse tag its
            // autosalvage commit with the previous run's id.
            let worktreePath: string | undefined
            if (hasWriteTools({ tools: agentToolNames })) {
              worktreePath = await wsm.getOrCreateWorktree(task.id, primaryPath, {
                branch: task.branch,
              })
              wsm.recordRunId(task.id, runId)
            }
            const worktreeExists = wsm.worktreeExistsOnDisk(task.id, primaryPath)
            const scopes = wsm.resolveScopes(
              { id: task.id, repos: task.repos },
              { tools: agentToolNames },
              { repoBasePath: primaryPath, worktreeExists, worktreePath },
            )
            effectiveRepoPaths = {
              ...repoPaths,
              [primaryRepoName]: scopes.readPaths[0],
            }
            effectiveWritePaths = scopes.writePaths
          }
          // Nota: terminal providers materializan su propio worktree en
          // `terminal-base` usando la misma convención de WorkspaceManager
          // (`/tmp/ia-flow/<repo>/.worktrees/<taskId>` + branch `task.branch`).
          // El orquestador solo pasa `task.branch` — no gestiona git para
          // async providers, así se mantiene lean.

          // Prepend engine-provided git context to the resolved prompt.
          // Only for step 'implement' (refiners/reviewers don't need it).
          const gitContext = await buildGitContext({
            taskId: task.id,
            provider: gitCtxProvider,
            cwd: primaryPath,
            workflow: primaryWorkflow,
            worktreePath: effectiveWritePaths?.[0],
            hasWriteAccess: hasWriteTools({ tools: agentDef.tools }),
            branch: task.branch,
          })
          const finalPrompt = gitContext ? `${gitContext}\n\n${resolvedPrompt}` : resolvedPrompt

          // Cancellation plumbing: the polling manager calls entry.cancel()
          // when it detects the source-side status has drifted from the one at
          // dispatch time (manual gate). For sync providers we abort the fetch;
          // for tmux we kill the session once it's known.

          // Register before run so in-process tools can resolve the manager
          registerPendingTask(task.id, {
            task,
            manager,
            onFinish: entry.onFinish,
            onError: entry.onError,
            broadcast: (msg: object) => this.broadcast.send(msg),
            initialStatus,
            runId,
            agentId: agentDef.id,
            agentName: agentDef.id,
            projectId: task.projectId,
            cancel: async () => {
              const entryPending = getPendingTask(task.id)
              if (entryPending) entryPending.cancelled = true
              controller.abort()
              // Kill the provider session too (tmux only wires this; anthropic
              // relies on the abort above). No-op if not set.
              try {
                await entryPending?.killSession?.()
              } catch {}
              // Clear the working flag so the task is picked up again at its
              // new status (or moved manually to Blocked).
              try {
                await manager.setAgentWorking(task, false)
              } catch {}
            },
          })

          try {
            this.executionLogRepo?.insert({
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
          } catch (logErr) {
            log.warn({ err: logErr }, 'Failed to insert execution log')
          }

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
            tools: agentDef.tools,
            // Per-agent opt-out: names in this array are removed from the tool
            // set before `tools[]` filtering runs, both in the anthropic-api
            // provider (via `getToolDefinitions({ disabledTools })`) and in the
            // terminal providers' curl appendix (see terminal-base.base.ts).
            disabledTools: agentDef.disabledTools,
            providerConfig: this.resolveMcpCatalog(agentDef),
            sourceToolContext,
            cwd: primaryPath,
            workflow: primaryWorkflow,
            branch: task.branch,
            // Absolute paths write/edit/exec tools may touch. Populated only
            // for anthropic-api runs (WorkspaceManager sandbox); undefined
            // otherwise → write tools refuse.
            writePaths: effectiveWritePaths,
            // Compiled permission policy (issue #58). Only built when the
            // agent opted into the new DSL (`permissions[]` or `presetId`).
            // When absent, providers/tools fall back to
            // LEGACY_DEFAULT_POLICY so pre-issue-58 agents keep exactly
            // their historical whitelist + git rules.
            policy:
              (agentDef.permissions || agentDef.presetId) && this.compilePolicyPort
                ? this.compilePolicyPort({
                    presetId: agentDef.presetId,
                    permissions: agentDef.permissions,
                  })
                : undefined,
            signal: controller.signal,
          })

          // Track terminal worktree runs so the finally block can attempt
          // cleanup. Only set when the step is implement + worktree workflow +
          // the provider is async (terminal). We capture the branch name now
          // (before waitForFinish mutates `task`) so it's available in finally.
          if (output.mode === 'tmux' && primaryWorkflow === 'worktree') {
            terminalWorktreeBranch = task.branch?.trim() || `task/${task.id}`
          }

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
                    {
                      taskId: task.id,
                      sessionKind: handle.kind,
                      sessionId: handle.id,
                    },
                    'Session died before agent finalized — cancelling run',
                  )
                  // Resolve the async waiter with cancelled=true. The
                  // orchestrator's post-waitForFinish branch will then write
                  // outcome=cancelled to execution_logs and skip transitions.
                  // Also clear the working flag so the task is picked up on the
                  // next dispatcher tick.
                  removePendingTask(task.id, { cancelled: true })
                  manager.setAgentWorking(task, false).catch(() => {})
                })
                entryPending.unwatchSession = unwatch
                unwatchSessionLocal = unwatch
              }
              try {
                this.executionLogRepo?.update(logId, {
                  sessionKind: handle.kind,
                  sessionId: handle.id,
                })
              } catch (logErr) {
                log.warn({ err: logErr }, 'Failed to persist session metadata to execution log')
              }
            }
            log.info(
              {
                taskId: task.id,
                sessionKind: output.session?.kind,
                sessionId: output.session?.id,
              },
              'async session started — awaiting tool callback',
            )

            // Block the chain-runner until the agent actually finishes (via
            // complete_task / fail_task / cancel). Without this the `for` loop
            // would immediately start the next agent's tmux session in parallel
            // on the same task, and status-drift checks would never see the
            // mutation the still-running agent is about to apply.
            const finish = await waitForFinish(task.id)
            // Stop the liveness watchdog now that the run resolved — otherwise
            // it keeps polling the terminal forever after the task completes.
            unwatchSessionLocal?.()
            // Close the terminal session proactively when the agent finishes
            // normally. Without this the tab stays open until the shell in the
            // tab happens to reach the trailing `; exit` / `; kill-session`,
            // which never runs if Claude was still generating output when the
            // `complete_task` tool callback resolved the waiter. If the session
            // died on its own (cancelled=true via watchdog), skip the close —
            // there's nothing to kill and the AppleScript would just no-op.
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
                  { taskId: task.id, agent: entry.agent },
                  'Async agent run cancelled — skipping transition',
                )
                try {
                  this.executionLogRepo?.update(logId, {
                    finishedAt: new Date().toISOString(),
                    outcome: 'cancelled',
                  })
                } catch (logErr) {
                  log.warn({ err: logErr }, 'Failed to update execution log')
                }
                continue
              }
              // complete_task / fail_task have already applied their transitions
              // and cleared the working flag; the orchestrator's only remaining
              // job is to record success in the execution log.
              try {
                this.executionLogRepo?.update(logId, {
                  finishedAt: new Date().toISOString(),
                  outcome: 'success',
                  stopReason: output.stopReason,
                })
              } catch (logErr) {
                log.warn({ err: logErr }, 'Failed to update execution log')
              }
            }
          } else {
            // Sync (API) — pick up any task mutations from in-process tool calls, then clean up
            const pendingAfterRun = getPendingTask(task.id)
            const cancelled = pendingAfterRun?.cancelled === true
            // complete_task / fail_task remove the pending entry as they run.
            // If it's gone we can't observe the post-tool task state here, but
            // we KNOW the tool already applied its own outcome (or explicit
            // override) — the default onFinish/onError would clobber it.
            const finalizedByTool = pendingAfterRun === undefined
            task = pendingAfterRun?.task ?? task
            removePendingTask(task.id)

            if (cancelled) {
              // The polling manager already killed us because the user moved
              // the task. `cancel` cleared working; don't apply any transition.
              log.info(
                { taskId: task.id, agent: entry.agent },
                'Agent run cancelled — skipping transition',
              )
              try {
                this.executionLogRepo?.update(logId, {
                  finishedAt: new Date().toISOString(),
                  outcome: 'cancelled',
                })
              } catch (logErr) {
                log.warn({ err: logErr }, 'Failed to update execution log')
              }
              continue
            }

            // If a tool call moved the task while the loop ran (complete_task
            // with a `status` override, set_task_field on Status, …), respect
            // that decision — the default onFinish/onError would clobber it.
            // Re-read the source instead of trusting the cached `task.status`:
            // some adapters return a Task that mirrors the write only when the
            // caller used the canonical field key, so a set_task_field with
            // "Status" (source-native) would leave the in-memory copy stale.
            const freshPostStatus = (await manager.getCurrentStatus?.(task)) ?? task.status
            if (freshPostStatus !== task.status) {
              task = { ...task, status: freshPostStatus }
            }
            if (finalizedByTool || task.status.toLowerCase() !== initialStatus.toLowerCase()) {
              log.info(
                {
                  taskId: task.id,
                  agent: entry.agent,
                  from: initialStatus,
                  to: task.status,
                },
                'Task moved by tool call during run — skipping default transition',
              )
              try {
                this.executionLogRepo?.update(logId, {
                  finishedAt: new Date().toISOString(),
                  outcome: 'success',
                  stopReason: output.stopReason,
                })
              } catch (logErr) {
                log.warn({ err: logErr }, 'Failed to update execution log')
              }
              try {
                await manager.setAgentWorking(task, false)
              } catch {}
              continue
            }

            task = await manager.setAgentWorking(task, false)

            if (output.truncated) {
              // Recoverable pause (task budget exhausted or safety cap). We
              // don't run onFinish — that would move the task to "Done" on
              // partial work. Instead we post a progress notice and, if the
              // status has an onError transition, use it to revert so the
              // user can move it forward again to retry.
              log.warn(
                {
                  taskId: task.id,
                  agent: entry.agent,
                  stopReason: output.stopReason ?? 'unknown',
                },
                'Agent run truncated — posting pause notice',
              )
              try {
                this.executionLogRepo?.update(logId, {
                  finishedAt: new Date().toISOString(),
                  outcome: 'truncated',
                  stopReason: output.stopReason,
                })
              } catch (logErr) {
                log.warn({ err: logErr }, 'Failed to update execution log')
              }
              // Unificamos el formato con complete_task/fail_task: header con
              // nombre del agente para que el hilo se lea uniforme incluso en
              // este fallback (agente devolvió stopReason sin cerrar por tool).
              const notice = [
                `# ${agentDef.id} · 🟡 pausado`,
                '',
                `**Razón**: ${output.stopReason ?? 'unknown'}`,
                '',
                'Avancé pero no terminé. Los cambios ya aplicados quedan persistidos.',
                'Mueve la tarea al status anterior para continuar.',
              ].join('\n')
              await manager.postComment?.(task, notice)
              if (entry.onError) {
                task = await applyOutcome(
                  { ...task, error: `truncated:${output.stopReason ?? 'unknown'}` },
                  entry.onError,
                  manager,
                )
                this.broadcast.send({ type: 'task:updated', task })
              }
              // Label ops sibling to onError — same trigger, dedicated slot so
              // truncation-driven label routing (e.g. tag as `stalled`) stays
              // decoupled from the `$set:` status transition above.
              if (entry.onErrorLabels) {
                task = await applyOutcome(task, entry.onErrorLabels, manager)
                this.broadcast.send({ type: 'task:updated', task })
              }
            } else if (entry.onFinish || entry.onFinishLabels) {
              try {
                this.executionLogRepo?.update(logId, {
                  finishedAt: new Date().toISOString(),
                  outcome: 'success',
                  stopReason: output.stopReason,
                })
              } catch (logErr) {
                log.warn({ err: logErr }, 'Failed to update execution log')
              }
              if (entry.onFinish) {
                task = await applyOutcome(task, entry.onFinish, manager)
                this.broadcast.send({ type: 'task:updated', task })
              }
              // Label ops sibling to onFinish — routed through the same
              // applyOutcome so a future `$labels:` runtime (sub-issue #47)
              // can honour it identically to the `$set:` counterpart.
              if (entry.onFinishLabels) {
                task = await applyOutcome(task, entry.onFinishLabels, manager)
                this.broadcast.send({ type: 'task:updated', task })
              }
            }
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err)
          const pendingEntry = getPendingTask(task.id)
          // Authoritative signal for "we cancelled it ourselves": the polling
          // divergence gate and graceful shutdown both go through entry.cancel(),
          // which flips `pendingEntry.cancelled` and aborts `controller`. Reading
          // `controller.signal.aborted` survives a raced removePendingTask that
          // would otherwise clear the flag before we get here.
          const explicitlyCancelled = pendingEntry?.cancelled === true || controller.signal.aborted
          // Upstream abort: the provider's fetch died on its own (network reset,
          // stream stall, idle timeout) with no user cancel involved. Providers
          // signal this by throwing UpstreamAbortError so we don't have to guess
          // from `err.name === 'AbortError'` — that idiom would collide with
          // downstream code that treats AbortError as "operator cancelled".
          const upstreamAbort = err instanceof UpstreamAbortError && !explicitlyCancelled
          // Pull latest task state so we can compare status too.
          task = pendingEntry?.task ?? task
          removePendingTask(task.id)

          if (explicitlyCancelled) {
            // Provider threw because the fetch was aborted by the manual gate.
            // Not a real failure — user moved the task on purpose. Working flag
            // was already cleared inside `cancel`.
            log.info(
              {
                event: 'agent.cancelled',
                taskId: task.id,
                agent: entry.agent,
                runId,
                reason: 'status-divergence',
              },
              'Agent run cancelled by status divergence',
            )
            try {
              this.executionLogRepo?.update(logId, {
                finishedAt: new Date().toISOString(),
                outcome: 'cancelled',
              })
            } catch (logErr) {
              log.warn({ err: logErr }, 'Failed to update execution log')
            }
            continue
          }

          if (upstreamAbort) {
            // The upstream API (anthropic-api fetch, tmux socket, …) aborted on
            // its own. Log distinctly from a divergence cancel so the operator
            // can tell them apart, and persist the raw message in error_msg for
            // the UI. Clear the working flag so the task can be retried.
            log.warn(
              {
                event: 'agent.aborted',
                taskId: task.id,
                agent: entry.agent,
                runId,
                reason: 'upstream-abort',
                err: errMsg,
              },
              'Agent run aborted by upstream API (network/stream stall)',
            )
            try {
              this.executionLogRepo?.update(logId, {
                finishedAt: new Date().toISOString(),
                outcome: 'cancelled',
                errorMsg: `upstream-abort: ${errMsg}`,
              })
            } catch (logErr) {
              log.warn({ err: logErr }, 'Failed to update execution log')
            }
            try {
              task = await manager.setAgentWorking(task, false)
            } catch {}
            continue
          }

          // If a tool already moved the task before the throw (e.g. fail_task,
          // set_task_field on Status), respect it — don't re-apply onError on
          // top of the intentional destination. Same rationale as the success
          // path: bypass the in-memory copy which can be stale.
          try {
            const freshErrStatus = await manager.getCurrentStatus?.(task)
            if (freshErrStatus && freshErrStatus !== task.status) {
              task = { ...task, status: freshErrStatus }
            }
          } catch {
            // If the fresh read fails (network, auth, …) fall back to the
            // in-memory status — worst case is a spurious onError, better
            // than swallowing the original throw with a secondary failure.
          }
          if (task.status.toLowerCase() !== initialStatus.toLowerCase()) {
            log.info(
              { taskId: task.id, from: initialStatus, to: task.status, err: errMsg },
              'Task moved by tool call before error surfaced — skipping onError',
            )
            try {
              this.executionLogRepo?.update(logId, {
                finishedAt: new Date().toISOString(),
                outcome: 'error',
                errorMsg: errMsg,
              })
            } catch (logErr) {
              log.warn({ err: logErr }, 'Failed to update execution log')
            }
            try {
              await manager.setAgentWorking(task, false)
            } catch {}
            throw err
          }

          log.error(
            { event: 'agent.error', taskId: task.id, agent: entry.agent, err: errMsg },
            'Agent run failed',
          )
          try {
            this.executionLogRepo?.update(logId, {
              finishedAt: new Date().toISOString(),
              outcome: 'error',
              errorMsg: errMsg,
            })
          } catch (logErr) {
            log.warn({ err: logErr }, 'Failed to update execution log')
          }
          task = await manager.setAgentWorking(task, false)
          if (entry.onError) {
            await manager.postError?.(task, errMsg)
            task = await applyOutcome({ ...task, error: errMsg }, entry.onError, manager)
            this.broadcast.send({ type: 'task:updated', task })
          }
          // Label ops sibling to onError — same trigger, separate applyOutcome
          // so a `$labels:+failed` outcome runs even when `$set:` isn't
          // configured (e.g. status stays put but the failure gets a label).
          if (entry.onErrorLabels) {
            task = await applyOutcome(task, entry.onErrorLabels, manager)
            this.broadcast.send({ type: 'task:updated', task })
          }
          throw err
        }
      }

      return true
    } finally {
      // Release the per-task lock exactly once, no matter which exit path
      // (success return, per-agent throw, chain-level early break) got us
      // here. `releaseTask` is idempotent so a duplicate call from a mis-
      // wired test wouldn't harm anything.
      if (workspaceLockHeld) {
        this.workspaceManager!.releaseTask(task.id)
      }

      // Auto-cleanup: remove the terminal worktree when the run is done and
      // there is no work at risk. Applies only to terminal providers (tmux /
      // iterm) that ran with workflow=worktree — anthropic-api worktrees are
      // managed by WorkspaceManager itself.
      if (terminalWorktreeBranch && primaryPath && this.workspaceManager) {
        // Use the manager's method (not the free helper) para respetar el
        // `worktreeBase` configurado en el constructor — el helper libre asume
        // el default y divergería silenciosamente si algún día se personaliza.
        const wtPath = this.workspaceManager.worktreePath(task.id, primaryPath)
        const safe = await this.workspaceManager
          .isWorktreeSafeToRemove(wtPath, terminalWorktreeBranch)
          .catch(() => false)
        if (safe) {
          log.info(
            { taskId: task.id, worktreePath: wtPath, branch: terminalWorktreeBranch },
            'Auto-removing clean terminal worktree',
          )
          await this.workspaceManager
            .removeWorktree(task.id, primaryPath, terminalWorktreeBranch)
            .catch((err: unknown) => {
              log.warn(
                {
                  taskId: task.id,
                  worktreePath: wtPath,
                  err: err instanceof Error ? err.message : String(err),
                },
                'Auto-remove worktree failed — worktree stays on disk',
              )
            })
        } else {
          log.warn(
            { taskId: task.id, worktreePath: wtPath, branch: terminalWorktreeBranch },
            'Terminal worktree has uncommitted or unpushed work — skipping auto-remove (worktree left for manual rescue)',
          )
        }
      }
    }
  }
}
