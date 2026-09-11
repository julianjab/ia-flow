import { describe, expect, it } from 'bun:test'
import '../index.js'
import { handleMcpRequest, type McpConnection } from './server.js'

/** El daemon: sirve todo lo del registry y resuelve como `async`. */
const daemonDeps = {
  serverName: 'ia-flow-tools',
  buildContext: () => ({ repoPaths: {} }),
}

async function list(conn: McpConnection): Promise<string[]> {
  const res = await handleMcpRequest(
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    conn,
    daemonDeps,
  )
  const body = res.body as { result: { tools: Array<{ name: string }> } }
  return body.result.tools.map((t) => t.name)
}

describe('handleMcpRequest — el `kind` de la conexión', () => {
  it('sin declararlo, un cliente async recibe las tools de cierre', async () => {
    expect(await list({ toolNames: ['fs_read'] })).toContain('complete_task')
  })

  it('`sync` saca `complete_task`: ese éxito lo infiere el engine', async () => {
    // Un `claude -p` cierra por `stopReason`. Ofrecerle `complete_task` le
    // daría un segundo cierre que le saca la task del registry a mitad del run.
    expect(await list({ toolNames: ['fs_read'], closesWith: 'sync' })).not.toContain(
      'complete_task',
    )
  })

  it('pero `fail_task` se queda — un fallo intencional no se infiere', async () => {
    // `Agent.run` deduce éxito de un `end_turn`, pero `stopReason` no
    // distingue "terminé bien" de "me rindo, por esto". Por eso esa tool
    // declara los dos kinds (ver task.ts) y el recorte no la toca.
    expect(await list({ toolNames: ['fs_read'], closesWith: 'sync' })).toContain('fail_task')
  })

  it('sólo QUITA: no le abre la puerta a las sync-only', async () => {
    // `bash_run` y `workspace_reset` piden un sandbox que el daemon,
    // sirviendo a un CLI, no construye. Un cliente no puede desbloquearlas
    // declarándose sync.
    const names = await list({ toolNames: ['bash_run', 'workspace_reset'], closesWith: 'sync' })

    expect(names).not.toContain('bash_run')
    expect(names).not.toContain('workspace_reset')
  })

  it('lo que el agente pidió sigue ahí', async () => {
    expect(await list({ toolNames: ['fs_read'], closesWith: 'sync' })).toContain('fs_read')
  })

  it('tampoco deja EJECUTAR lo que no ofreció', async () => {
    // El recorte se re-aplica en `tools/call`: sin eso, nombrar la tool la
    // corría igual.
    const res = await handleMcpRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'complete_task' } },
      { toolNames: ['fs_read'], closesWith: 'sync' },
      daemonDeps,
    )
    const body = res.body as { result: { isError?: boolean; content: Array<{ text: string }> } }

    expect(body.result.isError).toBe(true)
    expect(body.result.content[0]?.text).toContain('not found')
  })
})
