// Resolves the per-task chain: which status config / agent entries apply,
// and the repo layout (all project repos for fs-tool navigation, plus the
// primary repo that owns cwd/workflow). Returns null (after logging) on the
// two early-exit conditions AgentOrchestrator.runAgent used to check inline:
// no agent matched the current status, or the task's primary repo isn't
// registered in the project.
import type { Task } from '@ia-flow/shared'
import type { ProjectConfig, RepoWorkflow, StatusAgentEntry } from '@ia-flow/shared'
import type { DbRepoEntry, IRepoRepository } from './contract.js'
import { createLogger } from './logger.js'
import { evalWhen } from './outcomes.js'

const log = createLogger('chain-context')

export interface StatusConfigLike {
  name: string
  agents: StatusAgentEntry[]
}

export interface ChainContext {
  statusConfig: StatusConfigLike
  matchingEntries: StatusAgentEntry[]
  projectRepos: DbRepoEntry[]
  repoPaths: Record<string, string>
  primaryRepoName: string | undefined
  primaryPath: string | undefined
  primaryWorkflow: RepoWorkflow | undefined
}

export interface ResolveChainContextInput {
  task: Task
  config: ProjectConfig
  repoRepo: IRepoRepository
  expandHome: (p: string) => string
}

export function resolveChainContext({
  task,
  config,
  repoRepo,
  expandHome,
}: ResolveChainContextInput): ChainContext | null {
  const statusConfig = config.statuses?.find(
    (s) => s.name.toLowerCase() === task.status.toLowerCase(),
  )
  if (!statusConfig) return null

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
    return null
  }

  // All project repos → name→path map so fs tools can resolve any repo
  // in the project (not just those on the task). The agent learns names
  // via `{{project.repos}}` in its prompt and navigates via read_file /
  // list_dir / grep_files.
  const projectRepos = task.projectId ? repoRepo.listByProject(task.projectId) : repoRepo.list()
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
    return null
  }
  const primaryPath = primaryTaskRepo?.path ? expandHome(primaryTaskRepo.path) : undefined
  const primaryWorkflow = primaryTaskRepo?.workflow

  return {
    statusConfig,
    matchingEntries,
    projectRepos,
    repoPaths,
    primaryRepoName,
    primaryPath,
    primaryWorkflow,
  }
}
