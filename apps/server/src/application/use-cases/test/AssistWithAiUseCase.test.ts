import { describe, expect, test } from 'bun:test'
import type { AgentDefinition, AssistCallerConfig, SystemPromptDef } from '@ia-flow/shared'
import type { IAgentRepository } from '../../../domain/ports/IAgentRepository.js'
import type { IAssistCallerConfigRepository } from '../../../domain/ports/IAssistCallerConfigRepository.js'
import type { IProjectRepository } from '../../../domain/ports/IProjectRepository.js'
import type { ISystemPromptRepository } from '../../../domain/ports/ISystemPromptRepository.js'
import { AssistWithAiUseCase, resolveCallerConfigBlocks } from '../AssistWithAiUseCase.js'

// `buildContext` es privado en TS pero no en runtime — es la única forma de
// testear el merge sin pasar por un fetch real a Anthropic (ver
// `runPlainCompletion`, que sí llama a la red).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyUseCase = any

function fakeSystemPromptRepo(prompts: SystemPromptDef[]): ISystemPromptRepository {
  return {
    getById: (id: string) => prompts.find((p) => p.id === id) ?? null,
    inScope: () => prompts,
    visibleTo: () => prompts,
    upsert: () => {},
    deleteById: () => {},
    clearScope: () => {},
  } as unknown as ISystemPromptRepository
}

function fakeProjectRepo(): IProjectRepository {
  return { getDefaultId: () => 'p1' } as unknown as IProjectRepository
}

function fakeCallerConfigRepo(configs: AssistCallerConfig[]): IAssistCallerConfigRepository {
  return {
    list: () => configs,
    getById: (agentId) => configs.find((c) => c.agentId === agentId) ?? null,
    upsert: () => {},
    deleteById: () => {},
  }
}

function fakeAgentRepo(agents: AgentDefinition[]): IAgentRepository {
  return {
    isReadOnly: () => false,
    inScope: () => agents,
    visibleTo: () => agents,
    upsert: () => {},
    deleteById: () => {},
    clearScope: () => {},
    setPositions: () => {},
  }
}

describe('resolveCallerConfigBlocks', () => {
  test('resuelve un id string contra el catálogo', () => {
    const catalog: SystemPromptDef[] = [{ id: 'sp1', name: 'x', text: 'texto del catálogo' }]
    const { blocks, missing } = resolveCallerConfigBlocks(['sp1'], catalog, new Set())
    expect(blocks).toEqual([{ type: 'text', text: 'texto del catálogo' }])
    expect(missing).toEqual([])
  })

  test('usa el texto inline de un {text} tal cual', () => {
    const { blocks } = resolveCallerConfigBlocks([{ text: 'inline' }], [], new Set())
    expect(blocks).toEqual([{ type: 'text', text: 'inline' }])
  })

  test('no duplica un id ya incluido por systemPromptIds', () => {
    const catalog: SystemPromptDef[] = [{ id: 'sp1', name: 'x', text: 'y' }]
    const { blocks } = resolveCallerConfigBlocks(['sp1'], catalog, new Set(['sp1']))
    expect(blocks).toEqual([])
  })

  test('un id que no está en el catálogo vuelve como missing, no como block', () => {
    const { blocks, missing } = resolveCallerConfigBlocks(['no-existe'], [], new Set())
    expect(blocks).toEqual([])
    expect(missing).toEqual(['no-existe'])
  })
})

describe('AssistWithAiUseCase.buildContext — merge de assist_caller_configs', () => {
  test('un agentId ad-hoc con config aplica su system prompt', () => {
    const useCase = new AssistWithAiUseCase(
      fakeSystemPromptRepo([]),
      fakeProjectRepo(),
      fakeCallerConfigRepo([{ agentId: 'task-chat', systemPrompts: [{ text: 'rol estático' }] }]),
      fakeAgentRepo([]),
    ) as AnyUseCase

    const ctx = useCase.buildContext(
      { mode: 'generate', description: 'x', agentId: 'task-chat' },
      'req1',
    )
    expect(ctx.extraBlocks).toEqual([{ type: 'text', text: 'rol estático' }])
  })

  test('un agentId que SÍ es un AgentDefinition real no dobla la resolución', () => {
    const useCase = new AssistWithAiUseCase(
      fakeSystemPromptRepo([]),
      fakeProjectRepo(),
      fakeCallerConfigRepo([
        { agentId: 'refiner', systemPrompts: [{ text: 'no debería aplicar' }] },
      ]),
      fakeAgentRepo([{ id: 'refiner', provider: 'anthropic-api', prompt: 'p' } as AgentDefinition]),
    ) as AnyUseCase

    const ctx = useCase.buildContext(
      { mode: 'generate', description: 'x', agentId: 'refiner' },
      'req1',
    )
    expect(ctx.extraBlocks).toEqual([])
  })

  test('sin config para ese agentId, extraBlocks queda como antes (vacío)', () => {
    const useCase = new AssistWithAiUseCase(
      fakeSystemPromptRepo([]),
      fakeProjectRepo(),
      fakeCallerConfigRepo([]),
      fakeAgentRepo([]),
    ) as AnyUseCase

    const ctx = useCase.buildContext(
      { mode: 'generate', description: 'x', agentId: 'task-chat' },
      'req1',
    )
    expect(ctx.extraBlocks).toEqual([])
  })

  test('sin agentId, no se resuelve ninguna config (aunque exista una fila con ese id)', () => {
    const useCase = new AssistWithAiUseCase(
      fakeSystemPromptRepo([]),
      fakeProjectRepo(),
      fakeCallerConfigRepo([{ agentId: 'task-chat', systemPrompts: [{ text: 'rol' }] }]),
      fakeAgentRepo([]),
    ) as AnyUseCase

    const ctx = useCase.buildContext({ mode: 'generate', description: 'x' }, 'req1')
    expect(ctx.extraBlocks).toEqual([])
  })

  test('los bloques de la caller config van ANTES de los explícitos (systemPromptIds)', () => {
    const catalog: SystemPromptDef[] = [{ id: 'sp-extra', name: 'x', text: 'extra explícito' }]
    const useCase = new AssistWithAiUseCase(
      fakeSystemPromptRepo(catalog),
      fakeProjectRepo(),
      fakeCallerConfigRepo([{ agentId: 'task-chat', systemPrompts: [{ text: 'rol estático' }] }]),
      fakeAgentRepo([]),
    ) as AnyUseCase

    const ctx = useCase.buildContext(
      { mode: 'generate', description: 'x', agentId: 'task-chat', systemPromptIds: ['sp-extra'] },
      'req1',
    )
    expect(ctx.extraBlocks).toEqual([
      { type: 'text', text: 'rol estático' },
      { type: 'text', text: 'extra explícito' },
    ])
  })

  test('sin los repos opcionales inyectados (compat), se comporta igual que antes', () => {
    const useCase = new AssistWithAiUseCase(
      fakeSystemPromptRepo([]),
      fakeProjectRepo(),
    ) as AnyUseCase
    const ctx = useCase.buildContext(
      { mode: 'generate', description: 'x', agentId: 'task-chat' },
      'req1',
    )
    expect(ctx.extraBlocks).toEqual([])
  })
})

