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
import { summarizeRejections } from './agent-selection.js'
import { type AgentTextClassifier, selectAgentGated } from './agent-text-gate.js'
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
  /** Candidatos visibles para el proyecto del task (project-scoped + globales). */
  agents: AgentDefinition[]
  repoRepo: IRepoRepository
  expandHome: (p: string) => string
  /** Evalúa el `whenText` de los candidatos (ver agent-text-gate.ts). Ausente
   *  = ese filtro no se aplica y la selección es la estructural de siempre. */
  classifyAgent?: AgentTextClassifier
}

// Async sólo por el gate de `whenText`, que consulta a un modelo. Un roster sin
// ningún agente con `whenText` (o sin `classifyAgent` inyectado) no hace ni una
// llamada: `selectAgentGated` corta antes de tocar el clasificador.
export async function resolveRunContext({
  task,
  agents,
  repoRepo,
  expandHome,
  classifyAgent,
}: ResolveRunContextInput): Promise<RunContext | null> {
  const { agent, rejected } = await selectAgentGated({
    task,
    agents,
    status: task.status,
    classify: classifyAgent,
  })

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
