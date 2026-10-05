import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Agent } from '../../agent/Agent.js'
import { ProviderRegistry } from '../../agent/Provider.js'
import { Condition } from '../../condition/Condition.js'
import { createEvent } from '../../events/DomainEvent.js'
import { EventBus } from '../../events/EventBus.js'
import { Action } from '../actions/Action.js'
import { ParallelGroup } from '../ParallelGroup.js'
import { Pipeline } from '../Pipeline.js'
import type { PipelineExecutionContext } from '../Runnable.js'

type Script = Record<
  string,
  { submit: string; payload?: unknown } | { fail: string } | { none: true }
>

/** Un provider que, por agente, elige la salida del guion (o tira, o no elige ninguna). Anota en
 *  `seen` con qué carril corrió cada uno. */
function scriptedRegistry(script: Script, seen: Record<string, string | undefined> = {}) {
  return new ProviderRegistry().register({
    id: 'fake',
    run: async (ctx) => {
      seen[ctx.agentId] = ctx.ctx.lane
      const step = script[ctx.agentId]
      if (!step) return { outcome: 'success' }
      // Un corte del provider (presupuesto, iteraciones): no eligió salida.
      if ('none' in step) return { outcome: 'truncated' }
      if ('fail' in step) throw new Error(step.fail)
      await ctx.tools.find((tool) => tool.name === step.submit)?.handler(step.payload ?? {})
      return { outcome: 'success' }
    },
  })
}

/** Una acción que anota en `log` cada vez que corre. */
function recorder(id: string, log: string[], input = z.strictObject({})) {
  return new (class extends Action<typeof input> {
    readonly description = id
    readonly input = input
    execute(value: unknown) {
      log.push(`${id}${Object.keys(value as object).length ? ` ${JSON.stringify(value)}` : ''}`)
      return id
    }
  })({ id })
}

function ctx(payload: Record<string, unknown> = {}): PipelineExecutionContext {
  return { event: createEvent('e', payload), steps: {}, bus: new EventBus(), pipelineId: 'p' }
}

/** El gate de Review: reviewer + e2e, cada uno con su reporte y destinos PROPIOS (que en el grupo
 *  no corren), y el grupo con los suyos. */
function reviewGate(script: Script, log: string[], extra: Partial<{ until: unknown }> = {}) {
  const registry = scriptedRegistry(script)
  const report = recorder('report', log, z.strictObject({ summary: z.string() }))
  const reviewer = new Agent(
    {
      id: 'reviewer',
      provider: 'fake',
      prompt: 'p',
      report,
      routes: {
        approved: { to: recorder('reviewer-own-target', log) },
        back_to_build: { to: recorder('reviewer-own-build', log) },
      },
    },
    registry,
  )
  const e2e = new Agent(
    {
      id: 'e2e',
      provider: 'fake',
      prompt: 'p',
      report,
      routes: { passed: {}, back_to_build: {} },
    },
    registry,
  )
  return new ParallelGroup({
    id: 'gate',
    members: [reviewer, e2e],
    until: (extra.until as never) ?? { all: ['approved', 'passed'] },
    routes: {
      passed: { to: recorder('slack-review', log) },
      failed: { to: recorder('to-build', log) },
    },
  })
}

