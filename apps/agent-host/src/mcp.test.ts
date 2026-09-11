import { describe, expect, it } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IAgentProvider, ProviderInput, SessionHandle } from '@ia-flow/ai-providers'
import type { Hono } from 'hono'
import { createApp } from './app.js'
import type { Log } from './logger.js'

function silentLog(): Log {
  const log: Log = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => log,
  }
  return log
}

const AUTH = { authorization: 'Bearer secret', 'content-type': 'application/json' }

/** Un provider que aterriza el workspace donde le digamos, como hace el real
 *  vía `prepareWorkspace`. */
function provisioningProvider(
  repoPaths: Record<string, string>,
  opts: { kind?: 'sync' | 'async'; session?: SessionHandle } = {},
): IAgentProvider {
  return {
    id: 'a',
    kind: opts.kind ?? 'sync',
    name: 'a',
    description: 'fake',
    prepareWorkspace: async () => ({ repoPaths, writePaths: Object.values(repoPaths) }),
    run: async () => ({
      content: '',
      mode: 'api',
      ...(opts.session ? { session: opts.session } : {}),
    }),
  } as IAgentProvider
}

/** La policy compilada tal como llega por el cable: `toolNames` es un array,
 *  porque JSON no tiene Set (ver `RemoteAgentProvider`). */
function wirePolicy(allow: string[]) {
  return {
    toolNames: ['bash_run'] as unknown as Set<string>,
    bashRun: { name: 'bash_run' as const, allow, deny: [] },
  }
}

function runBody(overrides: Partial<ProviderInput> = {}): ProviderInput {
  return {
    step: 'implement',
    taskId: 't1',
    taskTitle: 'x',
    taskDescription: '',
    taskType: 'functional',
    repos: ['demo'],
    repoPaths: {},
    prompt: 'hola',
    runId: 'run-1',
    workspace: { taskId: 't1', step: 'implement', repos: [{ name: 'demo' }], needsWrite: false },
    ...overrides,
  } as ProviderInput
}

async function rpc(app: Hono, method: string, params?: unknown, query = '?run=run-1') {
  const res = await app.request(`/v1/mcp${query}`, {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  return { status: res.status, body: res.status === 202 ? null : await res.json() }
}

function repoWithFile(contents: string): { dir: string; paths: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), 'agent-host-mcp-'))
  writeFileSync(join(dir, 'hello.txt'), contents)
  return { dir, paths: { demo: dir } }
}

describe('/v1/mcp — el guard', () => {
  it('exige el token, como el resto de /v1', async () => {
    const app = createApp({ provider: provisioningProvider({}), token: 'secret', log: silentLog() })

    const res = await app.request('/v1/mcp', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    })

    expect(res.status).toBe(401)
  })
})

describe('/v1/mcp — el transporte', () => {
  const app = () =>
    createApp({ provider: provisioningProvider({}), token: 'secret', log: silentLog() })

  it('se presenta como `ia-flow-local`, no como el MCP del daemon', async () => {
    // Son dos servers conectados al mismo run: el nombre es lo que los
    // distingue del lado del cliente.
    const { body } = await rpc(app(), 'initialize')

    expect(body.result.serverInfo.name).toBe('ia-flow-local')
  })

  it('el GET contesta 405 y no 404', async () => {
    // Un cliente Streamable HTTP abre un GET para el stream antes de nada; un
    // 404 le hace dar la conexión entera por muerta.
    const res = await app().request('/v1/mcp', { headers: AUTH })

    expect(res.status).toBe(405)
  })

  it('el DELETE cierra sin cuerpo', async () => {
    const res = await app().request('/v1/mcp', { method: 'DELETE', headers: AUTH })

    expect(res.status).toBe(204)
  })
})

