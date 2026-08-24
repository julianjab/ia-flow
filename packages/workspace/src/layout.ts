// Convención de layout: dónde vive el worktree de una task y cómo se llama
// su branch. Puro, sin I/O.
//
// Por qué es su propio módulo y no un detalle privado del WorkspaceManager:
// varias piezas tienen que coincidir en el MISMO path o dejan de verse entre
// ellas — el provisioner del provider sync, el del terminal, el bloque de
// git-context que le describe el terreno al agente, y la limpieza. Antes esta
// convención estaba copiada a mano en dos lugares (`WorkspaceManager` usaba
// `.worktrees/<taskId>` y `terminal-base` `.worktrees/task-<issue>`), así que
// un agente escritor en anthropic-api y un reviewer en tmux sobre la MISMA
// task miraban directorios distintos. Ahora hay un solo lugar que lo decide.

import { basename, join } from 'node:path'

export const DEFAULT_WORKTREE_BASE = '/tmp/ia-flow'

/** Base branch usada cuando `origin/HEAD` no está resuelto en el clone local. */
export const FALLBACK_BASE_BRANCH = 'main'

/**
 * Branches que nunca se borran del remoto por más "vacías" que parezcan.
 * La base resuelta (`origin/HEAD`) se agrega dinámicamente en el chequeo.
 */
export const PROTECTED_BRANCHES: ReadonlySet<string> = new Set([
  'main',
  'master',
  'develop',
  'HEAD',
])

export function branchNameFor(taskId: string, explicit?: string): string {
  if (explicit?.trim()) return explicit.trim()
  return `task/${taskId}`
}

/** Datos mínimos que `worktreeNameFor` necesita de una task. */
export interface WorktreeNameSource {
  id: string
  issueNumber?: number
  title?: string
}

function kebab(s: string, max: number): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '') // tildes → letra base (marcas de combinación)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, max)
    .replace(/-$/, '')
}

/**
 * Nombre legible del worktree de una task: `task-<issueNumber>` cuando el
 * source expone un número de issue (GitHub), y `task-<slug-del-título>-<sufijo>`
 * cuando no (source local, o task sin issue).
 *
 * Por qué no el `id` crudo: en GitHub Projects es un node id opaco
 * (`PVTI_lAHOAIgSic4Bf4pzzg3fXxk`) que no dice nada en un `pwd` ni en
 * `git worktree list`. El sufijo del id se conserva en el fallback para que
 * dos tasks con títulos parecidos no colisionen en el mismo directorio.
 */
export function worktreeNameFor(task: WorktreeNameSource): string {
  if (task.issueNumber != null) return `task-${task.issueNumber}`
  const suffix = kebab(task.id, 64).slice(-6) || 'task'
  const slug = kebab(task.title ?? '', 40)
  return slug ? `task-${slug}-${suffix}` : `task-${suffix}`
}

/**
 * `<base>/<repo>/.worktrees/<name>`. El segundo argumento es el NOMBRE del
 * worktree (`worktreeNameFor`), no el taskId — ver el comentario de arriba.
 */
export function worktreePathFor(
  repoBasePath: string,
  name: string,
  base: string = DEFAULT_WORKTREE_BASE,
): string {
  return join(base, basename(repoBasePath), '.worktrees', name)
}

/**
 * Path legacy: hasta la unificación de la convención, el provider sync
 * nombraba el directorio por el `taskId` crudo. Se sigue calculando para
 * poder REUSAR un worktree viejo que ya esté en disco (con trabajo sin
 * commitear adentro) en vez de dejarlo huérfano y crear uno nuevo al lado.
 * Sólo se consulta; nada lo crea.
 */
export function legacyWorktreePathFor(
  repoBasePath: string,
  taskId: string,
  base: string = DEFAULT_WORKTREE_BASE,
): string {
  return worktreePathFor(repoBasePath, taskId, base)
}
