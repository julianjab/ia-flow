// Resuelve el layout de repos que un dispatch necesita antes de correr: todos
// los repos del proyecto para que las fs tools naveguen, más el repo primario
// que define cwd y workflow.
//
// Ya NO elige el agente: desde la migración 059 lo elige una regla, y acá
// llega hecho. Lo que queda son los dos guards que dependen del par
// (agente, task): multi-repo con un agente que escribe, y repo primario sin
// registrar. Devuelve `null` —después de loguear— en cualquiera de los dos.
import type { AgentDefinition, RepoWorkflow, Task } from '@ia-flow/shared'
import type { DbRepoEntry, IRepoRepository } from './contract.js'
import { createLogger } from './logger.js'
import { hasWriteTools } from './write-access.js'

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
  /** El agente que la regla eligió. No hay selección acá: la decisión ya se
   *  tomó contra el evento, y volver a decidir podría correr otro. */
  agent: AgentDefinition
  repoRepo: IRepoRepository
  expandHome: (p: string) => string
}

// Sigue siendo async por la firma de sus callers, aunque ya no haga I/O: el
// gate semántico que la hacía esperar a un modelo se mudó al matcher de reglas.
export async function resolveRunContext({
  task,
  agent,
  repoRepo,
  expandHome,
}: ResolveRunContextInput): Promise<RunContext | null> {
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
  //
  // Multi-repo + agente que ESCRIBE se corta acá — y sólo acá: este es el
  // único lugar del camino de dispatch donde `task.repos` es el dato real de
  // la task. El guard vivía en WorkspaceManager.resolveScopes, pero a los
  // provisioners les llega el roster COMPLETO del proyecto
  // (WorkspaceRequest.repos alimenta las fs tools), así que aquel guard
  // tiraba para TODA task apenas el proyecto registraba un segundo repo.
  // Un agente read-only (los refiners) sigue corriendo: refinar/desglosar una
  // épica multi-repo es exactamente su trabajo. Mismo tratamiento que el repo
  // sin registrar de abajo: log.error + dispatch cancelado, no un run fallido.
  if (task.repos.length > 1 && hasWriteTools({ tools: agent.tools })) {
    log.error(
      { taskId: task.id, repos: task.repos, projectId: task.projectId, agent: agent.id },
      'Task con múltiples repos y el agente escribe — un agente de escritura opera sobre UN repo. Desglosala en sub-issues (functional-refiner) o corregí el custom "Repos" del board.',
    )
    return null
  }
  const primaryRepoName = task.repos[0]
  const primaryTaskRepo = primaryRepoName
    ? projectRepos.find((r) => r.name === primaryRepoName)
    : undefined
  // Un repo sin registrar sólo es fatal para un agente que ESCRIBE.
  //
  // Lo único que sale de este lookup es `primaryPath` + `primaryWorkflow`, y
  // sus dos consumidores son el provisioner de workspace y el git-context que
  // depende de él. Un agente read-only —o uno que lee y escribe por el MCP de
  // GitHub, sin checkout— no los usa: cancelarle el dispatch es protegerlo de
  // algo que no iba a tocar.
  //
  // Y era el caso más caro de perder. Una tarea funcional multirepo llega con
  // `Repos: backend, web-app` escrito a mano en el board; si UNO de los dos no
  // está en el catálogo, el issue quedaba muerto con un log.error que nadie
  // mira — justo el issue que el refiner tenía que desglosar. Ahora lo refina
  // igual, y puede nombrar en el PRD un repo que todavía nadie registró.
  if (primaryRepoName && !primaryTaskRepo) {
    if (hasWriteTools({ tools: agent.tools })) {
      log.error(
        { taskId: task.id, repo: primaryRepoName, projectId: task.projectId, agent: agent.id },
        'Task apunta a repo no registrado y el agente escribe. Registralo en ia-flow o corregí el custom "Repos" del ProjectV2.',
      )
      return null
    }
    log.warn(
      { taskId: task.id, repo: primaryRepoName, projectId: task.projectId, agent: agent.id },
      'Repo no registrado en el proyecto — el agente no escribe en disco, sigue sin él',
    )
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
