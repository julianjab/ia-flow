import { describe, expect, it } from 'bun:test'
import type { AgentDefinition, Task } from '@ia-flow/shared'
import { selectAgent, selectAgentCandidates, summarizeRejections } from '../agent-selection.js'

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    title: 'Add login',
    description: 'desc',
    type: 'functional',
    repos: ['backend'],
    status: 'Build',
    created_at: '2026-01-01T00:00:00Z',
    projectId: 'proj-1',
    ...overrides,
  }
}

// statusName: 'Build' by default — every selectAgent() call below except the
// scope-filter tests uses status: 'Build', so this satisfies the new Scope
// filter (an agent needs statusName OR a non-empty when) without changing
// what any of those tests actually verify (project/repo/position/when).
// Tests specifically about the Scope or Status filter override it explicitly.
function agent(id: string, overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return { id, provider: 'anthropic-api', prompt: 'p', statusName: 'Build', ...overrides }
}

describe('selectAgent — filtro de scope (statusName o when no vacío)', () => {
  it('descarta un agente sin statusName y sin when', () => {
    const { agent: picked, rejected } = selectAgent({
      task: task(),
      agents: [agent('sin-scope', { statusName: undefined })],
      status: 'Build',
    })
    expect(picked).toBeNull()
    expect(rejected).toEqual([{ id: 'sin-scope', reason: 'unscoped' }])
  })

  it('descarta un agente con when vacío (array) y sin statusName', () => {
    const { rejected } = selectAgent({
      task: task(),
      agents: [agent('when-vacio', { statusName: undefined, when: [] })],
      status: 'Build',
    })
    expect(rejected).toEqual([{ id: 'when-vacio', reason: 'unscoped' }])
  })

  it('descarta un agente con when vacío (record legacy) y sin statusName', () => {
    const { rejected } = selectAgent({
      task: task(),
      agents: [agent('when-vacio-record', { statusName: undefined, when: {} })],
      status: 'Build',
    })
    expect(rejected).toEqual([{ id: 'when-vacio-record', reason: 'unscoped' }])
  })

  it('acepta un agente sin statusName si tiene when no vacío', () => {
    const { agent: picked } = selectAgent({
      task: task(),
      agents: [
        agent('solo-when', {
          statusName: undefined,
          when: [{ field: 'type', op: '=', value: 'functional' }],
        }),
      ],
      status: 'Build',
    })
    expect(picked?.id).toBe('solo-when')
  })

  it('acepta un agente con statusName aunque no tenga when', () => {
    const { agent: picked } = selectAgent({
      task: task(),
      agents: [agent('solo-status', { statusName: 'Build' })],
      status: 'Build',
    })
    expect(picked?.id).toBe('solo-status')
  })

  it('el filtro de scope corre antes que project/repo/status/when', () => {
    const a = agent('x', {
      statusName: undefined,
      projectId: 'otro',
      repoName: 'inexistente',
    })
    const { rejected } = selectAgent({ task: task(), agents: [a], status: 'Build' })
    expect(rejected).toEqual([{ id: 'x', reason: 'unscoped' }])
  })
})

describe('selectAgent — filtro por proyecto', () => {
  it('elige un agente global (sin projectId) para cualquier proyecto', () => {
    const a = agent('global')
    const { agent: picked } = selectAgent({ task: task(), agents: [a], status: 'Build' })
    expect(picked?.id).toBe('global')
  })

  it('elige el agente del proyecto del issue', () => {
    const a = agent('mine', { projectId: 'proj-1' })
    const { agent: picked } = selectAgent({ task: task(), agents: [a], status: 'Build' })
    expect(picked?.id).toBe('mine')
  })

  it('descarta un agente de otro proyecto', () => {
    const a = agent('other', { projectId: 'proj-2' })
    const { agent: picked, rejected } = selectAgent({
      task: task(),
      agents: [a],
      status: 'Build',
    })
    expect(picked).toBeNull()
    expect(rejected).toEqual([{ id: 'other', reason: 'project' }])
  })
})

describe('selectAgent — filtro por repo', () => {
  it('un agente sin repoName matchea cualquier repo', () => {
    const { agent: picked } = selectAgent({
      task: task({ repos: ['frontend'] }),
      agents: [agent('any-repo')],
      status: 'Build',
    })
    expect(picked?.id).toBe('any-repo')
  })

  it('matchea cuando el repo del agente está entre los del issue', () => {
    const { agent: picked } = selectAgent({
      task: task({ repos: ['backend', 'frontend'] }),
      agents: [agent('be', { repoName: 'backend' })],
      status: 'Build',
    })
    expect(picked?.id).toBe('be')
  })

  it('descarta cuando el issue no toca ese repo', () => {
    const { agent: picked, rejected } = selectAgent({
      task: task({ repos: ['frontend'] }),
      agents: [agent('be', { repoName: 'backend' })],
      status: 'Build',
    })
    expect(picked).toBeNull()
    expect(rejected[0]).toEqual({ id: 'be', reason: 'repo' })
  })

  it('un issue sin refinar (repos: []) sólo lo toman agentes sin repo asignado', () => {
    const { agent: picked } = selectAgent({
      task: task({ repos: [] }),
      agents: [
        agent('be', { repoName: 'backend', position: 0 }),
        agent('refiner', { position: 1 }),
      ],
      status: 'Build',
    })
    expect(picked?.id).toBe('refiner')
  })
})

