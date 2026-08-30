import { describe, expect, test } from 'bun:test'
import type { AgentDefinition, Rule, Wait } from '@ia-flow/shared'
import type { IRuleRepository } from '../../../domain/ports/IRuleRepository.js'
import type { IWaitRepository } from '../../../domain/ports/IWaitRepository.js'
import { GetPipelineUseCase, type PipelineRunSnapshot } from '../GetPipelineUseCase.js'

const rule = (over: Partial<Rule> = {}): Rule =>
  ({
    id: 'r1',
    on: ['issue.status_changed'],
    do: [{ action: 'agent', agentId: 'refiner' }],
    projectId: null,
    enabled: true,
    ...over,
  }) as Rule

const agent = (id: string, projectId: string | null = 'p1'): AgentDefinition =>
  ({ id, projectId, prompt: '', provider: 'anthropic-api' }) as AgentDefinition

const wait = (over: Partial<Wait> = {}): Wait =>
  ({
    id: 'w1',
    projectId: 'p1',
    taskId: 't1',
    agentId: 'reviewer',
    on: ['task.message'],
    expiresAt: '2030-01-01T00:00:00.000Z',
    checkpoint: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }) as Wait

function harness(opts: {
  rules?: Rule[]
  waits?: Wait[]
  running?: PipelineRunSnapshot[]
  agents?: AgentDefinition[]
  statuses?: string[]
  repos?: string[]
  statusesThrow?: boolean
}) {
  const rules: IRuleRepository = {
    isReadOnly: () => false,
    visibleTo: async () => opts.rules ?? [],
    list: async () => opts.rules ?? [],
    getById: async () => null,
    upsert: async (r: Rule) => r,
    deleteById: async () => true,
    setPositions: async () => {},
  } as unknown as IRuleRepository

  const waits: IWaitRepository = {
    listByProject: async () => opts.waits ?? [],
    listExpired: async () => [],
    getByTask: async () => null,
    create: async (w) => w,
    consume: async () => true,
  }

  return new GetPipelineUseCase(rules, waits, {
    runningAgents: () => opts.running ?? [],
    agentsFor: async () => opts.agents ?? [],
    reposFor: async () => opts.repos ?? [],
    statusesFor: async () => {
      if (opts.statusesThrow) throw new Error('fuente caída')
      return opts.statuses ?? []
    },
  })
}

describe('GetPipelineUseCase', () => {
  test('devuelve reglas, runs y esperas en un solo snapshot', async () => {
    const uc = harness({
      rules: [rule()],
      running: [{ taskId: 't1', status: 'Construir', ruleId: 'r1', agentId: 'refiner' }],
      waits: [wait()],
    })

    const p = await uc.execute('p1')

    expect(p.rules).toHaveLength(1)
    expect(p.running[0]).toMatchObject({ taskId: 't1', ruleId: 'r1' })
    expect(p.waits[0]).toMatchObject({ id: 'w1', taskId: 't1' })
  })

  // El run se dibuja sobre la regla que lo lanzó; un sub-agente cuelga de su
  // padre y no cuenta como un run más del proyecto.
  test('marca los sub-agentes por su parentRunId', async () => {
    const uc = harness({
      running: [
        { taskId: 't1', status: 'x', parentRunId: 'run-padre' },
        { taskId: 't2', status: 'x' },
      ],
    })

    const p = await uc.execute('p1')
    expect(p.running.map((r) => r.isSubAgent)).toEqual([true, false])
  })

  // Una pausa es una espera CON checkpoint — misma tabla, misma fila.
  test('distingue una pausa de una espera común', async () => {
    const uc = harness({
      waits: [wait({ id: 'w1' }), wait({ id: 'w2', checkpoint: { messages: [] } })],
    })

    const p = await uc.execute('p1')
    expect(p.waits.map((w) => w.isPause)).toEqual([false, true])
  })

  test('los runs de otro proyecto no entran', async () => {
    const uc = harness({
      running: [
        { taskId: 't1', status: 'x', projectId: 'p1' },
        { taskId: 't2', status: 'x', projectId: 'otro' },
      ],
    })

    expect((await uc.execute('p1')).running.map((r) => r.taskId)).toEqual(['t1'])
  })

  describe('huecos de configuración', () => {
    test('un agente que ninguna regla nombra sale como sin usar', async () => {
      const uc = harness({
        rules: [rule({ do: [{ action: 'agent', agentId: 'refiner' }] as Rule['do'] })],
        agents: [agent('refiner'), agent('releaser')],
      })

      expect((await uc.execute('p1')).gaps.unusedAgents).toEqual(['releaser'])
    })

    // Una regla deshabilitada no corre, así que un agente que sólo ella nombra
    // tampoco. Contarlo como usado escondería justo el caso que el aviso existe
    // para mostrar.
    test('una regla deshabilitada no cuenta como uso', async () => {
      const uc = harness({
        rules: [
          rule({ enabled: false, do: [{ action: 'agent', agentId: 'refiner' }] as Rule['do'] }),
        ],
        agents: [agent('refiner')],
      })

      expect((await uc.execute('p1')).gaps.unusedAgents).toEqual(['refiner'])
    })

    // Un agente global puede estar usado por una regla de OTRO proyecto;
    // marcarlo sin usar desde acá sería falso.
    test('los agentes globales no se marcan sin usar desde un proyecto', async () => {
      const uc = harness({ rules: [], agents: [agent('global-1', null), agent('propio')] })

      expect((await uc.execute('p1')).gaps.unusedAgents).toEqual(['propio'])
    })

    test('un status sobre el que no dispara ninguna regla sale como hueco', async () => {
      const uc = harness({
        rules: [rule({ when: [{ field: 'status', op: '=', value: 'Construir' }] as Rule['when'] })],
        statuses: ['Construir', 'Bloqueado'],
      })

      expect((await uc.execute('p1')).gaps.statusesWithoutRules).toEqual(['Bloqueado'])
    })

    // Una regla sin condición de status dispara sobre TODOS, así que no hay
    // status huérfano: reportarlos sería un aviso falso.
    test('una regla sin condición de status cubre todo', async () => {
      const uc = harness({ rules: [rule({ when: undefined })], statuses: ['A', 'B'] })

      expect((await uc.execute('p1')).gaps.statusesWithoutRules).toEqual([])
    })

    // No poder LEER los statuses no es lo mismo que no tener ninguno: reportar
    // todos como huecos por un fallo de red apuntaría al lugar equivocado.
    test('si la fuente falla no se inventan huecos de status', async () => {
      const uc = harness({
        rules: [rule({ when: [{ field: 'status', op: '=', value: 'X' }] as Rule['when'] })],
        statusesThrow: true,
      })

      const p = await uc.execute('p1')
      expect(p.gaps.statusesWithoutRules).toEqual([])
      // Y el resto del pipeline sigue viniendo: un fallo de la fuente no puede
      // dejar la pantalla vacía.
      expect(p.rules).toHaveLength(1)
    })
  })

  // Sin proyecto es el ámbito GLOBAL, no "todos": mezclar reglas que nunca se
  // ven entre sí haría ilegible la pantalla.
  test('sin projectId no trae esperas — siempre cuelgan de una task', async () => {
    const uc = harness({ rules: [rule()], waits: [wait()] })

    expect((await uc.execute()).waits).toEqual([])
  })
})
