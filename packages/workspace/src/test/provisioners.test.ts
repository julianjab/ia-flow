import { describe, expect, it } from 'bun:test'
import type { WorkspaceRequest } from '@ia-flow/shared'
import { WorkspaceManager } from '../WorkspaceManager.js'
import { worktreeNameFor, worktreePathFor } from '../layout.js'
import { TerminalWorkspaceProvisioner, WorktreeWorkspaceProvisioner } from '../provisioners.js'
import type { ShellResult, ShellRunner } from '../shell.js'

const BASE = '/tmp/ia-flow-prov-test'
const REPO = '/repos/demo'
const TASK = 'PVTI_task0001'

function ok(stdout = ''): ShellResult {
  return { stdout, stderr: '', exitCode: 0 }
}
function fail(stderr = 'boom', exitCode = 1): ShellResult {
  return { stdout: '', stderr, exitCode }
}

/** Shell que responde a todo el vocabulario git que usan los provisioners.
 *  Devuelve "no hay worktree todavía" por default. */
class GitStub implements ShellRunner {
  calls: string[][] = []
  constructor(private overrides: (args: string[]) => ShellResult | undefined = () => undefined) {}
  async run(args: string[]): Promise<ShellResult> {
    this.calls.push([...args])
    const override = this.overrides(args)
    if (override) return override
    const cmd = args.slice(1).join(' ')
    if (cmd.startsWith('fetch')) return ok()
    if (cmd.startsWith('worktree prune')) return ok()
    if (cmd.startsWith('worktree list')) return ok(`worktree ${REPO}\n`)
    if (cmd.startsWith('symbolic-ref')) return ok('origin/main\n')
    if (cmd.startsWith('rev-parse')) return fail('missing')
    if (cmd.startsWith('worktree add')) return ok()
    if (cmd.startsWith('status')) return ok('')
    return ok()
  }
  ran(prefix: string): boolean {
    return this.calls.some((c) => c.slice(1).join(' ').startsWith(prefix))
  }
}

const WT = worktreePathFor(REPO, worktreeNameFor({ id: TASK, issueNumber: 42 }), BASE)

/** Disco simulado: sólo REPO está clonado acá. Se inyecta en vez de tocar el
 *  filesystem, igual que el `ShellRunner` — y hace explícito el caso que
 *  motivó `hasLocalClone`: un `path` que el request trae pero este host no
 *  tiene. */
const ON_DISK = (path: string) => path === `${REPO}/.git`

function manager(shell: ShellRunner, opts: Record<string, unknown> = {}) {
  return new WorkspaceManager(shell, { worktreeBase: BASE, exists: ON_DISK, ...opts })
}

function request(over: Partial<WorkspaceRequest> = {}): WorkspaceRequest {
  return {
    taskId: TASK,
    taskTitle: 'Agregar stop',
    issueNumber: 42,
    runId: 'run-1',
    step: 'implement',
    repos: [{ name: 'demo', path: REPO }],
    primaryRepo: 'demo',
    branch: 'feat/stop',
    needsWrite: true,
    ...over,
  }
}