describe('/v1/mcp — qué tools sirve', () => {
  it('ofrece las de disco y NINGUNA del daemon', async () => {
    const app = createApp({ provider: provisioningProvider({}), token: 'secret', log: silentLog() })

    const { body } = await rpc(
      app,
      'tools/list',
      undefined,
      '?run=run-1&tools=fs_read,fs_write,memory_store,add_issue_comment',
    )
    const names = (body.result.tools as Array<{ name: string }>).map((t) => t.name)

    expect(names).toContain('fs_read')
    expect(names).toContain('fs_write')
    // Estado del daemon: sin la conexión a la fuente ni las credenciales,
    // servirlas acá sería ofrecer algo que no puede funcionar.
    expect(names).not.toContain('memory_store')
    expect(names).not.toContain('add_issue_comment')
  })

  it('ofrece bash_run y workspace_reset — acá el sandbox SÍ existe', async () => {
    // Declaran `providerKinds: ['sync']` porque el daemon, sirviendo a un CLI,
    // no construye worktree ni writePaths. Este proceso sí: `prepareWorkspace`
    // los armó antes de arrancar el run. Y encima llegan con el allow/deny de
    // la policy, que el Bash nativo del CLI no tiene.
    const app = createApp({ provider: provisioningProvider({}), token: 'secret', log: silentLog() })

    const { body } = await rpc(
      app,
      'tools/list',
      undefined,
      '?run=run-1&tools=bash_run,workspace_reset',
    )
    const names = (body.result.tools as Array<{ name: string }>).map((t) => t.name)

    expect(names).toContain('bash_run')
    expect(names).toContain('workspace_reset')
  })

  it('rechaza ejecutar una tool que no sirve, aunque la nombren', async () => {
    const app = createApp({ provider: provisioningProvider({}), token: 'secret', log: silentLog() })

    const { body } = await rpc(
      app,
      'tools/call',
      { name: 'memory_store', arguments: { key: 'k', value: 'v' } },
      '?run=run-1&tools=memory_store',
    )

    expect(body.result.isError).toBe(true)
    expect(body.result.content[0].text).toContain('not found')
  })
})

/** El caso para el que existe `/v1/mcp`: un provider async deja la sesión
 *  corriendo y el CLI pide sus tools por acá, después. */
function asyncApp(paths: Record<string, string>) {
  const session: SessionHandle = {
    kind: 'tmux',
    id: 's1',
    liveness: async () => 'alive',
    close: async () => {},
  }
  return createApp({
    provider: provisioningProvider(paths, { kind: 'async', session }),
    token: 'secret',
    log: silentLog(),
  })
}

describe('/v1/mcp — contra el disco del agent-host', () => {
  it('un fs_read resuelve el workspace que preparó ESTE agent-host', async () => {
    // El corazón del cambio: el daemon mandó coordenadas, `prepareWorkspace`
    // las aterrizó acá, y la tool lee de ese path — no del disco del daemon,
    // que es donde caía cuando la única entrega de tools era el MCP remoto.
    const { paths } = repoWithFile('contenido local\n')
    const app = asyncApp(paths)

    await app.request('/v1/run', { method: 'POST', headers: AUTH, body: JSON.stringify(runBody()) })
    const { body } = await rpc(
      app,
      'tools/call',
      { name: 'fs_read', arguments: { path: 'demo/hello.txt' } },
      '?run=run-1&tools=fs_read',
    )

    expect(body.result.isError).toBeUndefined()
    expect(body.result.content[0].text).toContain('contenido local')
  })

  it('un run desconocido no cae al workspace de otro', async () => {
    // Mejor sin repoPaths —la tool rechaza por path desconocido— que operando
    // sobre el workspace equivocado.
    const { paths } = repoWithFile('no deberías ver esto\n')
    const app = asyncApp(paths)

    await app.request('/v1/run', { method: 'POST', headers: AUTH, body: JSON.stringify(runBody()) })
    const { body } = await rpc(
      app,
      'tools/call',
      { name: 'fs_read', arguments: { path: 'demo/hello.txt' } },
      '?run=otro-run&tools=fs_read',
    )

    expect(body.result.isError).toBe(true)
  })

  it('un run SYNC no deja su workspace colgado', async () => {
    // Su loop de tools corrió adentro de `provider.run()` y ya terminó: no
    // hay nadie que vaya a pedirle nada a `/v1/mcp`, y retenerlo haría
    // crecer el mapa con cada run.
    const { paths } = repoWithFile('ya terminó\n')
    const app = createApp({
      provider: provisioningProvider(paths),
      token: 'secret',
      log: silentLog(),
    })

    await app.request('/v1/run', { method: 'POST', headers: AUTH, body: JSON.stringify(runBody()) })
    const { body } = await rpc(
      app,
      'tools/call',
      { name: 'fs_read', arguments: { path: 'demo/hello.txt' } },
      '?run=run-1&tools=fs_read',
    )

    expect(body.result.isError).toBe(true)
  })
})