describe('AssistWithAiUseCase.buildContext — fallbackSystemPrompts (sin fila todavía)', () => {
  test('sin fila en assist_caller_configs, usa el fallback que trajo el caller', () => {
    const useCase = new AssistWithAiUseCase(
      fakeSystemPromptRepo([]),
      fakeProjectRepo(),
      fakeCallerConfigRepo([]),
      fakeAgentRepo([]),
    ) as AnyUseCase

    const ctx = useCase.buildContext(
      {
        mode: 'generate',
        description: 'x',
        agentId: 'task-chat',
        fallbackSystemPrompts: [{ text: 'fallback del caller' }],
      },
      'req1',
    )
    expect(ctx.extraBlocks).toEqual([{ type: 'text', text: 'fallback del caller' }])
  })

  test('una fila REAL gana sobre el fallback, aunque exista', () => {
    const useCase = new AssistWithAiUseCase(
      fakeSystemPromptRepo([]),
      fakeProjectRepo(),
      fakeCallerConfigRepo([{ agentId: 'task-chat', systemPrompts: [{ text: 'de la config' }] }]),
      fakeAgentRepo([]),
    ) as AnyUseCase

    const ctx = useCase.buildContext(
      {
        mode: 'generate',
        description: 'x',
        agentId: 'task-chat',
        fallbackSystemPrompts: [{ text: 'no debería aplicar' }],
      },
      'req1',
    )
    expect(ctx.extraBlocks).toEqual([{ type: 'text', text: 'de la config' }])
  })

  test('una fila real con systemPrompts vacío a propósito NO cae al fallback', () => {
    const useCase = new AssistWithAiUseCase(
      fakeSystemPromptRepo([]),
      fakeProjectRepo(),
      fakeCallerConfigRepo([{ agentId: 'task-chat', systemPrompts: [] }]),
      fakeAgentRepo([]),
    ) as AnyUseCase

    const ctx = useCase.buildContext(
      {
        mode: 'generate',
        description: 'x',
        agentId: 'task-chat',
        fallbackSystemPrompts: [{ text: 'no debería aplicar' }],
      },
      'req1',
    )
    expect(ctx.extraBlocks).toEqual([])
  })

  test('sin fallback ni fila, extraBlocks queda vacío (no explota)', () => {
    const useCase = new AssistWithAiUseCase(
      fakeSystemPromptRepo([]),
      fakeProjectRepo(),
      fakeCallerConfigRepo([]),
      fakeAgentRepo([]),
    ) as AnyUseCase

    const ctx = useCase.buildContext(
      { mode: 'generate', description: 'x', agentId: 'task-chat' },
      'req1',
    )
    expect(ctx.extraBlocks).toEqual([])
  })

  test('una fila con refs que NO resuelven (id borrado del catálogo) cae al fallback, no queda vacía', () => {
    const useCase = new AssistWithAiUseCase(
      fakeSystemPromptRepo([]), // el catálogo no tiene 'sp-borrado'
      fakeProjectRepo(),
      fakeCallerConfigRepo([{ agentId: 'task-chat', systemPrompts: ['sp-borrado'] }]),
      fakeAgentRepo([]),
    ) as AnyUseCase

    const ctx = useCase.buildContext(
      {
        mode: 'generate',
        description: 'x',
        agentId: 'task-chat',
        fallbackSystemPrompts: [{ text: 'fallback de rescate' }],
      },
      'req1',
    )
    expect(ctx.extraBlocks).toEqual([{ type: 'text', text: 'fallback de rescate' }])
  })

  test('una fila con refs rotas y SIN fallback no explota — sólo queda vacía', () => {
    const useCase = new AssistWithAiUseCase(
      fakeSystemPromptRepo([]),
      fakeProjectRepo(),
      fakeCallerConfigRepo([{ agentId: 'task-chat', systemPrompts: ['sp-borrado'] }]),
      fakeAgentRepo([]),
    ) as AnyUseCase

    const ctx = useCase.buildContext(
      { mode: 'generate', description: 'x', agentId: 'task-chat' },
      'req1',
    )
    expect(ctx.extraBlocks).toEqual([])
  })
})
