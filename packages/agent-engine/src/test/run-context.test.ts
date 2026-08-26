import { describe, expect, it } from 'bun:test'
import type { AgentDefinition, Task } from '@ia-flow/shared'
import type { DbRepoEntry, IRepoRepository } from '../contract.js'
import { resolveRunContext } from '../run-context.js'

// El catálogo del proyecto NO tiene `web-app`: es el caso de una tarea
// funcional multirepo donde alguien escribió a mano el custom field "Repos"
// del board y uno de los nombres todavía no está registrado en ia-flow.
const repoRepo: IRepoRepository = {
  listByProject: (projectId: string): DbRepoEntry[] =>
    projectId === 'la-haus'
      ? [{ name: 'subscriptions', projectId, path: '/repos/subscriptions' } as DbRepoEntry]
      : [],
  list: () => [],
} as unknown as IRepoRepository

const task = {
  id: 't1',
  title: 'Cobros recurrentes en el portal',
  status: 'refine',
  projectId: 'la-haus',
  repos: ['web-app', 'subscriptions'],
  type: 'functional',
} as unknown as Task

function agent(over: Partial<AgentDefinition>): AgentDefinition {
  return {
    id: 'a1',
    name: 'a1',
    enabled: true,
    statusName: 'refine',
    ...over,
  } as unknown as AgentDefinition
}

const expandHome = (p: string) => p

describe('resolveRunContext — repo del task fuera del catálogo', () => {
  it('deja correr al agente que no escribe en disco', async () => {
    // Un refiner que trabaja por el MCP de GitHub nunca toca `primaryPath`, así
    // que un repo sin registrar no le impide nada. Cancelarle el dispatch mata
    // justo el issue que tenía que desglosar.
    const ctx = await resolveRunContext({
      task,
      agents: [agent({ tools: ['update_issue_body'] as unknown as AgentDefinition['tools'] })],
      repoRepo,
      expandHome,
    })

    expect(ctx).not.toBeNull()
    expect(ctx?.primaryRepoName).toBe('web-app')
    // Sin registro no hay path ni workflow — y está bien: nadie los va a usar.
    expect(ctx?.primaryPath).toBeUndefined()
    expect(ctx?.primaryTaskRepo).toBeUndefined()
  })

  it('cancela el dispatch del agente que sí escribe', async () => {
    // Acá el lookup sí importa: sin path, el provisioner no tiene dónde crear
    // el worktree y el run fallaría más adelante, con un error peor de leer.
    const ctx = await resolveRunContext({
      task,
      agents: [agent({ tools: ['fs_write', 'fs_read'] as unknown as AgentDefinition['tools'] })],
      repoRepo,
      expandHome,
    })

    expect(ctx).toBeNull()
  })

  it('no se queja cuando el repo primario sí está registrado', async () => {
    const ctx = await resolveRunContext({
      task: { ...task, repos: ['subscriptions'] },
      agents: [agent({ tools: ['fs_write'] as unknown as AgentDefinition['tools'] })],
      repoRepo,
      expandHome,
    })

    expect(ctx?.primaryPath).toBe('/repos/subscriptions')
  })
})