describe('/v1/mcp — bash_run de verdad', () => {
  it('ejecuta un comando permitido contra el disco del agent-host', async () => {
    // Ofrecerla en `tools/list` no alcanza: `bash_run` saca su allow/deny de
    // `ctx.policy.bashRun`, que llega en el `ProviderInput` del run. Sin
    // propagarlo, la tool quedaba ofrecida y moría en la primera llamada con
    // "bash_run no habilitado".
    const { paths } = repoWithFile('x\n')
    const app = asyncApp(paths)

    await app.request('/v1/run', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify(
        runBody({
          policy: wirePolicy(['echo']) as never,
          // `bash_run` exige una zona escribible; el engine la concede desde
          // las tools del agente (`needsWrite`).
          workspace: {
            taskId: 't1',
            step: 'implement',
            repos: [{ name: 'demo' }],
            needsWrite: true,
          },
        } as Partial<ProviderInput>),
      ),
    })
    const { body } = await rpc(
      app,
      'tools/call',
      { name: 'bash_run', arguments: { command: 'echo hola', repo: 'demo' } },
      '?run=run-1&tools=bash_run',
    )

    expect(body.result.content[0].text).toContain('hola')
  })

  it('un comando fuera del allow sigue rechazado', async () => {
    // La policy no se pierde NI se afloja al cruzar el MCP.
    const { paths } = repoWithFile('x\n')
    const app = asyncApp(paths)

    await app.request('/v1/run', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify(
        runBody({
          policy: wirePolicy(['echo']) as never,
          // `bash_run` exige una zona escribible; el engine la concede desde
          // las tools del agente (`needsWrite`).
          workspace: {
            taskId: 't1',
            step: 'implement',
            repos: [{ name: 'demo' }],
            needsWrite: true,
          },
        } as Partial<ProviderInput>),
      ),
    })
    const { body } = await rpc(
      app,
      'tools/call',
      { name: 'bash_run', arguments: { command: 'rm -rf /', repo: 'demo' } },
      '?run=run-1&tools=bash_run',
    )

    expect(body.result.content[0].text).toContain('no permitido')
  })
})

describe('/v1/mcp — vida del workspace', () => {
  it('un run async conserva su workspace después de que /v1/run respondió', async () => {
    // `provider.run()` de un async vuelve apenas lanzó la sesión: las tools
    // del CLI llegan DESPUÉS. Liberarlo en el `finally` dejaba a la primera
    // tool del agente sin su repo.
    const { paths } = repoWithFile('sigo acá\n')
    const session: SessionHandle = {
      kind: 'tmux',
      id: 's1',
      liveness: async () => 'alive',
      close: async () => {},
    }
    const app = createApp({
      provider: provisioningProvider(paths, { kind: 'async', session }),
      token: 'secret',
      log: silentLog(),
    })

    await app.request('/v1/run', { method: 'POST', headers: AUTH, body: JSON.stringify(runBody()) })
    const { body } = await rpc(
      app,
      'tools/call',
      { name: 'fs_read', arguments: { path: 'demo/hello.txt' } },
      '?run=run-1&tools=fs_read',
    )

    expect(body.result.content[0].text).toContain('sigo acá')
  })

  it('cerrar la sesión libera el workspace', async () => {
    const { paths } = repoWithFile('efímero\n')
    const session: SessionHandle = {
      kind: 'tmux',
      id: 's1',
      liveness: async () => 'alive',
      close: async () => {},
    }
    const app = createApp({
      provider: provisioningProvider(paths, { kind: 'async', session }),
      token: 'secret',
      log: silentLog(),
    })

    await app.request('/v1/run', { method: 'POST', headers: AUTH, body: JSON.stringify(runBody()) })
    await app.request('/v1/sessions/s1', { method: 'DELETE', headers: AUTH })
    const { body } = await rpc(
      app,
      'tools/call',
      { name: 'fs_read', arguments: { path: 'demo/hello.txt' } },
      '?run=run-1&tools=fs_read',
    )

    expect(body.result.isError).toBe(true)
  })
})
