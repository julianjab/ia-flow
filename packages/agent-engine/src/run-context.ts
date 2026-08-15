// Resuelve todo lo que un dispatch necesita antes de correr: qué agente aplica
// (vía `selectAgent`) y cómo se ve el layout de repos del proyecto (todos los
// repos para que las fs tools naveguen, más el repo primario que define cwd y
// workflow).
//
// Reemplaza al antiguo `chain-context.ts`: ya no hay cadena de agentes por
// status: un dispatch = un agente. Devuelve `null` (después de loguear) en las
// tres condiciones de salida temprana: ningún agente matchea, o el repo
// primario del issue no está registrado en el proyecto.
import type { AgentDefinition, RepoWorkflow, Task } from '@ia-flow/shared'
import { selectAgent, summarizeRejections } from './agent-selection.js'
import type { DbRepoEntry, IRepoRepository } from './contract.js'
import { createLogger } from './logger.js'

const log = createLogger('run-context')

export interface RunContext {
  agent: AgentDefinition
  projectRepos: DbRepoEntry[]
  repoPaths: Record<string, string>
  primaryRepoName: string | undefined
  primaryPath: string | undefined
  primaryWorkflow: RepoWorkflow | undefined
  /** DB row for the primary repo, if the task points at one registered in the
   *  project — exposed so the orchestrator can clone it (WorkspaceManager)
   *  when `primaryPath` is undefined but `githubOwner`/`githubRepo` are set. */
  primaryTaskRepo: DbRepoEntry | undefined
}

export interface ResolveRunContextInput {
  task: Task
  /** Candidatos visibles para el proyecto del task (project-scoped + globales). */
  agents: AgentDefinition[]
  repoRepo: IRepoRepository
  expandHome: (p: string) => string
}

export function resolveRunContext({
  task,
  agents,
  repoRepo,
  expandHome,
}: ResolveRunContextInput): RunContext | null {
  const { agent, rejected } = selectAgent({ task, agents, status: task.status })

  if (!agent) {
    log.debug(
      {
        status: task.status,
        taskId: task.id,
        projectId: task.projectId,
        title: task.title,
        type: task.type,
        repos: task.repos,
        rejected: summarizeRejections(rejected),
      },
      'Ningún agente matchea los criterios de activación — skipping',
    )
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
    agent,
    projectRepos,
    repoPaths,
    primaryRepoName,
    primaryPath,
    primaryWorkflow,
    primaryTaskRepo,
  }
}
