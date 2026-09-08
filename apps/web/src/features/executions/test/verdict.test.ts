import type { ExecutionStats } from '@ia-flow/shared'
import { describe, expect, it } from 'vitest'
import type { AgentHealth } from '../verdict'
import {
  dispositionCounts,
  healthLine,
  isOutOfBand,
  summarizeHealth,
  verbForRun,
  verdictFor,
} from '../verdict'

function agent(over: Partial<AgentHealth> = {}): AgentHealth {
  return {
    agentId: 'implementer',
    runs: 20,
    success: 20,
    error: 0,
    cancelled: 0,
    truncated: 0,
    successRate: 1,
    failureClasses: {},
    avgDurationMs: 1000,
    p95DurationMs: 1000,
    tokensIn: 100,
    tokensOut: 100,
    cacheReadTokens: 900,
    cacheCreationTokens: 0,
    cacheHitRate: 0.9,
    iters: 20,
    costUsd: 1,
    toolCalls: 10,
    toolErrors: 0,
    stopReasons: {},
    promptVersions: 1,
    systemPromptVersions: 1,
    models: { 'claude-opus-5': 20 },
    ...over,
  } as AgentHealth
}

describe('isOutOfBand', () => {
  it('un agente con pocos runs NO está fuera de banda — su tasa es ruido', () => {
    // Es la falla que mata a un panel de alertas: si grita por dos runs de
    // tres, se aprende a ignorarlo, y con él se ignora el problema real.
    expect(isOutOfBand(agent({ runs: 3, success: 1, error: 2, successRate: 0.33 }))).toBe(false)
  })

  it('marca al que baja de la banda de éxito con muestra suficiente', () => {
    expect(isOutOfBand(agent({ runs: 23, success: 11, error: 12, successRate: 0.48 }))).toBe(true)
  })

  it('marca también al que no cachea — cuesta de más aunque termine bien', () => {
    expect(isOutOfBand(agent({ cacheHitRate: 0.2 }))).toBe(true)
  })

  it('deja pasar al sano', () => {
    expect(isOutOfBand(agent())).toBe(false)
  })
})

describe('verdictFor', () => {
  it('la razón es literal: la tasa, cuántos fallaron y por qué clase', () => {
    const v = verdictFor(
      agent({
        agentId: 'reviewer',
        runs: 23,
        success: 11,
        error: 12,
        successRate: 0.48,
        failureClasses: { tool_failure: 12 },
      }),
    )
    expect(v.reason).toBe('48% ok · 12 de 23 por tools fallando')
  })

  it('sin clase de fallo no inventa un porqué', () => {
    const v = verdictFor(agent({ runs: 10, success: 5, error: 5, successRate: 0.5 }))
    expect(v.reason).toBe('50% ok · 5 de 10')
  })
})

describe('summarizeHealth', () => {
  it('parte en fuera de banda, sanos y sin muestra, y pone el peor primero', () => {
    const out = summarizeHealth([
      agent({ agentId: 'ok-1' }),
      agent({ agentId: 'malo', runs: 20, success: 4, error: 16, successRate: 0.2 }),
      agent({ agentId: 'regular', runs: 20, success: 14, error: 6, successRate: 0.7 }),
      agent({ agentId: 'nuevo', runs: 2, success: 1, error: 1, successRate: 0.5 }),
    ])
    expect(out.outOfBand.map((v) => v.agentId)).toEqual(['malo', 'regular'])
    expect(out.healthy.map((a) => a.agentId)).toEqual(['ok-1'])
    expect(out.lowSample.map((a) => a.agentId)).toEqual(['nuevo'])
  })
})

describe('dispositionCounts', () => {
  it('agrupa los seis outcomes en tres disposiciones', () => {
    const out = dispositionCounts({
      success: 37,
      error: 2,
      cancelled: 1,
      truncated: 0,
      pending: 2,
    })
    expect(out.map((c) => [c.label, c.count])).toEqual([
      ['te esperan', 3],
      ['corriendo', 2],
      ['cerradas', 37],
    ])
  })

  it('un contador en cero no se dibuja (R10)', () => {
    const out = dispositionCounts({ success: 5, error: 0, cancelled: 0, truncated: 0, pending: 0 })
    expect(out.map((c) => c.key)).toEqual(['closed'])
  })
})

