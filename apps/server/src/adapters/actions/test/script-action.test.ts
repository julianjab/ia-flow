import { describe, expect, test } from 'bun:test'
import type { ActionContext } from '@ia-flow/rules'
import { createEvent } from '@ia-flow/shared'
import { ScriptAction, resolveInsideWorkspace } from '../script-action.js'

// Las guardas son la razón de ser de esta acción, así que son lo que se testea.
// Un `script` sin ellas es una shell remota configurable desde el navegador.

const ctx = (payload: Record<string, unknown> = {}): ActionContext =>
  ({
    event: createEvent({
      type: 'pr.opened',
      source: 'github',
      scope: { projectId: 'p1', repos: ['web'] },
      payload,
    }),
    rule: { id: 'r1' },
    emit: async () => {},
  }) as unknown as ActionContext

const config = (over: Record<string, unknown> = {}) =>
  ({ action: 'script', runtime: 'bash', file: 'ok.sh', ...over }) as never

/** Un spawn falso que anota con qué lo llamaron y sale 0. */
function fakeSpawn() {
  const calls: Array<{ argv: string[]; opts: Record<string, unknown> }> = []
  const spawn = ((argv: string[], opts: Record<string, unknown>) => {
    calls.push({ argv, opts })
    return {
      stdout: new Response('listo').body,
      stderr: new Response('').body,
      exited: Promise.resolve(0),
      kill: () => {},
    }
  }) as unknown as typeof Bun.spawn
  return { spawn, calls }
}

const ENABLED = { IA_FLOW_ENABLE_SCRIPT_ACTIONS: '1', IA_FLOW_API_TOKEN: 'secreto', PATH: '/bin' }

function action(over: Partial<Parameters<typeof ScriptAction.prototype.execute>> | object = {}) {
  const { spawn, calls } = fakeSpawn()
  const a = new ScriptAction({
    workspaceFor: async () => '/repo',
    spawn,
    env: ENABLED,
    ...(over as object),
  })
  return { a, calls }
}

describe('ScriptAction — las guardas', () => {
  // 1. Apagada por default: algo de este calibre no puede aparecer porque
  //    alguien actualizó el producto.
  test('sin la env var, no corre', async () => {
    const { a, calls } = action({ env: { IA_FLOW_API_TOKEN: 'x' } })
    const r = await a.execute(ctx(), config())

    expect(r.ok).toBe(false)
    expect(r.detail).toContain('deshabilitadas')
    expect(calls).toHaveLength(0)
  })

  // 1b. La capacidad peligrosa arrastra su propia precondición: sin auth en la
  //     API, cualquiera que la alcance ejecuta código en esta máquina.
  test('habilitada pero SIN token de API, no corre', async () => {
    const { a, calls } = action({ env: { IA_FLOW_ENABLE_SCRIPT_ACTIONS: '1' } })
    const r = await a.execute(ctx(), config())

    expect(r.ok).toBe(false)
    expect(r.detail).toContain('IA_FLOW_API_TOKEN')
    expect(calls).toHaveLength(0)
  })

  // 2. Sin repo no hay dónde correr, y hacerlo en el cwd del daemon sería
  //    correr al lado de su config y sus credenciales.
  test('sin workspace, no corre', async () => {
    const { a, calls } = action({ workspaceFor: async () => null })
    const r = await a.execute(ctx(), config())

    expect(r.ok).toBe(false)
    expect(r.detail).toContain('no tiene un repo')
    expect(calls).toHaveLength(0)
  })

  // 3. El escape del workspace.
  test('una ruta que se escapa del workspace se rechaza', async () => {
    const { a, calls } = action()
    for (const file of ['../fuera.sh', 'sub/../../fuera.sh', '../../etc/passwd']) {
      const r = await a.execute(ctx(), config({ file }))
      expect(r.ok).toBe(false)
      expect(r.detail).toContain('se sale del workspace')
    }
    expect(calls).toHaveLength(0)
  })

  // 4. Sin shell: argv, nunca `sh -c`. Un valor con `;` es un argumento.
  test('spawnea argv directo, sin shell', async () => {
    const { a, calls } = action()
    await a.execute(ctx(), config({ runtime: 'python', args: ['uno', 'dos; rm -rf /'] }))

    expect(calls[0]?.argv).toEqual(['python3', '-u', '/repo/ok.sh', 'uno', 'dos; rm -rf /'])
    // Nada de `sh`, `bash -c` ni `/bin/sh` en la invocación.
    expect(calls[0]?.argv.join(' ')).not.toContain('-c')
  })

  // 5. La guarda que más protege: el script NO hereda el env del daemon.
  test('el env es allow-list, no el del daemon', async () => {
    const { a, calls } = action()
    await a.execute(
      ctx({ pr: { number: 42 } }),
      config({ env: { PR: '{{event.payload.pr.number}}' } }),
    )

    const env = calls[0]?.opts.env as Record<string, string>
    expect(env.PR).toBe('42')
    expect(env.PATH).toBeTruthy()
    // Lo que NO tiene que estar: cualquier credencial del proceso.
    expect(env.IA_FLOW_API_TOKEN).toBeUndefined()
    expect(env.GITHUB_TOKEN).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(Object.keys(env).sort()).toEqual(['PATH', 'PR'])
  })

  test('corre en el workspace y no en el cwd del daemon', async () => {
    const { a, calls } = action()
    await a.execute(ctx(), config())
    expect(calls[0]?.opts.cwd).toBe('/repo')
  })

  test('un exit distinto de 0 es un fallo con su salida', async () => {
    const a = new ScriptAction({
      workspaceFor: async () => '/repo',
      env: ENABLED,
      spawn: (() => ({
        stdout: new Response('').body,
        stderr: new Response('explotó').body,
        exited: Promise.resolve(2),
        kill: () => {},
      })) as unknown as typeof Bun.spawn,
    })

    const r = await a.execute(ctx(), config())
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('exit 2')
    expect(r.detail).toContain('explotó')
  })
})

describe('resolveInsideWorkspace', () => {
  // `relative` y no `startsWith`: '/repo-malo' empieza con '/repo' y pasaría
  // el chequeo ingenuo.
  test('un directorio hermano con prefijo comun no pasa', () => {
    expect(resolveInsideWorkspace('/repo', '../repo-malo/x.sh')).toBeNull()
  })

  test('una ruta adentro resuelve absoluta', () => {
    expect(resolveInsideWorkspace('/repo', 'scripts/x.sh')).toBe('/repo/scripts/x.sh')
  })

  test('un `..` que vuelve a entrar es válido', () => {
    expect(resolveInsideWorkspace('/repo', 'a/../b.sh')).toBe('/repo/b.sh')
  })
})
