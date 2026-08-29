import { describe, expect, it, mock } from 'bun:test'
import type { Liveness, SessionHandle } from '@ia-flow/ai-providers'
import { watchSession } from '../session-watchdog.js'

function makeHandle(liveness: () => Promise<Liveness> | Liveness): SessionHandle {
  return {
    kind: 'iterm',
    id: 'session-1',
    liveness: async () => liveness(),
    close: async () => {},
  } as unknown as SessionHandle
}

describe('watchSession — confirmChecks', () => {
  it('does NOT fire on a single dead reading (transient blip)', async () => {
    let state: Liveness = 'dead'
    const handle = makeHandle(() => state)
    const onGone = mock(() => {})

    const unwatch = watchSession(handle, onGone, { graceMs: 1, intervalMs: 50, confirmChecks: 2 })
    await new Promise((r) => setTimeout(r, 15)) // one tick (~1ms): reads dead, doesn't fire yet

    expect(onGone).not.toHaveBeenCalled()

    state = 'alive'
    unwatch()
    expect(onGone).not.toHaveBeenCalled()
  })

  it('fires after N consecutive dead readings, with the reason', async () => {
    const handle = makeHandle(() => 'dead')
    const onGone = mock((_reason: string) => {})

    watchSession(handle, onGone, { graceMs: 1, intervalMs: 5, confirmChecks: 2 })
    await new Promise((r) => setTimeout(r, 30))

    expect(onGone).toHaveBeenCalledTimes(1)
    expect(onGone.mock.calls[0]?.[0]).toBe('confirmed-dead')
  })

  it('fires on the first dead reading when confirmChecks=1 (legacy behavior)', async () => {
    const handle = makeHandle(() => 'dead')
    const onGone = mock(() => {})

    watchSession(handle, onGone, { graceMs: 1, intervalMs: 5, confirmChecks: 1 })
    await new Promise((r) => setTimeout(r, 12))

    expect(onGone).toHaveBeenCalledTimes(1)
  })

  it('a recovering reading between two dead ones resets the streak', async () => {
    const readings: Liveness[] = ['dead', 'alive', 'dead', 'dead']
    const handle = makeHandle(() => readings.shift() ?? 'dead')
    const onGone = mock(() => {})

    watchSession(handle, onGone, { graceMs: 1, intervalMs: 5, confirmChecks: 2 })
    await new Promise((r) => setTimeout(r, 40))

    // Sequence: dead(1) -> alive(reset) -> dead(1) -> dead(2, fires)
    expect(onGone).toHaveBeenCalledTimes(1)
  })
})

