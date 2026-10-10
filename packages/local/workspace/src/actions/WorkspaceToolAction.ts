import {
  Action,
  type PipelineExecutionContext,
  type SchemaTool,
  type SideEffects,
  type ToolInputSchema,
} from '@ia-flow/agent-engine'
import { capabilityFocuser, FsReadTool, FsToolRegistry } from '@ia-flow/fs-tools'
import { type BashPolicy, BashRunTool, memoryNote, timeoutNote } from '@ia-flow/shell-tools'
import type { WorkspaceSession } from './WorkspaceSession.js'

/**
 * Una tool de disco (`fs_*`, `bash_run`) como `Action` sobre el worktree de la corrida.
 *
 * Las tools de `fs-tools`/`shell-tools` fijan su directorio al construirse y su `handler` no ve
 * el evento; una Action sí (`execute(input, ctx)`). Cada llamada pide el worktree de SU corrida
 * a la `WorkspaceSession` y delega en la tool real construida sobre ese directorio (y sobre las
 * capacidades de la corrida: el `focus` de `fs_read`). El modelo ve
 * el mismo nombre y el mismo schema que la tool original.
 */
export class WorkspaceToolAction<S extends ToolInputSchema> extends Action<S, string> {
  readonly description: string
  readonly input: S
  override readonly sideEffects: SideEffects
  override readonly workspace = true

  constructor(
    private readonly session: WorkspaceSession,
    template: SchemaTool<S>,
    private readonly build: (dir: string, ctx: PipelineExecutionContext) => SchemaTool<S>,
    sideEffects: SideEffects,
    description?: string,
  ) {
    super({ id: template.name })
    this.input = template.input
    this.description = description ?? template.description
    this.sideEffects = sideEffects
  }

  async execute(input: unknown, ctx: PipelineExecutionContext): Promise<string> {
    return this.build(await this.session.dirFor(ctx), ctx).handler(input)
  }
}

const READ_ONLY = new Set(['fs_read', 'fs_list', 'fs_grep'])

/** Los nombres de tool que `workspaceAction` sabe construir. */
export const WORKSPACE_TOOLS: ReadonlySet<string> = new Set([
  ...READ_ONLY,
  'fs_write',
  'fs_edit',
  'bash_run',
])

export interface WorkspaceActionOptions {
  /** La credencial que `bash_run` le pasa a los `git` de red (ver `BashRunToolOptions`). Sin
   *  esto, el agente no puede publicar su branch: el worktree no tiene credenciales. */
  gitCredential?: () => Promise<string | undefined>
  /** Cuánto corre un comando de `bash_run` si el agente no pide otra cosa (default 60 s). */
  timeoutMs?: number
  /** Lo máximo que el agente puede pedir por comando. Sin esto no puede estirarlo. */
  maxTimeoutMs?: number
  /** Tope de memoria de cada comando de `bash_run` (ver `BashRunToolOptions`). Default 2 GiB. */
  maxMemoryBytes?: number
}

/** La Action de `name` sobre el worktree de cada corrida. `policy` y `options` sólo aplican a
 *  `bash_run`. */
export function workspaceAction(
  name: string,
  session: WorkspaceSession,
  policy: BashPolicy = { deny: [] },
  options: WorkspaceActionOptions = {},
): WorkspaceToolAction<ToolInputSchema> {
  if (name === 'bash_run') {
    const { gitCredential, timeoutMs, maxTimeoutMs, maxMemoryBytes } = options
    const limits = {
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(maxTimeoutMs !== undefined ? { maxTimeoutMs } : {}),
      ...(maxMemoryBytes !== undefined ? { maxMemoryBytes } : {}),
    }
    return new WorkspaceToolAction(
      session,
      new BashRunTool({ baseDir: '.', policy, ...limits }),
      (dir) => new BashRunTool({ baseDir: dir, policy, gitCredential, ...limits }),
      'write',
      `Ejecuta un comando SIN shell (sin pipes, redirecciones ni expansión) en el worktree de la task — usa comillas para args con espacios. ${timeoutNote(limits)} ${memoryNote(limits)}`,
    ) as unknown as WorkspaceToolAction<ToolInputSchema>
  }
  if (!WORKSPACE_TOOLS.has(name)) throw new Error(`workspace: "${name}" no es una tool de disco`)
  // Las 5 fs_* extienden `SchemaTool` (`FsTool`); el registry las devuelve como `Tool` genérico.
  // `fs_read` se arma aparte: enfoca con la capacidad `fileFocus` de la corrida, si alguien la cumple.
  const fsTool = (dir: string, ctx?: PipelineExecutionContext) => {
    if (name === 'fs_read') {
      const focus = capabilityFocuser(ctx?.capabilities)
      return new FsReadTool(dir, focus ? { focus } : {}) as unknown as SchemaTool<ToolInputSchema>
    }
    return new FsToolRegistry(dir).get(name) as SchemaTool<ToolInputSchema>
  }
  return new WorkspaceToolAction(
    session,
    fsTool('.'),
    fsTool,
    READ_ONLY.has(name) ? 'none' : 'write',
  )
}
