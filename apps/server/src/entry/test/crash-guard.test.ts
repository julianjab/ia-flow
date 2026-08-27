import { describe, expect, it } from 'bun:test'
import type { PendingTask } from '@ia-flow/agent-engine'
import {
  type CrashGuardDeps,
  cancelInFlight,
  handleFatal,
  installCrashGuard,
  resolveFatalPolicy,
} from '../crash-guard.js'

function entry(over: Partial<PendingTask> = {}): PendingTask {
  return {
    task: { id: 't', title: 'x' } as PendingTask['task'],
    manager: {} as PendingTask['manager'],
    broadcast: () => {},
    initialStatus: 'Doing',
    ...over,
  }
}

function deps(pending: Array<[string, PendingTask]>, over: Partial<CrashGuardDeps> = {}) {
  const removed: Array<[string, unknown]> = []
  const logs: Array<{ level: string; obj: object; msg: string }> = []
  const d: CrashGuardDeps = {
    listPending: () => pending,
    removePending: (taskId, finish) => removed.push([taskId, finish]),
    log: {
      error: (obj, msg) => logs.push({ level: 'error', obj, msg }),
      warn: (obj, msg) => logs.push({ level: 'warn', obj, msg }),
    },
    ...over,
  }
  return { d, removed, logs }
}

describe('cancelInFlight', () => {
  it('cancela los runs sync y deja vivas las sesiones async', async () => {
    let cancelled = false
    const sync = entry({ cancel: async () => void (cancelled = true) })
    const async_ = entry({ killSession: async () => {}, cancel: async () => {} })
    const { d } = deps([
      ['sync-1', sync],
      ['async-1', async_],
    ])

    const out = await cancelInFlight('fatal: x', d)

    expect(cancelled).toBe(true)
    expect(out.cancelled).toEqual(['sync-1'])
    expect(out.detached).toEqual(['async-1'])
  })

  it('saca a mano la entrada que todavía no tiene cancel', async () => {
    const { d, removed } = deps([['t-1', entry()]])

    await cancelInFlight('fatal: x', d)

    expect(removed).toEqual([['t-1', { cancelled: true, reason: 'fatal: x' }]])
  })

  it('un cancel que tira no impide sacar la entrada ni cancelar las demás', async () => {
    let second = false
    const { d, removed } = deps([
      [
        't-1',
        entry({
          cancel: async () => {
            throw new Error('boom')
          },
        }),
      ],
      ['t-2', entry({ cancel: async () => void (second = true) })],
    ])

    await cancelInFlight('fatal: x', d)

    expect(second).toBe(true)
    expect(removed.map(([id]) => id)).toEqual(['t-1'])
  })
})

describe('handleFatal', () => {
  it('loguea el error y cancela, sin salir', async () => {
    let cancelled = false
    const exits: number[] = []
    const { d, logs } = deps([['t-1', entry({ cancel: async () => void (cancelled = true) })]], {
      exit: (code) => void exits.push(code),
    })

    await handleFatal('unhandledRejection', new Error('boom'), d)

    expect(cancelled).toBe(true)
    expect(exits).toEqual([])
    expect(logs.some((l) => l.level === 'error')).toBe(true)
  })

  it('con policy exit sale con código 1 DESPUÉS de cancelar', async () => {
    const order: string[] = []
    const exits: number[] = []
    const { d } = deps([['t-1', entry({ cancel: async () => void order.push('cancel') })]], {
      policy: () => 'exit',
      exit: (code) => {
        order.push('exit')
        exits.push(code)
      },
    })

    await handleFatal('uncaughtException', new Error('boom'), d)

    expect(order).toEqual(['cancel', 'exit'])
    expect(exits).toEqual([1])
  })

  it('durante el shutdown no cancela nada', async () => {
    let cancelled = false
    const { d } = deps([['t-1', entry({ cancel: async () => void (cancelled = true) })]], {
      isShuttingDown: () => true,
    })

    await handleFatal('unhandledRejection', new Error('abort'), d)

    expect(cancelled).toBe(false)
  })

  it('un listPending roto no vuelve a tirar — el guard es lo último que queda en pie', async () => {
    const { d, logs } = deps([], {
      listPending: () => {
        throw new Error('registry roto')
      },
    })

    await handleFatal('uncaughtException', new Error('boom'), d)

    expect(logs.some((l) => l.msg.includes('cancelación de runs falló'))).toBe(true)
  })
})

describe('resolveFatalPolicy', () => {
  it('default survive; exit sólo con el valor explícito', () => {
    expect(resolveFatalPolicy(undefined)).toBe('survive')
    expect(resolveFatalPolicy('')).toBe('survive')
    expect(resolveFatalPolicy('cualquier-cosa')).toBe('survive')
    expect(resolveFatalPolicy(' Exit ')).toBe('exit')
  })
})

describe('installCrashGuard', () => {
  it('atrapa un unhandledRejection real y no deja morir al proceso', async () => {
    let cancelled = false
    const { d } = deps([['t-1', entry({ cancel: async () => void (cancelled = true) })]])
    const uninstall = installCrashGuard(d)
    try {
      process.emit('unhandledRejection', new Error('boom'), Promise.resolve())
      await Bun.sleep(1)
      expect(cancelled).toBe(true)
    } finally {
      uninstall()
    }
  })

  it('desengancha al desinstalar', () => {
    const { d } = deps([])
    const before = process.listenerCount('uncaughtException')
    const uninstall = installCrashGuard(d)
    expect(process.listenerCount('uncaughtException')).toBe(before + 1)
    uninstall()
    expect(process.listenerCount('uncaughtException')).toBe(before)
  })
})