// El incidente que motivó el tri-estado: el agent-host que hospedaba la sesión
// reinició, contestó "no la conozco", y eso se leía como muerta — el watchdog
// abandonaba un run que seguía trabajando.
describe('watchSession — unknown no es evidencia de muerte', () => {
  it('no suelta la sesión por lecturas unknown dentro del presupuesto', async () => {
    const handle = makeHandle(() => 'unknown')
    const onGone = mock(() => {})

    watchSession(handle, onGone, {
      graceMs: 1,
      intervalMs: 5,
      confirmChecks: 2,
      unknownBudgetMs: 60_000,
    })
    await new Promise((r) => setTimeout(r, 40)) // muchas más lecturas que confirmChecks

    expect(onGone).not.toHaveBeenCalled()
  })

  it('unknown no incrementa el contador de muertes', async () => {
    const readings: Liveness[] = ['dead', 'unknown', 'unknown', 'unknown', 'unknown']
    const handle = makeHandle(() => readings.shift() ?? 'unknown')
    const onGone = mock(() => {})

    watchSession(handle, onGone, {
      graceMs: 1,
      intervalMs: 5,
      confirmChecks: 2,
      unknownBudgetMs: 60_000,
    })
    await new Promise((r) => setTimeout(r, 45))

    // Una sola evidencia de muerte y después nada más que silencio: si
    // `unknown` sumara al contador, acá ya se habría soltado el run.
    expect(onGone).not.toHaveBeenCalled()
  })

  it('unknown tampoco BORRA la evidencia: dos dead separadas igual confirman', async () => {
    const readings: Liveness[] = ['dead', 'unknown', 'dead']
    const handle = makeHandle(() => readings.shift() ?? 'unknown')
    const onGone = mock((_reason: string) => {})

    watchSession(handle, onGone, {
      graceMs: 1,
      intervalMs: 5,
      confirmChecks: 2,
      unknownBudgetMs: 60_000,
    })
    await new Promise((r) => setTimeout(r, 45))

    // Deliberado: dos veces algo que SÍ sabe contestó "no existe". No poder
    // preguntar en el medio no borra esas dos respuestas — si lo hiciera, una
    // sonda intermitente dejaría un run muerto vivo para siempre. Sólo un
    // `alive` (evidencia en contra) resetea la racha.
    expect(onGone).toHaveBeenCalledTimes(1)
    expect(onGone.mock.calls[0]?.[0]).toBe('confirmed-dead')
  })

  it('agotado el presupuesto suelta la sesión, pero con motivo propio', async () => {
    const handle = makeHandle(() => 'unknown')
    const onGone = mock((_reason: string) => {})

    watchSession(handle, onGone, {
      graceMs: 1,
      intervalMs: 5,
      confirmChecks: 2,
      unknownBudgetMs: 10,
    })
    await new Promise((r) => setTimeout(r, 60))

    expect(onGone).toHaveBeenCalledTimes(1)
    // El motivo importa: `liveness-unknown` NO cancela el run del lado del
    // Agent, sólo suspende la vigilancia. `confirmed-dead` sí lo cancela.
    expect(onGone.mock.calls[0]?.[0]).toBe('liveness-unknown')
  })

  it('un alive intermedio resetea el presupuesto de unknown', async () => {
    const readings: Liveness[] = ['unknown', 'unknown', 'alive', 'unknown']
    const handle = makeHandle(() => readings.shift() ?? 'alive')
    const onGone = mock(() => {})

    watchSession(handle, onGone, {
      graceMs: 1,
      intervalMs: 5,
      confirmChecks: 2,
      unknownBudgetMs: 18,
    })
    await new Promise((r) => setTimeout(r, 45))

    expect(onGone).not.toHaveBeenCalled()
  })

  it('una sonda que lanza se trata como unknown, no como muerta', async () => {
    const handle = makeHandle(() => {
      throw new Error('AppleScript colgado')
    })
    const onGone = mock(() => {})

    watchSession(handle, onGone, {
      graceMs: 1,
      intervalMs: 5,
      confirmChecks: 2,
      unknownBudgetMs: 60_000,
    })
    await new Promise((r) => setTimeout(r, 40))

    expect(onGone).not.toHaveBeenCalled()
  })
})

describe('watchSession — robustez del poller', () => {
  it('un onGone que lanza no propaga: el watchdog ya soltó la sesión igual', async () => {
    const handle = makeHandle(() => 'dead')
    let called = 0
    const onGone = () => {
      called += 1
      throw new Error('el handler explotó')
    }

    watchSession(handle, onGone, { graceMs: 1, intervalMs: 5, confirmChecks: 1 })
    await new Promise((r) => setTimeout(r, 20))

    // Y una sola vez: después de disparar, el poller queda dispuesto.
    expect(called).toBe(1)
  })

  it('unwatch antes del primer tick no dispara nada', async () => {
    const handle = makeHandle(() => 'dead')
    const onGone = mock(() => {})

    const unwatch = watchSession(handle, onGone, { graceMs: 20, intervalMs: 5, confirmChecks: 1 })
    unwatch()
    await new Promise((r) => setTimeout(r, 40))

    expect(onGone).not.toHaveBeenCalled()
  })
})
