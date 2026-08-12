import { join } from 'path'
import type { McpServers, Task } from '@ia-flow/shared'
import { LocalTransitionManager } from '../adapters/local/transition-manager.js'
import { watchSession } from '../adapters/terminal-base/session-watchdog.js'
import { applyOutcome, evalWhen } from '../agents/outcomes.js'
import {
  getPendingTask,
  registerPendingTask,
  removePendingTask,
  waitForFinish,
} from '../agents/pending-tasks.js'
import { resolveVariables } from '../agents/variable-resolver.js'
import type { IBroadcast } from '../domain/ports/IBroadcast.js'
import type { IExecutionLogRepository } from '../domain/ports/IExecutionLogRepository.js'
import type { IMcpCatalogRepository } from '../domain/ports/IMcpCatalogRepository.js'
import type { IProjectConfigRepository } from '../domain/ports/IProjectConfigRepository.js'
import type { IProviderRegistry } from '../domain/ports/IProviderRegistry.js'
import type { IRepoRepository } from '../domain/ports/IRepoRepository.js'
import type { IToolRegistry } from '../domain/ports/IToolRegistry.js'
import type { ITransitionManager } from '../domain/ports/ITransitionManager.js'
import { createLogger } from '../logger.js'

const log = createLogger('agent-orchestrator')

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

  async runAgent(
    task: Task,
    manager: ITransitionManager = new LocalTransitionManager(),
  ): Promise<boolean> {
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
    // Fallback: if the source didn't attach any repo to this task (e.g. the
    // GH Project item has no "Repos" field), assume the project's own repos.
    // Otherwise `{{task.repos}}` renders empty and the terminal provider has
    // no cwd — same failure mode we hit when the refiner tried to explore
    // "ia-flow" with no assigned repo.
    if (!task.repos.length && projectRepos.length) {
      task = { ...task, repos: projectRepos.map((r) => r.name) }
    }
    // Primary task repo drives cwd/workflow for terminal providers.
    const primaryTaskRepo = projectRepos.find((r) => task.repos.includes(r.name))
    const primaryPath = primaryTaskRepo?.path ? expandHome(primaryTaskRepo.path) : undefined
    const primaryWorkflow = primaryTaskRepo?.workflow

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

      try {
        const projectContext: Record<string, string> = {
          ...((config.project as Record<string, string> | undefined) ?? {}),
          ...(manager.getProjectContext?.() ?? {}),
        }
        const resolvedPrompt = resolveVariables(agentDef.prompt, {
          task,
          variables: agentDef.variables,
          project: projectContext,
          projectRepos,
        })

        const systemPromptBlocks = (agentDef.systemPrompts ?? [])
          .map((id) => config.systemPrompts?.find((sp) => sp.id === id))
          .filter((sp): sp is NonNullable<typeof sp> => sp !== undefined)
          .map((sp) => ({ type: 'text' as const, text: sp.text }))

        const provider = this.providers.get(agentDef.provider)
        // Tool instructions used to be assembled here and prepended to the
        // prompt. That responsibility now lives in the terminal provider
        // (see terminal-provider-base.buildToolsAppendix) so anthropic-api
        // stays lean and each provider owns its own contract.
        const sourceToolContext = manager.getSourceToolContext?.()

        // Cancellation plumbing: the polling manager calls entry.cancel()
        // when it detects the source-side status has drifted from the one at
        // dispatch time (manual gate). For sync providers we abort the fetch;
        // for tmux we kill the session once it's known.
        const controller = new AbortController()

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
          repoPaths,
          prompt: resolvedPrompt,
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
          signal: controller.signal,
        })

        if (output.mode === 'tmux') {
          // Wire the provider-agnostic session handle: persist its coordinates
          // so the row in execution_logs can be looked up / cancelled later,
          // register close() as killSession, and start a liveness watchdog
          // that finalizes the run if the user closes the tab manually.
          if (output.session) {
            const handle = output.session
            const entryPending = getPendingTask(task.id)
            if (entryPending) {
              entryPending.killSession = () => handle.close()
              entryPending.unwatchSession = watchSession(handle, () => {
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
            const notice = [
              '## 🟡 Agent paused',
              '',
              'Avancé pero no terminé (razón: ' + (output.stopReason ?? 'unknown') + ').',
              '',
              'Los cambios ya aplicados quedan persistidos. Mueve la tarea al status anterior para continuar.',
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
          } else if (entry.onFinish) {
            try {
              this.executionLogRepo?.update(logId, {
                finishedAt: new Date().toISOString(),
                outcome: 'success',
                stopReason: output.stopReason,
              })
            } catch (logErr) {
              log.warn({ err: logErr }, 'Failed to update execution log')
            }
            task = await applyOutcome(task, entry.onFinish, manager)
            this.broadcast.send({ type: 'task:updated', task })
          }
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        const errName = err instanceof Error ? err.name : undefined
        const pendingEntry = getPendingTask(task.id)
        // Authoritative signal for "we cancelled it ourselves": the polling
        // divergence gate and graceful shutdown both go through entry.cancel(),
        // which flips `pendingEntry.cancelled` and aborts `controller`. Reading
        // `controller.signal.aborted` survives a raced removePendingTask that
        // would otherwise clear the flag before we get here.
        const explicitlyCancelled = pendingEntry?.cancelled === true || controller.signal.aborted
        const isAbortError =
          err instanceof Error && (errName === 'AbortError' || errMsg.includes('aborted'))
        // Upstream abort: fetch died on its own (network reset, stream stall,
        // idle timeout) without our controller ever aborting. Classify as
        // aborted (not a real dispatch failure) but keep the error visible so
        // the operator can tell it apart from a status divergence.
        const upstreamAbort = isAbortError && !explicitlyCancelled
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
              errName,
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
        throw err
      }
    }

    return true
  }
}
