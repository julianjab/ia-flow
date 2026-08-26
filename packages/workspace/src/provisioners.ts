// Provisioners — las dos formas concretas de aterrizar un `WorkspaceRequest`
// sobre un disco real, ambas sobre el MISMO `WorkspaceManager`.
//
// Antes esto vivía en dos lugares que no se conocían: `workspace-scopes.ts`
// (engine, para anthropic-api) y `ensureWorktree` dentro de `terminal-base`
// (provider, para tmux/iterm). Cada uno con su cadena de fallbacks de `git
// worktree add`, su idea de cómo se llama el directorio y su manejo de
// errores. Un bug de git había que arreglarlo dos veces, y los dos nombraban
// el worktree distinto — así que un builder en anthropic-api y un reviewer en
// tmux sobre la misma task miraban directorios diferentes.
//
// Quién los usa: los inyecta el composition root en cada provider
// (`IAgentProvider.prepareWorkspace`). El engine ya no elige — describe el
// trabajo y el provider aterriza.
import type { WorkspacePlan, WorkspaceRepoRef, WorkspaceRequest } from '@ia-flow/shared'
import type { WorkspaceManager } from './WorkspaceManager.js'
import { createLogger } from './logger.js'

const log = createLogger('workspace-provisioner')

/** Lo que implementa cada estrategia. Un provider recibe UNA y la usa tal cual. */
export interface WorkspaceProvisioner {
  prepare(req: WorkspaceRequest): Promise<WorkspacePlan>
}

function primaryRepoOf(req: WorkspaceRequest): WorkspaceRepoRef | undefined {
  if (req.primaryRepo) {
    const named = req.repos.find((r) => r.name === req.primaryRepo)
    if (named) return named
  }
  return req.repos[0]
}

/**
 * Path local del repo principal. Si el daemon ya conoce uno (`ref.path`) y ESE
 * path existe en este disco, se usa; si no, y el repo trae coordenadas de
 * GitHub, se clona.
 *
 * El chequeo de existencia no es paranoia: el `path` del request lo pone el
 * daemon que despacha, y en un dispatch remoto ese daemon corre en otra
 * máquina (típicamente un contenedor, con paths tipo `/data/repos/x`). Sin
 * verificar, el gateway devolvía ese path tal cual como `cwd`, el `cd` fallaba
 * y la sesión terminaba corriendo en el directorio desde donde se lanzó el
 * gateway — sin error, con un "Git context" que describía un disco ajeno.
 *
 * Las coordenadas son la parte portable del request; el path es una pista
 * local. Cuando la pista no aplica acá, se cae a las coordenadas — que es
 * justamente lo que hace que un host que NUNCA vio el repo pueda trabajar.
 */
async function resolvePrimaryPath(
  manager: WorkspaceManager,
  ref: WorkspaceRepoRef | undefined,
): Promise<string | undefined> {
  if (!ref) return undefined
  if (manager.hasLocalClone(ref.path)) return ref.path
  if (ref.path) {
    log.warn(
      { repo: ref.name, path: ref.path },
      'El path del request no existe en este disco — se ignora y se resuelve por coordenadas',
    )
  }
  if (!ref.githubOwner || !ref.githubRepo) return undefined
  const path = await manager.ensureLocalClone(ref)
  log.info({ repo: ref.name, path }, 'Repo clonado localmente para este run')
  return path
}

/** name → path para los repos que ya tienen uno **en este disco**. Base sobre
 *  la que el provisioner remapea el principal a su worktree.
 *
 *  Mismo filtro que `resolvePrimaryPath` y por el mismo motivo: los secundarios
 *  alimentan `repoPaths`, o sea lo que ven las fs tools. Un path de otra
 *  máquina acá es un `fs_read` que falla con "no such file" en vez de una
 *  ausencia declarada. */
function baseRepoPaths(manager: WorkspaceManager, req: WorkspaceRequest): Record<string, string> {
  const out: Record<string, string> = {}
  for (const r of req.repos) if (manager.hasLocalClone(r.path)) out[r.name] = r.path
  return out
}

/**
 * Worktree aislado por task + scopes de lectura/escritura. Es lo que
 * necesita un provider **sync** (anthropic-api y su gateway remoto): corre
 * los tools adentro de un `ToolContext` que honra `writePaths`.
 *
 * No devuelve `release`: el worktree sobrevive al run a propósito — el
 * siguiente agente de la cadena (típicamente un reviewer read-only) lo
 * hereda. Lo limpia `cleanupTerminalWorktree` / el reset explícito, no el
 * final de un run.
 */
