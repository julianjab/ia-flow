import { describe, expect, it } from 'bun:test'
import '../index.js'
import { getTool, partitionToolsByDisk } from '../engine.js'

describe('partitionToolsByDisk', () => {
  it('manda las tools de filesystem al disco del agente', () => {
    const { agentDisk, daemon } = partitionToolsByDisk([
      'fs_read',
      'fs_write',
      'fs_edit',
      'fs_grep',
      'fs_glob',
      'fs_list',
    ])

    expect(agentDisk.sort()).toEqual(
      ['fs_edit', 'fs_glob', 'fs_grep', 'fs_list', 'fs_read', 'fs_write'].sort(),
    )
    expect(daemon).toEqual([])
  })

  it('deja en el daemon lo que es estado del daemon', () => {
    // La fuente de issues, GitHub, Slack y la memoria necesitan la conexión
    // al source, las credenciales y el namespace — nada de eso vive en el
    // agent-host.
    const { agentDisk, daemon } = partitionToolsByDisk([
      'memory_store',
      'add_issue_comment',
      'select_exit',
    ])

    expect(agentDisk).toEqual([])
    expect(daemon).toEqual(['memory_store', 'add_issue_comment', 'select_exit'])
  })

  it('bash_run y workspace_reset son del disco del agente', () => {
    // Son las dos que hoy se excluyen del camino async con
    // `providerKinds: ['sync']` justamente porque no había dónde correrlas.
    const { agentDisk } = partitionToolsByDisk(['bash_run', 'workspace_reset'])

    expect(agentDisk).toEqual(['bash_run', 'workspace_reset'])
  })

  it('resuelve alias al tool canónico para clasificar', () => {
    // `read_file` es alias de `fs_read`; sin resolverlo caería al daemon.
    const { agentDisk, daemon } = partitionToolsByDisk(['read_file'])

    expect(agentDisk).toEqual(['read_file'])
    expect(daemon).toEqual([])
  })

  it('un nombre desconocido cae al daemon', () => {
    // Default seguro: el catálogo completo vive allá.
    expect(getTool('no_existe')).toBeUndefined()

    const { agentDisk, daemon } = partitionToolsByDisk(['no_existe'])

    expect(agentDisk).toEqual([])
    expect(daemon).toEqual(['no_existe'])
  })

  it('conserva el orden y el nombre tal como lo declaró el agente', () => {
    const { agentDisk, daemon } = partitionToolsByDisk(['memory_list', 'fs_read', 'select_exit'])

    expect(agentDisk).toEqual(['fs_read'])
    expect(daemon).toEqual(['memory_list', 'select_exit'])
  })
})
