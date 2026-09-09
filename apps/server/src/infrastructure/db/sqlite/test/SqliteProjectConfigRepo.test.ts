import { describe, expect, it } from 'bun:test'
import type { AgentDefinition, SystemPromptDef } from '@ia-flow/shared'
import type { IAgentRepository } from '../../../../domain/ports/IAgentRepository.js'
import type { IGlobalSettingsRepository } from '../../../../domain/ports/IGlobalSettingsRepository.js'
import type { IProjectRepository } from '../../../../domain/ports/IProjectRepository.js'
import type { IStatusRepository } from '../../../../domain/ports/IStatusRepository.js'
import type { ISystemPromptRepository } from '../../../../domain/ports/ISystemPromptRepository.js'
import { SqliteProjectConfigRepo } from '../SqliteProjectConfigRepo.js'

function fakeProjectRepo(defaultId: string | null): IProjectRepository {
  return {
    getDefaultId: () => defaultId,
    list: () => [],
    get: () => null,
    upsert: () => {
      throw new Error('not implemented')
    },
    archive: () => {},
    deleteCascade: () => {},
  }
}

const fakeSystemPromptRepo: ISystemPromptRepository = {
  getById: () => null,
  inScope: (projectId?: string | null) =>
    (projectId === null
      ? [{ id: 'global-sp', name: 'Global', text: '...', projectId: null }]
      : []) as SystemPromptDef[],
  visibleTo: () => [],
  upsert: () => {},
  deleteById: () => {},
  reorder: () => {},
} as unknown as ISystemPromptRepository

const fakeStatusRepo: IStatusRepository = {
  list: () => {
    throw new Error('statusRepo.list no debería llamarse sin proyecto resuelto')
  },
  upsert: () => {},
  deleteByName: () => {},
  reorder: () => {},
} as unknown as IStatusRepository

const fakeSettingsRepo: IGlobalSettingsRepository = {
  getScanRoots: () => [],
  setScanRoots: () => {},
} as unknown as IGlobalSettingsRepository

const fakeAgentRepo: IAgentRepository = {
  inScope: (projectId: string | null) =>
    projectId === null ? [{ id: 'global-agent' } as AgentDefinition] : [],
  visibleTo: () => [],
  upsert: () => {},
  deleteById: () => {},
  setPositions: () => {},
  isReadOnly: () => false,
} as unknown as IAgentRepository

describe('SqliteProjectConfigRepo.getConfig — sin proyecto default', () => {
  it('cae al scope global en vez de tirar cuando projects está vacía', async () => {
    const repo = new SqliteProjectConfigRepo(
      fakeSystemPromptRepo,
      fakeProjectRepo(null),
      fakeStatusRepo,
      fakeSettingsRepo,
      fakeAgentRepo,
    )
    const config = await repo.getConfig(undefined)
    expect(config.project?.name).toBeUndefined()
    expect(config.agents).toEqual([{ id: 'global-agent' } as AgentDefinition])
    expect(config.statuses).toEqual([])
  })
})