describe('selectAgent — filtro por status', () => {
  it('un agente sin statusName (pero con when) es candidato en cualquier status', () => {
    const { agent: picked } = selectAgent({
      task: task({ status: 'Refine' }),
      agents: [
        agent('anywhere', {
          statusName: undefined,
          when: [{ field: 'type', op: '=', value: 'functional' }],
        }),
      ],
      status: 'Refine',
    })
    expect(picked?.id).toBe('anywhere')
  })

  it('matchea el status de forma case-insensitive', () => {
    const { agent: picked } = selectAgent({
      task: task(),
      agents: [agent('builder', { statusName: 'build' })],
      status: 'Build',
    })
    expect(picked?.id).toBe('builder')
  })

  it('descarta un agente asignado a otro status', () => {
    const { agent: picked, rejected } = selectAgent({
      task: task(),
      agents: [agent('refiner', { statusName: 'Refine' })],
      status: 'Build',
    })
    expect(picked).toBeNull()
    expect(rejected[0]).toEqual({ id: 'refiner', reason: 'status' })
  })
})

describe('selectAgent — filtro por when contra los campos del issue', () => {
  it('matchea contra un campo del task', () => {
    const { agent: picked } = selectAgent({
      task: task({ type: 'technical' }),
      agents: [agent('tech', { when: [{ field: 'type', op: '=', value: 'technical' }] })],
      status: 'Build',
    })
    expect(picked?.id).toBe('tech')
  })

  it('descarta cuando la condición no se cumple', () => {
    const { agent: picked, rejected } = selectAgent({
      task: task({ type: 'functional' }),
      agents: [agent('tech', { when: [{ field: 'type', op: '=', value: 'technical' }] })],
      status: 'Build',
    })
    expect(picked).toBeNull()
    expect(rejected[0]).toEqual({ id: 'tech', reason: 'when' })
  })

  it('matchea contra labels por pertenencia', () => {
    const { agent: picked } = selectAgent({
      task: task({ labels: ['urgent', 'bug'] }),
      agents: [agent('urgent', { when: [{ field: 'labels', op: '=', value: 'urgent' }] })],
      status: 'Build',
    })
    expect(picked?.id).toBe('urgent')
  })

  it('matchea contra campos custom del source vía task.fields', () => {
    const { agent: picked } = selectAgent({
      task: task({ fields: { ImpProvider: 'API' } }),
      agents: [agent('api', { when: [{ field: 'ImpProvider', op: '=', value: 'API' }] })],
      status: 'Build',
    })
    expect(picked?.id).toBe('api')
  })
})

describe('selectAgent — se ejecuta el primero que cumple todo', () => {
  it('devuelve el de menor position entre varios que matchean', () => {
    const agents = [
      agent('segundo', { statusName: 'Build', position: 5 }),
      agent('primero', { statusName: 'Build', position: 1 }),
      agent('tercero', { statusName: 'Build', position: 9 }),
    ]
    const { agent: picked } = selectAgent({ task: task(), agents, status: 'Build' })
    expect(picked?.id).toBe('primero')
  })

  it('salta al siguiente candidato cuando el más específico no matchea', () => {
    const agents = [
      agent('solo-tecnicos', {
        statusName: 'Build',
        position: 0,
        when: [{ field: 'type', op: '=', value: 'technical' }],
      }),
      agent('fallback', { statusName: 'Build', position: 1 }),
    ]
    const { agent: picked } = selectAgent({
      task: task({ type: 'functional' }),
      agents,
      status: 'Build',
    })
    expect(picked?.id).toBe('fallback')
  })

  it('no muta el array de entrada al ordenar', () => {
    const agents = [agent('b', { position: 2 }), agent('a', { position: 1 })]
    selectAgent({ task: task(), agents, status: 'Build' })
    expect(agents.map((a) => a.id)).toEqual(['b', 'a'])
  })
})

describe('selectAgent — enabled', () => {
  it('nunca elige un agente deshabilitado, aunque cumpla todos los criterios', () => {
    const { agent: picked, rejected } = selectAgent({
      task: task(),
      agents: [agent('off', { statusName: 'Build', enabled: false })],
      status: 'Build',
    })
    expect(picked).toBeNull()
    expect(rejected[0]).toEqual({ id: 'off', reason: 'disabled' })
  })

  it('enabled ausente se trata como habilitado', () => {
    const { agent: picked } = selectAgent({
      task: task(),
      agents: [agent('on', { statusName: 'Build' })],
      status: 'Build',
    })
    expect(picked?.id).toBe('on')
  })
})