describe('ParallelGroup', () => {
  it('con todos aprobando: corre el reporte de cada miembro y después el destino `passed` del grupo — nunca los destinos propios de un miembro', async () => {
    const log: string[] = []
    const gate = reviewGate(
      {
        reviewer: { submit: 'submit_approved', payload: { report: { summary: 'ok' } } },
        e2e: { submit: 'submit_passed', payload: { report: { summary: 'anda' } } },
      },
      log,
    )
    const steps = await new Pipeline({ id: 'p', on: ['e'], do: [gate] }).execute(ctx())

    expect(log.slice(0, 2).sort()).toEqual(['report {"summary":"anda"}', 'report {"summary":"ok"}'])
    expect(log.slice(2)).toEqual(['slack-review'])
    expect(steps.gate).toEqual({
      passed: true,
      members: {
        reviewer: { exit: 'approved', summary: undefined },
        e2e: { exit: 'passed', summary: undefined },
      },
    })
  })

  it('si uno no aprueba, el grupo va por `failed`', async () => {
    const log: string[] = []
    const gate = reviewGate(
      {
        reviewer: { submit: 'submit_approved', payload: { report: { summary: 'ok' } } },
        e2e: { submit: 'submit_back_to_build', payload: { report: { summary: 'no anda' } } },
      },
      log,
    )
    await new Pipeline({ id: 'p', on: ['e'], do: [gate] }).execute(ctx())
    expect(log.at(-1)).toBe('to-build')
    expect(log).not.toContain('reviewer-own-target')
  })

  it('`any` pasa con que uno elija una de sus salidas', async () => {
    const log: string[] = []
    const gate = reviewGate(
      {
        reviewer: { submit: 'submit_approved', payload: { report: { summary: 'ok' } } },
        e2e: { submit: 'submit_back_to_build', payload: { report: { summary: 'no anda' } } },
      },
      log,
      { until: { any: ['approved'] } },
    )
    await new Pipeline({ id: 'p', on: ['e'], do: [gate] }).execute(ctx())
    expect(log.at(-1)).toBe('slack-review')
  })

  it('un miembro que su `when` saltea no cuenta para el veredicto', async () => {
    const log: string[] = []
    const registry = scriptedRegistry({
      reviewer: { submit: 'submit_approved' },
      e2e: { submit: 'submit_back_to_build' },
    })
    const gate = new ParallelGroup({
      id: 'gate',
      members: [
        new Agent(
          { id: 'reviewer', provider: 'fake', prompt: 'p', routes: { approved: {} } },
          registry,
        ),
        new Agent(
          {
            id: 'e2e',
            provider: 'fake',
            prompt: 'p',
            routes: { passed: {}, back_to_build: {} },
            when: Condition.fromRows([{ field: 'repo', op: 'eq', value: 'frontend' }]),
          },
          registry,
        ),
      ],
      until: { all: ['approved', 'passed'] },
      routes: { passed: { to: recorder('slack-review', log) } },
    })
    await new Pipeline({ id: 'p', on: ['e'], do: [gate] }).execute(ctx({ repo: 'backend' }))
    expect(log).toEqual(['slack-review'])
  })

  it('sin ningún miembro que corra, no hay veredicto: no corre ninguna salida', async () => {
    const log: string[] = []
    const registry = scriptedRegistry({})
    const skipped = Condition.fromRows([{ field: 'never', op: 'eq', value: true }])
    const gate = new ParallelGroup({
      id: 'gate',
      members: [
        new Agent(
          { id: 'a', provider: 'fake', prompt: 'p', routes: { ok: {} }, when: skipped },
          registry,
        ),
        new Agent(
          { id: 'b', provider: 'fake', prompt: 'p', routes: { ok: {} }, when: skipped },
          registry,
        ),
      ],
      until: { all: ['ok'] },
      routes: { passed: { to: recorder('p', log) }, failed: { to: recorder('f', log) } },
    })
    const steps = await new Pipeline({ id: 'p', on: ['e'], do: [gate] }).execute(ctx())
    expect(log).toEqual([])
    expect(steps.gate).toEqual({ members: {} })
  })

  it('un miembro que tira: el `onError` del GRUPO corre una sola vez', async () => {
    const log: string[] = []
    const registry = scriptedRegistry({ a: { fail: 'se cayó' }, b: { fail: 'también' } })
    const gate = new ParallelGroup({
      id: 'gate',
      members: [
        new Agent({ id: 'a', provider: 'fake', prompt: 'p', routes: { ok: {} } }, registry),
        new Agent({ id: 'b', provider: 'fake', prompt: 'p', routes: { ok: {} } }, registry),
      ],
      until: { all: ['ok'] },
      onError: { to: recorder('blocked', log) },
    })
    await new Pipeline({ id: 'p', on: ['e'], do: [gate] }).execute(ctx())
    expect(log).toEqual(['blocked'])
  })

  it('un miembro que termina sin elegir salida es un error, no un "no pasó"', async () => {
    const log: string[] = []
    const registry = scriptedRegistry({ a: { submit: 'submit_ok' }, b: { none: true } })
    const gate = new ParallelGroup({
      id: 'gate',
      members: [
        new Agent({ id: 'a', provider: 'fake', prompt: 'p', routes: { ok: {} } }, registry),
        new Agent({ id: 'b', provider: 'fake', prompt: 'p', routes: { ok: {} } }, registry),
      ],
      until: { all: ['ok'] },
      routes: { failed: { to: recorder('to-build', log) } },
    })
    await expect(new Pipeline({ id: 'p', on: ['e'], do: [gate] }).execute(ctx())).rejects.toThrow(
      'b: terminó sin elegir salida',
    )
    expect(log).toEqual([])
  })

  it('corre a los miembros A LA VEZ, cada uno con su carril', async () => {
    const started: string[] = []
    let release!: () => void
    const both = new Promise<void>((resolve) => {
      release = resolve
    })
    const lanes: Record<string, string | undefined> = {}
    const registry = new ProviderRegistry().register({
      id: 'fake',
      run: async (runCtx) => {
        started.push(runCtx.agentId)
        lanes[runCtx.agentId] = runCtx.ctx.lane
        if (started.length === 2) release()
        // Si corrieran en serie, el primero esperaría acá para siempre.
        await both
        await runCtx.tools.find((tool) => tool.name === 'submit_ok')?.handler({})
        return { outcome: 'success' }
      },
    })
    const gate = new ParallelGroup({
      id: 'gate',
      members: [
        new Agent({ id: 'a', provider: 'fake', prompt: 'p', routes: { ok: {} } }, registry),
        new Agent({ id: 'b', provider: 'fake', prompt: 'p', routes: { ok: {} } }, registry),
      ],
      until: { all: ['ok'] },
    })
    const steps = await new Pipeline({ id: 'p', on: ['e'], do: [gate] }).execute(ctx())
    expect(started.sort()).toEqual(['a', 'b'])
    expect(lanes).toEqual({ a: 'a', b: 'b' })
    expect((steps.gate as { passed: boolean }).passed).toBe(true)
  })
})

