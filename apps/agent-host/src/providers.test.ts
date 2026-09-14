import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { getWorkspaceManagerPort } from '@ia-flow/tools'
import { createProvider } from './providers.js'

const originalAgentHostProvider = Bun.env.AGENT_HOST_PROVIDER

beforeEach(() => {
  delete Bun.env.AGENT_HOST_PROVIDER
})

afterEach(() => {
  if (originalAgentHostProvider === undefined) delete Bun.env.AGENT_HOST_PROVIDER
  else Bun.env.AGENT_HOST_PROVIDER = originalAgentHostProvider
})

describe('createProvider', () => {
  it('sin AGENT_HOST_PROVIDER seteado, resuelve anthropic-api por default', () => {
    const provider = createProvider()
    expect(provider.id).toBe('anthropic-api')
    expect(provider.kind).toBe('sync')
  })

  it('AGENT_HOST_PROVIDER=claude-print resuelve claude-print', () => {
    Bun.env.AGENT_HOST_PROVIDER = 'claude-print'
    const provider = createProvider()
    expect(provider.id).toBe('claude-print')
    expect(provider.kind).toBe('sync')
  })

  it('AGENT_HOST_PROVIDER con un valor desconocido cae al default (anthropic-api)', () => {
    Bun.env.AGENT_HOST_PROVIDER = 'algo-que-no-existe'
    const provider = createProvider()
    expect(provider.id).toBe('anthropic-api')
  })

  it('claude-print trae `prepareWorkspace` cableado — sin esto el cwd del run es el del daemon, no el de acá', () => {
    // Regresión: sin `workspace: createWorkspaceProvisioner(...)` en el branch
    // de claude-print, `prepareWorkspace` no existía y `resolveWorkspace`
    // (app.ts) dejaba `input.cwd` tal cual llegó del dispatch — un path del
    // disco que originó el run, inexistente en esta máquina. Cada run fallaba
    // con ENOENT de `Bun.spawn`.
    const provider = createProvider('claude-print')
    expect(typeof provider.prepareWorkspace).toBe('function')
  })
})

describe('el port del WorkspaceManager', () => {
  it('queda cableado — sin esto `workspace_reset` contesta "unavailable"', () => {
    // El loop de tools de un run remoto corre en ESTE proceso, así que el
    // singleton contra el que opera `workspace_reset` tiene que apuntar al
    // manager que preparó este workspace. El daemon lo hace en su composition
    // root; acá faltaba y la tool fallaba en toda invocación.
    createProvider('anthropic-api')

    expect(getWorkspaceManagerPort()).not.toBeNull()
  })

  it('también queda cableado para claude-print', () => {
    createProvider('claude-print')

    expect(getWorkspaceManagerPort()).not.toBeNull()
  })
})