describe('selectAgent — orden de evaluación de los filtros', () => {
  it('reporta el primer filtro que falla, no todos', () => {
    // project falla antes que repo/status/when, así que ése es el motivo.
    const a = agent('x', {
      projectId: 'otro',
      repoName: 'inexistente',
      statusName: 'Otro',
      when: [{ field: 'type', op: '=', value: 'nope' }],
    })
    const { rejected } = selectAgent({ task: task(), agents: [a], status: 'Build' })
    expect(rejected).toEqual([{ id: 'x', reason: 'project' }])
  })

  it('elige el primero pero sigue diagnosticando a los de atrás', () => {
    // Mismo scope a propósito: así el orden lo fija `position` y el ganador
    // queda garantizado primero, sin depender del criterio de especificidad.
    //
    // Ya no hay short-circuit: `selectAgentCandidates` evalúa a todos porque el
    // gate de `whenText` necesita poder seguir probando si el primero queda
    // descartado (ver agent-text-gate.ts). Los filtros son predicados puros
    // sobre datos ya en memoria, así que evaluarlos de más no cuesta nada, y el
    // log de descartes gana: ahora explica también por qué no corrió el que
    // venía atrás.
    const agents = [
      agent('ganador', { projectId: 'proj-1', position: 0 }),
      agent('el-de-atras', { projectId: 'proj-1', position: 1, statusName: 'Otro' }),
    ]
    const { agent: picked, rejected } = selectAgent({ task: task(), agents, status: 'Build' })
    expect(picked?.id).toBe('ganador')
    expect(rejected).toEqual([{ id: 'el-de-atras', reason: 'status' }])
  })

  it('selectAgentCandidates devuelve a todos los que matchean, en orden', () => {
    const agents = [
      agent('primero', { projectId: 'proj-1', position: 0 }),
      agent('segundo', { projectId: 'proj-1', position: 1 }),
      agent('descartado', { projectId: 'proj-1', position: 2, statusName: 'Otro' }),
    ]
    const { candidates, rejected } = selectAgentCandidates({
      task: task(),
      agents,
      status: 'Build',
    })
    expect(candidates.map((c) => c.id)).toEqual(['primero', 'segundo'])
    expect(rejected).toEqual([{ id: 'descartado', reason: 'status' }])
  })
})

describe('summarizeRejections', () => {
  it('agrupa los descartes por filtro', () => {
    const summary = summarizeRejections([
      { id: 'a', reason: 'status' },
      { id: 'b', reason: 'status' },
      { id: 'c', reason: 'when' },
    ])
    expect(summary).toBe('status: a, b | when: c')
  })

  it('describe el caso sin candidatos', () => {
    expect(summarizeRejections([])).toBe('sin candidatos')
  })
})

describe('selectAgent — desempate determinista en empates de position', () => {
  it('el agente del proyecto le gana al global cuando empatan', () => {
    // Cada scope numera sus posiciones por separado (setPositions arranca en 0
    // en ambos), así que dos agentes en position 0 es lo normal. Gana el más
    // específico, no el que SQLite devuelva primero.
    const agents = [
      agent('global', { position: 0 }),
      agent('del-proyecto', { projectId: 'proj-1', position: 0 }),
    ]
    expect(selectAgent({ task: task(), agents, status: 'Build' }).agent?.id).toBe('del-proyecto')
    // Y el resultado no depende del orden de entrada.
    const reversed = [agents[1], agents[0]]
    expect(selectAgent({ task: task(), agents: reversed, status: 'Build' }).agent?.id).toBe(
      'del-proyecto',
    )
  })

  it('desempata por id cuando coinciden position y especificidad', () => {
    const agents = [
      agent('zeta', { projectId: 'proj-1', position: 0 }),
      agent('alfa', { projectId: 'proj-1', position: 0 }),
    ]
    expect(selectAgent({ task: task(), agents, status: 'Build' }).agent?.id).toBe('alfa')
  })

  it('la especificidad manda sobre position: reordenar los globales no los promueve', () => {
    // Regresión: setPositions renumera 0..n-1 dentro de un scope, así que
    // reordenar los globales los deja en 0 mientras los agentes del proyecto
    // siguen en 7, 8, 9. Ordenando por position primero, el usuario reordenaría
    // una lista y promovería otra en silencio.
    const agents = [
      agent('global-recien-reordenado', { position: 0 }),
      agent('del-proyecto', { projectId: 'proj-1', position: 7 }),
    ]
    expect(selectAgent({ task: task(), agents, status: 'Build' }).agent?.id).toBe('del-proyecto')
  })

  it('position decide dentro del mismo scope, que es donde el usuario lo controla', () => {
    const agents = [
      agent('segundo', { projectId: 'proj-1', position: 9 }),
      agent('primero', { projectId: 'proj-1', position: 7 }),
    ]
    expect(selectAgent({ task: task(), agents, status: 'Build' }).agent?.id).toBe('primero')
  })

  it('un global sólo corre cuando ningún agente del proyecto matchea', () => {
    const agents = [
      agent('global-fallback', { position: 99 }),
      agent('del-proyecto', {
        projectId: 'proj-1',
        position: 0,
        when: [{ field: 'type', op: '=', value: 'technical' }],
      }),
    ]
    expect(
      selectAgent({ task: task({ type: 'functional' }), agents, status: 'Build' }).agent?.id,
    ).toBe('global-fallback')
  })
})
