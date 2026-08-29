// Contrato del workspace de un run: la INTENCIÓN que el engine declara y el
// PLAN que el provider resuelve.
//
// Por qué vive acá y no en `@ia-flow/ai-providers`: el `WorkspaceRequest`
// cruza el wire (viaja dentro del `ProviderInput` hasta
// `apps/agent-host`, que lo valida en su borde con Zod), así que es
// frontera server↔server igual que el resto de `packages/shared`. El
// `WorkspacePlan` NO cruza el wire — lo resuelve quien va a correr el agente,
// en su propia máquina — pero se declara al lado porque es la otra mitad del
// mismo contrato.
//
// La regla que esto codifica: **el engine describe el trabajo, el provider
// decide dónde aterriza.** Antes el engine calculaba paths absolutos de SU
// disco y se los pasaba al provider; con un provider remoto esos paths eran
// de otra máquina. Ahora manda coordenadas (repo, branch, si necesita
// escribir) y cada provider las materializa como sabe: worktree local,
// checkout in-place, clone propio del otro lado del cable, o nada.
import { z } from 'zod'
import { RepoWorkflowSchema, StepTypeSchema } from './schemas.js'

/**
 * Un repo de la task tal como el engine lo conoce. `path` es el clone local
 * del daemon: sirve al provider que corre en ESA máquina y es sólo una pista
 * para el que corre en otra (que va a resolver el suyo desde
 * `githubOwner`/`githubRepo`).
 */
export const WorkspaceRepoRefSchema = z.object({
  name: z.string(),
  path: z.string().optional(),
  githubOwner: z.string().optional(),
  githubRepo: z.string().optional(),
})

export const WorkspaceRequestSchema = z.object({
  taskId: z.string(),
  taskTitle: z.string().optional(),
  /** Alimenta el nombre legible del worktree (`task-<issueNumber>`). */
  issueNumber: z.number().optional(),
  runId: z.string().optional(),
  step: StepTypeSchema,
  repos: z.array(WorkspaceRepoRefSchema),
  /** Nombre del repo principal dentro de `repos` — el que define el cwd. */
  primaryRepo: z.string().optional(),
  /**
   * Branch canónica de la task (linked branch de GitHub o la que auto-nombró
   * el engine). Ausente ⇒ el provider cae a `task/<taskId>`.
   */
  branch: z.string().optional(),
  workflow: RepoWorkflowSchema.optional(),
  /**
   * El agente declara tools de escritura (`fs_write` / `fs_edit` /
   * `bash_run`). Es la ÚNICA señal de permiso, y la decide el engine a partir
   * de `agent.tools[]` — un provider puede elegir dónde escribir, no si
   * puede. Ver `intersectWritePaths`.
   */
  needsWrite: z.boolean(),
})

export type WorkspaceRepoRef = z.infer<typeof WorkspaceRepoRefSchema>
export type WorkspaceRequest = z.infer<typeof WorkspaceRequestSchema>

/**
 * Lo que devuelve el provider (o su provisioner inyectado) tras preparar el
 * terreno. Se mergea sobre el `ProviderInput` justo antes de correr.
 *
 * No es un schema Zod a propósito: nunca se serializa (`release` es una
 * closure) y siempre lo produce y consume el mismo proceso.
 */
export interface WorkspacePlan {
  /** name → path absoluto, alimenta `ToolContext.repoPaths`. */
  repoPaths: Record<string, string>
  /**
   * Zonas escribibles para write/edit/exec tools. `undefined` o vacío ⇒ el
   * run no tiene dónde escribir y los tools de escritura rechazan.
   */
  writePaths?: string[]
  /** Directorio donde arranca el agente. */
  cwd?: string
  /** Branch que el provider terminó usando — el engine la refleja en la task. */
  branch?: string
  /** Seteado sólo si se materializó un worktree; alimenta el git-context. */
  worktreePath?: string
  /**
   * Limpieza del terreno preparado, invocada por el engine cuando el run
   * termina (éxito, error o abort). Best-effort y idempotente: es la
   * contracara de `prepare`, no un rollback transaccional.
   */
  release?: () => Promise<void>
}

/** Plan vacío — el provider no necesita (o no puede) preparar nada local. */
export const EMPTY_WORKSPACE_PLAN: WorkspacePlan = { repoPaths: {} }

/**
 * Intersecta lo que el provider PROPONE escribir con lo que el engine
 * PERMITE. Un provider que devuelve writePaths sin que el agente tenga tools
 * de escritura no abre el sandbox: el permiso no es suyo.
 *
 * Pura y testeable sin I/O — es la guarda que sobrevive a que la ubicación
 * del workspace haya dejado de ser decisión del engine.
 */
export function intersectWritePaths(
  proposed: string[] | undefined,
  needsWrite: boolean,
): string[] | undefined {
  if (!needsWrite) return []
  return proposed
}