export class WorktreeWorkspaceProvisioner implements WorkspaceProvisioner {
  constructor(private manager: WorkspaceManager) {}

  async prepare(req: WorkspaceRequest): Promise<WorkspacePlan> {
    const ref = primaryRepoOf(req)
    const primaryPath = await resolvePrimaryPath(this.manager, ref)
    const repoPaths = baseRepoPaths(this.manager, req)
    if (!ref || !primaryPath) return { repoPaths, branch: req.branch }

    const task = {
      id: req.taskId,
      issueNumber: req.issueNumber,
      title: req.taskTitle,
      repos: req.repos.map((r) => r.name),
    }

    // Se materializa sólo si el agente escribe. Un read-only no crea nada:
    // hereda el worktree si ya existe (invariante de visibilidad de la
    // cadena) y si no, lee el repo base.
    let worktreePath: string | undefined
    let branch: string | undefined
    if (req.needsWrite) {
      const created = await this.manager.getOrCreateWorktree(task, primaryPath, {
        branch: req.branch,
      })
      worktreePath = created.path
      branch = created.branch
      if (req.runId) this.manager.recordRunId(req.taskId, req.runId)
    }
    const worktreeExists = this.manager.worktreeExistsOnDisk(task, primaryPath)
    const scopes = this.manager.resolveScopes(task, req.needsWrite, {
      repoBasePath: primaryPath,
      worktreeExists,
      worktreePath,
    })

    return {
      repoPaths: { ...repoPaths, [ref.name]: scopes.readPaths[0] },
      writePaths: scopes.writePaths,
      cwd: scopes.readPaths[0],
      worktreePath: worktreeExists || worktreePath ? scopes.readPaths[0] : undefined,
      branch: branch ?? req.branch,
    }
  }
}

/**
 * Terreno para un provider **async** de terminal (tmux/iterm): el agente
 * tiene shell propia, así que no hay sandbox de `writePaths` que imponer —
 * lo que importa es en qué directorio arranca.
 *
 * Obedece `workflow`:
 *   • `worktree` → materializa el worktree de la task y ese es el cwd;
 *   • `branch` / `main` → el repo base (el `git checkout -b` in-place lo
 *     arma el comando del provider, que es construcción de shell, no
 *     preparación de terreno).
 *
 * Sí devuelve `release`: la limpieza automática del worktree terminal
 * (borrarlo si no quedó trabajo en riesgo, y borrar la branch remota si no
 * aporta nada sobre la base) dejó de ser un caso especial dentro del
 * `finally` del orquestador y pasó a ser la contracara de este `prepare`.
 */
export class TerminalWorkspaceProvisioner implements WorkspaceProvisioner {
  constructor(private manager: WorkspaceManager) {}

  async prepare(req: WorkspaceRequest): Promise<WorkspacePlan> {
    const ref = primaryRepoOf(req)
    const primaryPath = await resolvePrimaryPath(this.manager, ref)
    const repoPaths = baseRepoPaths(this.manager, req)
    if (!ref || !primaryPath) return { repoPaths, branch: req.branch }

    const plan: WorkspacePlan = {
      repoPaths: { ...repoPaths, [ref.name]: primaryPath },
      cwd: primaryPath,
      branch: req.branch,
      // Los terminal providers no consumen `writePaths` (tienen shell cruda);
      // se declara explícito para que nadie lo lea como "no puede escribir".
      writePaths: req.needsWrite ? [primaryPath] : [],
    }

    if (req.step !== 'implement' || (req.workflow ?? 'branch') !== 'worktree') return plan

    const task = {
      id: req.taskId,
      issueNumber: req.issueNumber,
      title: req.taskTitle,
      repos: req.repos.map((r) => r.name),
    }
    const created = await this.manager.getOrCreateWorktree(task, primaryPath, {
      branch: req.branch,
    })
    if (req.runId) this.manager.recordRunId(req.taskId, req.runId)

    return {
      repoPaths: { ...repoPaths, [ref.name]: created.path },
      cwd: created.path,
      worktreePath: created.path,
      branch: created.branch,
      writePaths: req.needsWrite ? [created.path] : [],
      release: () =>
        this.manager.cleanupTerminalWorktree(
          task,
          primaryPath,
          created.branch,
          created.path,
          // Su propio run no cuenta como co-uso: al correr el release sigue
          // vivo en el registry y en `execution_logs`.
          req.runId,
        ),
    }
  }
}