describe('ParallelGroup — validación al construir', () => {
  const registry = scriptedRegistry({})
  const agent = (id: string, extra: Record<string, unknown> = {}) =>
    new Agent({ id, provider: 'fake', prompt: 'p', routes: { ok: {} }, ...extra }, registry)

  it('necesita al menos dos miembros', () => {
    expect(
      () => new ParallelGroup({ id: 'g', members: [agent('a')], until: { all: ['ok'] } }),
    ).toThrow('al menos dos')
  })

  it('un miembro no puede pausar', () => {
    const waiting = agent('a', { waits: { on: ['ci'] } })
    expect(
      () =>
        new Pipeline({
          id: 'p',
          on: ['e'],
          do: [
            new ParallelGroup({ id: 'g', members: [waiting, agent('b')], until: { all: ['ok'] } }),
          ],
        }),
    ).toThrow('un miembro no puede')
  })

  it('la pipeline no puede ponerle destino a la salida de un miembro', () => {
    const log: string[] = []
    expect(
      () =>
        new Pipeline({
          id: 'p',
          on: ['e'],
          do: [
            new ParallelGroup({
              id: 'g',
              members: [agent('a'), agent('b')],
              until: { all: ['ok'] },
            }),
          ],
          routes: { a: { routes: { ok: { to: recorder('x', log) } } } },
        }),
    ).toThrow('la transición es del grupo')
  })

  it('`until` sólo puede nombrar salidas que algún miembro declara', () => {
    expect(
      () =>
        new Pipeline({
          id: 'p',
          on: ['e'],
          do: [
            new ParallelGroup({
              id: 'g',
              members: [agent('a'), agent('b')],
              until: { all: ['approved'] },
            }),
          ],
        }),
    ).toThrow('ningún miembro que vota declara')
  })
})

