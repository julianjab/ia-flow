import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { dependencyNotice, MAX_SEEDS, NodeDependencies, seedPathFor } from '../nodeDeps.js'
import { NodeShellRunner, type ShellRunner } from '../shell.js'

/** Un checkout de mentira: `package.json`, su lockfile y, si se pide, un `node_modules`. */
function checkout(root: string, name: string, opts: { lock?: string; modules?: boolean } = {}) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), '{"name":"app"}')
  if (opts.lock !== undefined) writeFileSync(join(dir, 'yarn.lock'), opts.lock)
  if (opts.modules) {
    mkdirSync(join(dir, 'node_modules', 'vue'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'vue', 'index.js'), `module.exports = '${name}'`)
  }
  return dir
}

/** El clone del repo: con `.git` directorio, donde viven las semillas. */
function clone(root: string) {
  const dir = join(root, 'clone')
  mkdirSync(join(dir, '.git'), { recursive: true })
  return dir
}

const deps = (shell: ShellRunner = new NodeShellRunner()) => new NodeDependencies(shell)
const tmp = () => mkdtempSync(join(tmpdir(), 'ws-deps-'))

describe('NodeDependencies.ensure', () => {
  it('fuera de un repo de Node no hace nada', async () => {
    const root = tmp()
    const wt = join(root, 'wt')
    mkdirSync(wt)
    expect(await deps().ensure(wt, clone(root), [])).toEqual({ kind: 'not-node' })
  })

  it('con package.json pero sin lockfile tampoco: no hay contra qué comparar', async () => {
    const root = tmp()
    expect((await deps().ensure(checkout(root, 'wt'), clone(root), [])).kind).toBe('not-node')
  })

  it('si ya tiene node_modules, lo deja', async () => {
    const root = tmp()
    const wt = checkout(root, 'wt', { lock: 'a', modules: true })
    expect(await deps().ensure(wt, clone(root), [])).toEqual({
      kind: 'present',
      lockfile: 'yarn.lock',
    })
  })

  it('copia el de un hermano con el mismo lockfile, como copia propia', async () => {
    const root = tmp()
    const sibling = checkout(root, 'task-1', { lock: 'a', modules: true })
    const wt = checkout(root, 'task-2', { lock: 'a' })
    const status = await deps().ensure(wt, clone(root), [wt, sibling])
    expect(status).toMatchObject({ kind: 'reused', lockfile: 'yarn.lock' })
    const copied = join(wt, 'node_modules', 'vue', 'index.js')
    expect(readFileSync(copied, 'utf8')).toContain('task-1')
    // Otro inodo: escribir en la copia no toca al hermano (ni a una semilla).
    writeFileSync(copied, 'cambiado')
    expect(readFileSync(join(sibling, 'node_modules', 'vue', 'index.js'), 'utf8')).toContain(
      'task-1',
    )
    expect(statSync(copied).ino).not.toBe(
      statSync(join(sibling, 'node_modules', 'vue', 'index.js')).ino,
    )
  })

  it('no copia de un hermano con OTRO lockfile', async () => {
    const root = tmp()
    const sibling = checkout(root, 'task-1', { lock: 'otro', modules: true })
    const wt = checkout(root, 'task-2', { lock: 'a' })
    const status = await deps().ensure(wt, clone(root), [sibling])
    expect(status.kind).toBe('missing')
    expect(existsSync(join(wt, 'node_modules'))).toBe(false)
  })

  it('sin de dónde copiar, queda sin node_modules y se lo dice al agente', async () => {
    const root = tmp()
    const status = await deps().ensure(checkout(root, 'wt', { lock: 'a' }), clone(root), [])
    expect(status.kind).toBe('missing')
    const notice = dependencyNotice(status) ?? ''
    expect(notice).toContain('sin node_modules')
    expect(notice).toContain('UNA vez')
  })

  it('una copia que falla no deja nada a medias ni tira', async () => {
    const root = tmp()
    const sibling = checkout(root, 'task-1', { lock: 'a', modules: true })
    const wt = checkout(root, 'task-2', { lock: 'a' })
    const failing: ShellRunner = {
      run: async (args) => {
        // Empieza a copiar (el destino es absoluto) y se corta.
        mkdirSync(args[args.length - 1] as string, { recursive: true })
        return { exitCode: 1, stdout: '', stderr: 'cp: No space left on device' }
      },
    }
    const status = await deps(failing).ensure(wt, clone(root), [sibling])
    expect(status).toMatchObject({ kind: 'missing' })
    expect(status.kind === 'missing' && status.reason).toContain('No space left')
    expect(readdirSync(wt).filter((f) => f !== 'package.json' && f !== 'yarn.lock')).toEqual([])
  })

  it('borra la copia a medias de una corrida que se cayó', async () => {
    const root = tmp()
    const wt = checkout(root, 'wt', { lock: 'a' })
    mkdirSync(join(wt, '.ia-flow-node_modules-123-456', 'vue'), { recursive: true })
    await deps().ensure(wt, clone(root), [])
    expect(existsSync(join(wt, '.ia-flow-node_modules-123-456'))).toBe(false)
  })
})

describe('NodeDependencies.harvest', () => {
  it('al borrar un worktree, su node_modules pasa a semilla y el próximo lo copia de ahí', async () => {
    const root = tmp()
    const repo = clone(root)
    const gone = checkout(root, 'task-1', { lock: 'a', modules: true })
    const seed = deps().harvest(gone, repo)
    expect(seed).toBeDefined()
    expect(seed?.startsWith(join(repo, '.git', 'ia-flow-deps'))).toBe(true)
    expect(existsSync(join(gone, 'node_modules'))).toBe(false)

    // Sin hermanos vivos: la semilla alcanza.
    const wt = checkout(root, 'task-2', { lock: 'a' })
    const status = await deps().ensure(wt, repo, [])
    expect(status).toMatchObject({ kind: 'reused', from: seed })
    expect(existsSync(join(wt, 'node_modules', 'vue', 'index.js'))).toBe(true)
    expect(existsSync(seed as string)).toBe(true)
  })

  it('no pisa una semilla que ya existe para ese lockfile', () => {
    const root = tmp()
    const repo = clone(root)
    const first = checkout(root, 'task-1', { lock: 'a', modules: true })
    const second = checkout(root, 'task-2', { lock: 'a', modules: true })
    expect(deps().harvest(first, repo)).toBeDefined()
    expect(deps().harvest(second, repo)).toBeUndefined()
    expect(existsSync(join(second, 'node_modules'))).toBe(true)
  })

  it('sin .git directorio (el clone es un worktree) no siembra', () => {
    const root = tmp()
    const repo = join(root, 'clone')
    mkdirSync(repo)
    writeFileSync(join(repo, '.git'), 'gitdir: /otro')
    const wt = checkout(root, 'task-1', { lock: 'a', modules: true })
    expect(seedPathFor(repo, 'x')).toBeUndefined()
    expect(deps().harvest(wt, repo)).toBeUndefined()
  })

  it(`quedan las ${MAX_SEEDS} semillas más nuevas`, async () => {
    const root = tmp()
    const repo = clone(root)
    for (const lock of ['a', 'b', 'c']) {
      const wt = checkout(root, `task-${lock}`, { lock, modules: true })
      deps().harvest(wt, repo)
      // mtime distintos aunque el reloj del disco sea grueso.
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    await expect.poll(() => readdirSync(join(repo, '.git', 'ia-flow-deps')).length).toBe(MAX_SEEDS)
  })
})