describe('verbForRun', () => {
  const run = (over: Record<string, unknown> = {}) =>
    ({ id: 'e1', outcome: 'success', finishedAt: '2026-09-01T10:00:00Z', ...over }) as never

  it('un run en vuelo se puede abortar', () => {
    expect(verbForRun(run({ finishedAt: null, outcome: null }))).toEqual({
      label: 'Abortar',
      kind: 'cancel',
    })
  })

  it('un abortado a mano manda a su pantalla, con el run en la URL', () => {
    expect(verbForRun(run({ outcome: 'cancelled', id: 'e9' }))).toEqual({
      label: 'Resolver',
      kind: 'route',
      href: '/general/aborted-runs?run=e9',
      hint: '· runs abortados',
    })
  })

  it('un run que terminó bien NO lleva verbo — si no te toca, un botón es ruido', () => {
    expect(verbForRun(run())).toBeNull()
  })

  it('un fallo tampoco: reintentar es una acción sobre la TAREA, no sobre el run', () => {
    // Prometerlo acá abriría otra pantalla: un botón que miente sobre lo que
    // hace. El verbo vive en la fila de Tareas, que es donde pertenece.
    expect(verbForRun(run({ outcome: 'error' }))).toBeNull()
  })
})

// ───────────────────────────────────────────────────────────────────────────
// La banda de salud es UNA línea, siempre (turno 8). Con 51% ok los siete
// agentes están fuera de banda: una fila por agente eran 470px de rojo que
// empujaban la lista fuera de la pantalla, y siete tasas truncadas no dicen
// qué hacer.
// ───────────────────────────────────────────────────────────────────────────
function stats(
  over: Partial<ExecutionStats['totals']> = {},
  agents: AgentHealth[] = [],
): ExecutionStats {
  return {
    from: null,
    to: null,
    totals: {
      runs: 100,
      success: 50,
      error: 40,
      cancelled: 5,
      truncated: 5,
      successRate: 0.5,
      failureClasses: {},
      stopReasons: {},
      tokensIn: 0,
      tokensOut: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      cacheHitRate: null,
      iters: 0,
      costUsd: null,
      ...over,
    },
    agents,
  }
}

/** Un agente que califica como fuera de banda: 40% ok sobre muestra suficiente. */
function broken(id: string): AgentHealth {
  return agent({ agentId: id, runs: 10, success: 4, error: 6, successRate: 0.4 })
}

describe('healthLine', () => {
  it('sin nadie fuera de banda no alarma', () => {
    const line = healthLine(stats({ successRate: 0.97 }, [agent()]))
    expect(line?.tone).toBe('ok')
    expect(line?.headline).toContain('1 agente en banda')
  })

  it('con uno solo, la línea ES ese agente y lleva a su página', () => {
    const line = healthLine(stats({}, [agent(), broken('reviewer')]))
    expect(line?.agentId).toBe('reviewer')
    expect(line?.headline).toContain('reviewer')
    expect(line?.tone).toBe('danger')
  })

  it('con tres o más, cuenta los agentes en vez de listarlos', () => {
    const line = healthLine(
      stats({ failureClasses: { tool_failure: 34, unknown: 10 } }, [
        broken('a'),
        broken('b'),
        broken('c'),
        agent(),
      ]),
    )
    expect(line?.headline).toBe('50% ok · 3 de 4 agentes fuera de banda')
    // Y la segunda línea es la causa COMPARTIDA, que es lo accionable.
    expect(line?.detail).toBe('tools fallando en 34 de 50 fallos')
    expect(line?.agentId).toBeNull()
  })

  it('sin diagnóstico la causa es de datos, y va en ámbar', () => {
    // Rojo es "algo te espera". Que el server no clasifique los fallos no lo
    // es: decirlo en rojo enseña a ignorar el rojo.
    const line = healthLine(
      stats({ failureClasses: { unknown: 46, tool_failure: 4 } }, [
        broken('a'),
        broken('b'),
        broken('c'),
      ]),
    )
    expect(line?.detail).toBe('46 de 50 fallos sin failureClass · no hay diagnóstico')
    expect(line?.tone).toBe('warn')
  })

  it('sin stats no hay línea', () => {
    expect(healthLine(null)).toBeNull()
  })
})