describe('ParallelGroup — miembros consultivos (`advisory`)', () => {
  /** reviewer vota; e2e es consultivo. */
  function advisoryGate(script: Script, log: string[]) {
    const registry = scriptedRegistry(script)
    const report = recorder('report', log, z.strictObject({ summary: z.string() }))
    return new ParallelGroup({
      id: 'gate',
      members: [
        new Agent(
          {
            id: 'reviewer',
            provider: 'fake',
            prompt: 'p',
            report,
            routes: { approved: {}, back_to_build: {} },
          },
          registry,
        ),
        new Agent(
          { id: 'e2e', provider: 'fake', prompt: 'p', report, routes: { passed: {}, failed: {} } },
          registry,
        ),
      ],
      until: { all: ['approved'] },
      advisory: ['e2e'],
      routes: {
        passed: { to: recorder('slack-review', log) },
        failed: { to: recorder('to-build', log) },
      },
    })
  }

  it('un consultivo que no aprueba no traba el gate, pero publica su reporte y queda en `members`', async () => {
    const log: string[] = []
    const gate = advisoryGate(
      {
        reviewer: { submit: 'submit_approved', payload: { report: { summary: 'ok' } } },
        e2e: { submit: 'submit_failed', payload: { report: { summary: 'rojo' } } },
      },
      log,
    )
    const steps = await new Pipeline({ id: 'p', on: ['e'], do: [gate] }).execute(ctx())
    expect(log).toContain('report {"summary":"rojo"}')
    expect(log.at(-1)).toBe('slack-review')
    expect((steps.gate as { members: Record<string, unknown> }).members.e2e).toEqual({
      exit: 'failed',
      summary: undefined,
    })
  })

  it('un consultivo que tira o termina sin salida no hace fallar al grupo', async () => {
    for (const e2e of [{ fail: 'staging caído' }, { none: true as const }]) {
      const log: string[] = []
      const gate = advisoryGate(
        { reviewer: { submit: 'submit_approved', payload: { report: { summary: 'ok' } } }, e2e },
        log,
      )
      await new Pipeline({ id: 'p', on: ['e'], do: [gate] }).execute(ctx())
      expect(log.at(-1)).toBe('slack-review')
    }
  })

  it('el que vota decide: si el reviewer no aprueba, va por `failed` aunque el consultivo pase', async () => {
    const log: string[] = []
    const gate = advisoryGate(
      {
        reviewer: { submit: 'submit_back_to_build', payload: { report: { summary: 'no' } } },
        e2e: { submit: 'submit_passed', payload: { report: { summary: 'anda' } } },
      },
      log,
    )
    await new Pipeline({ id: 'p', on: ['e'], do: [gate] }).execute(ctx())
    expect(log.at(-1)).toBe('to-build')
  })

  it('valida `advisory`: sólo miembros, alguno tiene que votar, y `until` mira a los que votan', () => {
    const registry = scriptedRegistry({})
    const agent = (id: string, exit: string) =>
      new Agent({ id, provider: 'fake', prompt: 'p', routes: { [exit]: {} } }, registry)
    expect(
      () =>
        new ParallelGroup({
          id: 'g',
          members: [agent('a', 'ok'), agent('b', 'ok')],
          until: { all: ['ok'] },
          advisory: ['x'],
        }),
    ).toThrow('que no son miembros')
    expect(
      () =>
        new ParallelGroup({
          id: 'g',
          members: [agent('a', 'ok'), agent('b', 'ok')],
          until: { all: ['ok'] },
          advisory: ['a', 'b'],
        }),
    ).toThrow('nadie decide')
    expect(
      () =>
        new Pipeline({
          id: 'p',
          on: ['e'],
          do: [
            new ParallelGroup({
              id: 'g',
              members: [agent('a', 'ok'), agent('b', 'passed')],
              until: { all: ['passed'] },
              advisory: ['b'],
            }),
          ],
        }),
    ).toThrow('ningún miembro que vota declara')
  })
})