describe('WorktreeWorkspaceProvisioner', () => {
  it('materializa el worktree y lo expone como read+write cuando el agente escribe', async () => {
    const shell = new GitStub()
    const provisioner = new WorktreeWorkspaceProvisioner(manager(shell))

    const plan = await provisioner.prepare(request())

    expect(plan.repoPaths).toEqual({ demo: WT })
    expect(plan.writePaths).toEqual([WT])
    expect(plan.cwd).toBe(WT)
    expect(plan.worktreePath).toBe(WT)
    // La branch del request gana sobre el fallback `task/<id>`.
    expect(plan.branch).toBe('feat/stop')
    expect(shell.ran('worktree add')).toBe(true)
  })

  it('un agente read-only no crea nada y se queda en el repo base', async () => {
    const shell = new GitStub()
    const provisioner = new WorktreeWorkspaceProvisioner(manager(shell))

    const plan = await provisioner.prepare(request({ needsWrite: false }))

    expect(plan.repoPaths).toEqual({ demo: REPO })
    expect(plan.writePaths).toEqual([])
    expect(plan.worktreePath).toBeUndefined()
    expect(shell.ran('worktree add')).toBe(false)
  })

  it('nunca devuelve release — el worktree sobrevive al run para el próximo agente', async () => {
    const provisioner = new WorktreeWorkspaceProvisioner(manager(new GitStub()))
    const plan = await provisioner.prepare(request())
    expect(plan.release).toBeUndefined()
  })

  it('sin path local ni coordenadas de GitHub devuelve un plan vacío en vez de romper', async () => {
    const provisioner = new WorktreeWorkspaceProvisioner(manager(new GitStub()))
    const plan = await provisioner.prepare(request({ repos: [{ name: 'demo' }] }))
    expect(plan.repoPaths).toEqual({})
    expect(plan.worktreePath).toBeUndefined()
  })

  it('ignora un path que este host no tiene y clona por coordenadas', async () => {
    // El caso del dispatch remoto: el daemon corre en un contenedor y copia SU
    // path (`/data/repos/demo`) al request. Acá no existe. Antes se devolvía
    // tal cual como cwd y la sesión arrancaba en el directorio equivocado.
    const shell = new GitStub()
    const provisioner = new WorktreeWorkspaceProvisioner(
      manager(shell, { reposBase: '/tmp/ia-flow-prov-clones' }),
    )

    const plan = await provisioner.prepare(
      request({
        repos: [
          { name: 'demo', path: '/data/repos/demo', githubOwner: 'acme', githubRepo: 'demo' },
        ],
      }),
    )

    expect(shell.ran('clone')).toBe(true)
    expect(plan.cwd).not.toBe('/data/repos/demo')
    expect(plan.repoPaths.demo).not.toBe('/data/repos/demo')
  })

  it('clona el repo cuando el host no lo tiene pero el request trae coordenadas', async () => {
    // Es el caso del gateway remoto: recibe owner/repo, no un path de la
    // máquina que originó el dispatch.
    const shell = new GitStub()
    const provisioner = new WorktreeWorkspaceProvisioner(
      manager(shell, { reposBase: '/tmp/ia-flow-prov-clones' }),
    )

    await provisioner.prepare(
      request({ repos: [{ name: 'demo', githubOwner: 'acme', githubRepo: 'demo' }] }),
    )

    expect(shell.ran('clone')).toBe(true)
  })
})

describe('TerminalWorkspaceProvisioner', () => {
  it('workflow=branch se queda en el repo base y no materializa worktree', async () => {
    const shell = new GitStub()
    const provisioner = new TerminalWorkspaceProvisioner(manager(shell))

    const plan = await provisioner.prepare(request({ workflow: 'branch' }))

    expect(plan.cwd).toBe(REPO)
    expect(plan.worktreePath).toBeUndefined()
    expect(plan.release).toBeUndefined()
    expect(shell.ran('worktree add')).toBe(false)
  })

  it('workflow=worktree materializa el worktree y entrega su limpieza en el plan', async () => {
    const shell = new GitStub()
    const provisioner = new TerminalWorkspaceProvisioner(manager(shell))

    const plan = await provisioner.prepare(request({ workflow: 'worktree' }))

    expect(plan.cwd).toBe(WT)
    expect(plan.worktreePath).toBe(WT)
    expect(plan.release).toBeDefined()

    // La limpieza es la contracara del prepare: ya no vive en el `finally`
    // del orquestador.
    await plan.release?.()
    expect(shell.ran('worktree remove')).toBe(true)
  })

  it('no borra el worktree si quedó trabajo sin commitear', async () => {
    const shell = new GitStub((args) =>
      args.slice(1).join(' ').startsWith('status') ? ok(' M foo.ts\n') : undefined,
    )
    const provisioner = new TerminalWorkspaceProvisioner(manager(shell))

    const plan = await provisioner.prepare(request({ workflow: 'worktree' }))
    await plan.release?.()

    expect(shell.ran('worktree remove')).toBe(false)
  })

  it('deja fuera de repoPaths los repos secundarios cuyo path no existe acá', async () => {
    // Los secundarios alimentan `repoPaths`, o sea lo que ven las fs tools.
    // Uno de otra máquina sería un `fs_read` que falla en vez de una ausencia.
    const provisioner = new TerminalWorkspaceProvisioner(manager(new GitStub()))

    const plan = await provisioner.prepare(
      request({
        workflow: 'branch',
        repos: [
          { name: 'demo', path: REPO },
          { name: 'otro', path: '/data/repos/otro' },
        ],
      }),
    )

    expect(plan.repoPaths).toEqual({ demo: REPO })
  })

  it('un step que no es implement nunca materializa worktree', async () => {
    const shell = new GitStub()
    const provisioner = new TerminalWorkspaceProvisioner(manager(shell))

    const plan = await provisioner.prepare(
      request({ workflow: 'worktree', step: 'refine-technical' }),
    )

    expect(plan.cwd).toBe(REPO)
    expect(shell.ran('worktree add')).toBe(false)
  })
})
