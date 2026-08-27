import { afterEach, describe, expect, test } from 'bun:test'
import type {
  Disposable,
  IssueItem,
  PendingTaskInfo,
  PendingTaskRegistryPort,
  ProjectSource,
  SourceItem,
} from '../../contract.js'
import { type Logger, setLoggerFactory } from '../../logger.js'
import { SourceDispatcher } from '../source-dispatcher.js'

// Los logs del paquete van a un no-op hasta que el host cablea su factory.
// Acá la cableamos a un buffer para poder afirmar sobre CUÁNTAS veces se
// loguea la saturación, que es justamente lo que el flanco cambia. Se instala
// una sola vez y a nivel de módulo porque `setLoggerFactory` rebindea los
// loggers ya creados sólo en su primera llamada (ver logger.ts).
const logged: Array<{ level: string; msg: string; fields: object }> = []
setLoggerFactory(
  (): Logger => ({
    info: (fields, msg) => logged.push({ level: 'info', msg: msg ?? '', fields }),
    debug: (fields, msg) => logged.push({ level: 'debug', msg: msg ?? '', fields }),
    warn: (fields, msg) => logged.push({ level: 'warn', msg: msg ?? '', fields }),
    error: (fields, msg) => logged.push({ level: 'error', msg: msg ?? '', fields }),
  }),
)

const countLogged = (msg: string): number => logged.filter((l) => l.msg === msg).length

// SourceDispatcher no longer decides HOW items arrive — that's each source's
// own watch(). These tests exercise what's still the dispatcher's job: the
// boot scan, the project filter, catch-up flags, the hasWiredAgents gate,
// and the concurrency cap + its local-buffer retry. Debounce/refresh
// semantics per delivery live in each source's own test file (see
// github-issues/test/source.test.ts, github-project/test/source.test.ts).

function makeSource(items: SourceItem[] = []): {
  source: ProjectSource
  getItemsCalls: () => number
  emit: (batch: SourceItem[]) => void
} {
  let getItemsCalls = 0
  let capturedOnItems: ((items: SourceItem[]) => void) | null = null
  const source: ProjectSource = {
    kind: 'test',
    getStatuses: async () => [],
    getItems: async () => {
      getItemsCalls++
      return items
    },
    watch: (onItems) => {
      capturedOnItems = onItems
      return { dispose: () => {} }
    },
  }
  return {
    source,
    getItemsCalls: () => getItemsCalls,
    emit: (batch) => capturedOnItems?.(batch),
  }
}

function makeItem(id: string, overrides: Partial<SourceItem> = {}): SourceItem {
  return { id, title: id, status: 'build', ...overrides }
}

function makePendingRegistry(
  entries: Array<[string, PendingTaskInfo]> = [],
): PendingTaskRegistryPort & { add: (id: string, projectId?: string) => void } {
  const map = new Map(entries)
  return {
    getPendingTask: (id) => map.get(id),
    listPendingTasks: () => [...map.entries()],
    removePendingTask: (id) => map.delete(id),
    // Stands in for Agent.run's registerPendingTask — the moment a dispatch
    // stops being an evaluation and becomes a running agent.
    add: (id, projectId = 'p1') =>
      map.set(id, { task: { projectId }, initialStatus: 'build' } as PendingTaskInfo),
  }
}

const flush = (ms = 20) => new Promise((r) => setTimeout(r, ms))

describe('SourceDispatcher — boot scan', () => {
  test('dispatches every item returned by the boot getItems() scan', async () => {
    const { source } = makeSource([makeItem('a'), makeItem('b')])
    const dispatcher = new SourceDispatcher(
      'p1',
      source,
      () => {},
      makePendingRegistry(),
      'webhook',
    )
    const dispatched: string[] = []
    const disposable = dispatcher.start(async (item: IssueItem) => {
      dispatched.push(item.id)
    })
    await flush()
    expect(dispatched.sort()).toEqual(['a', 'b'])
    disposable.dispose()
  })

  test('items pushed later via watch() also dispatch, through the same gates', async () => {
    const { source, emit } = makeSource([])
    const dispatcher = new SourceDispatcher(
      'p1',
      source,
      () => {},
      makePendingRegistry(),
      'webhook',
    )
    const dispatched: string[] = []
    const disposable = dispatcher.start(async (item: IssueItem) => {
      dispatched.push(item.id)
    })
    await flush()
    emit([makeItem('c')])
    await flush()
    expect(dispatched).toEqual(['c'])
    disposable.dispose()
  })
})

describe('SourceDispatcher — project filter', () => {
  test('items failing the filter never reach dispatch', async () => {
    const { source } = makeSource([
      makeItem('a', { status: 'build' }),
      makeItem('b', { status: 'other' }),
    ])
    const dispatcher = new SourceDispatcher(
      'p1',
      source,
      () => {},
      makePendingRegistry(),
      'webhook',
      undefined,
      { statusName: 'build' },
    )
    const dispatched: string[] = []
    const disposable = dispatcher.start(async (item: IssueItem) => {
      dispatched.push(item.id)
    })
    await flush()
    expect(dispatched).toEqual(['a'])
    disposable.dispose()
  })
})

describe('SourceDispatcher — catch-up flags', () => {
  test('crashRecovery:false skips onDaemonStart but still runs the initial scan', async () => {
    let onDaemonStartCalls = 0
    const { source } = makeSource([makeItem('a')])
    source.onDaemonStart = async () => {
      onDaemonStartCalls++
    }
    const dispatcher = new SourceDispatcher(
      'p1',
      source,
      () => {},
      makePendingRegistry(),
      'webhook',
      undefined,
      undefined,
      { crashRecovery: false, initialScan: true },
    )
    const dispatched: string[] = []
    const disposable = dispatcher.start(async (item: IssueItem) => {
      dispatched.push(item.id)
    })
    await flush()
    expect(onDaemonStartCalls).toBe(0)
    expect(dispatched).toEqual(['a'])
    disposable.dispose()
  })

  test('crashRecovery:true + initialScan:false runs recovery but no boot scan', async () => {
    let onDaemonStartCalls = 0
    const { source, getItemsCalls } = makeSource([makeItem('a')])
    source.onDaemonStart = async () => {
      onDaemonStartCalls++
    }
    const dispatcher = new SourceDispatcher(
      'p1',
      source,
      () => {},
      makePendingRegistry(),
      'webhook',
      undefined,
      undefined,
      { crashRecovery: true, initialScan: false },
    )
    const disposable = dispatcher.start(async () => {})
    await flush()
    expect(onDaemonStartCalls).toBe(1)
    expect(getItemsCalls()).toBe(0)
    disposable.dispose()
  })
})

describe('SourceDispatcher — hasWiredAgents gate', () => {
  test('skips the boot scan entirely when no agent is wired and nothing pending', async () => {
    const { source, getItemsCalls } = makeSource([makeItem('a')])
    const dispatcher = new SourceDispatcher(
      'p1',
      source,
      () => {},
      makePendingRegistry(),
      'webhook',
      () => false,
    )
    const disposable = dispatcher.start(async () => {})
    await flush()
    expect(getItemsCalls()).toBe(0)
    disposable.dispose()
  })

  test('still scans when nothing is wired but a task for this project is pending', async () => {
    const { source, getItemsCalls } = makeSource([makeItem('a')])
    const pendingTasks = makePendingRegistry([
      ['x', { task: { projectId: 'p1' }, initialStatus: 'build' }],
    ])
    const dispatcher = new SourceDispatcher(
      'p1',
      source,
      () => {},
      pendingTasks,
      'webhook',
      () => false,
    )
    const disposable = dispatcher.start(async () => {})
    await flush()
    expect(getItemsCalls()).toBe(1)
    disposable.dispose()
  })

  test('defaults to always-scan without a hasWiredAgents override', async () => {
    const { source, getItemsCalls } = makeSource([])
    const dispatcher = new SourceDispatcher(
      'p1',
      source,
      () => {},
      makePendingRegistry(),
      'webhook',
    )
    const disposable = dispatcher.start(async () => {})
    await flush()
    expect(getItemsCalls()).toBe(1)
    disposable.dispose()
  })
})

describe('SourceDispatcher — capacity', () => {
  const originalRunCap = process.env.IA_FLOW_MAX_CONCURRENT_DISPATCHES
  const originalEvalCap = process.env.IA_FLOW_MAX_CONCURRENT_EVALUATIONS

  afterEach(() => {
    for (const [key, original] of [
      ['IA_FLOW_MAX_CONCURRENT_DISPATCHES', originalRunCap],
      ['IA_FLOW_MAX_CONCURRENT_EVALUATIONS', originalEvalCap],
    ] as const) {
      if (original === undefined) delete process.env[key]
      else process.env[key] = original
    }
  })

  test('the run cap counts running agents, not items under evaluation', async () => {
    process.env.IA_FLOW_MAX_CONCURRENT_DISPATCHES = '1'
    const { source, emit } = makeSource([])
    const pending = makePendingRegistry()
    const dispatcher = new SourceDispatcher('p1', source, () => {}, pending, 'webhook')
    const dispatched: string[] = []
    // 'a' registers a pending task and RETURNS: its evaluation is over, but
    // the agent it started is still running. Counting evaluations would free
    // the slot here; counting runs does not.
    const disposable = dispatcher.start(async (item: IssueItem) => {
      dispatched.push(item.id)
      if (item.id === 'a') pending.add('a')
    })
    await flush()

    emit([makeItem('a')])
    await flush()
    expect(dispatched).toEqual(['a'])

    emit([makeItem('b')])
    await flush()
    expect(dispatched).toEqual(['a']) // 'a' still running, cap is 1

    // The agent finishes — now the slot is genuinely free.
    pending.removePendingTask('a')
    emit([makeItem('b')])
    await flush()
    expect(dispatched.sort()).toEqual(['a', 'b'])

    disposable.dispose()
  }, 3000)

  test('la saturación se loguea en el flanco, no una vez por ciclo', async () => {
    // Con el log por batch, un cap lleno escribía una línea por cada vuelta
    // de scan y por cada replay del backlog — 12.5k líneas repitiendo un
    // estado que no cambió. Interesa el flanco: cuándo empezó a diferir y
    // cuándo se despejó.
    process.env.IA_FLOW_MAX_CONCURRENT_DISPATCHES = '1'
    logged.length = 0
    const { source, emit } = makeSource([])
    const pending = makePendingRegistry()
    const dispatcher = new SourceDispatcher('p1', source, () => {}, pending, 'webhook')
    const disposable = dispatcher.start(async (item: IssueItem) => {
      pending.add(item.id)
    })
    await flush()

    // 'a' ocupa el único slot; 'b' y 'c' se difieren → primer flanco.
    emit([makeItem('a'), makeItem('b'), makeItem('c')])
    await flush()
    expect(countLogged('Capacity reached — deferred some dispatches')).toBe(1)

    // Sigue saturado y llegan más batches: ni una línea más.
    emit([makeItem('d')])
    await flush()
    emit([makeItem('e')])
    await flush()
    expect(countLogged('Capacity reached — deferred some dispatches')).toBe(1)
    expect(countLogged('Capacity freed — deferred backlog drained')).toBe(0)

    disposable.dispose()
  }, 3000)

  test('drenar el backlog loguea el flanco de bajada una sola vez', async () => {
    process.env.IA_FLOW_MAX_CONCURRENT_DISPATCHES = '1'
    logged.length = 0
    const { source, emit } = makeSource([])
    const pending = makePendingRegistry()
    const dispatcher = new SourceDispatcher('p1', source, () => {}, pending, 'webhook')
    const disposable = dispatcher.start(async (item: IssueItem) => {
      pending.add(item.id)
    })
    await flush()

    emit([makeItem('a'), makeItem('b')])
    await flush()
    expect(countLogged('Capacity reached — deferred some dispatches')).toBe(1)

    // Se libera el slot: el replay del backlog vacía `deferred` y ahí —y sólo
    // ahí— sale el flanco de bajada. `processBatch` no vuelve a correr en este
    // camino, que es por lo que el flanco se chequea también en retryDeferred.
    pending.removePendingTask('a')
    // El replay corre con el backoff de onSlotFreed, igual que los otros
    // tests de backlog de este archivo — de ahí la espera larga.
    await flush(1300)
    expect(countLogged('Capacity freed — deferred backlog drained')).toBe(1)

    disposable.dispose()
  }, 5000)

  test('a cap of 0 falls back to the default instead of freezing every dispatch', async () => {
    // `0` is a footgun, not a setting: read literally it makes atCapacity()
    // permanently true and no agent ever runs again for the project, with
    // nothing but a Capacity log to show for it.
    process.env.IA_FLOW_MAX_CONCURRENT_DISPATCHES = '0'
    process.env.IA_FLOW_MAX_CONCURRENT_EVALUATIONS = '0'
    const { source, emit } = makeSource([])
    const dispatcher = new SourceDispatcher(
      'p1',
      source,
      () => {},
      makePendingRegistry(),
      'webhook',
    )
    const dispatched: string[] = []
    const disposable = dispatcher.start(async (item: IssueItem) => {
      dispatched.push(item.id)
    })
    await flush()

    emit([makeItem('a')])
    await flush()
    expect(dispatched).toEqual(['a'])

    disposable.dispose()
  }, 3000)

  test('items the gates reject never hold a slot, so a runnable item is not starved', async () => {
    // The regression this whole change exists for: issues blocked by
    // unfinished dependencies were dispatched, rejected by TaskDispatcher
    // without ever starting an agent, and still occupied every slot — so the
    // very issues they were blocked ON could never run, which never resolves.
    process.env.IA_FLOW_MAX_CONCURRENT_DISPATCHES = '2'
    const { source, emit } = makeSource([])
    const pending = makePendingRegistry()
    const dispatcher = new SourceDispatcher('p1', source, () => {}, pending, 'webhook')
    const dispatched: string[] = []
    const disposable = dispatcher.start(async (item: IssueItem) => {
      dispatched.push(item.id)
      // `blocked-*` mimics the blocker gate: returns without running an agent.
      if (item.id.startsWith('blocked-')) return
      pending.add(item.id)
    })
    await flush()

    emit([
      makeItem('blocked-1'),
      makeItem('blocked-2'),
      makeItem('blocked-3'),
      makeItem('blocked-4'),
      makeItem('runnable'),
    ])
    await flush()

    expect(dispatched).toContain('runnable')

    disposable.dispose()
  }, 3000)

  test('the evaluation guard defers a burst and retries it from the local buffer', async () => {
    // The run cap ignores evaluations by design, so this separate bound is
    // what keeps a large backlog from firing every source call at once.
    process.env.IA_FLOW_MAX_CONCURRENT_EVALUATIONS = '1'
    const { source, getItemsCalls, emit } = makeSource([])
    const dispatcher = new SourceDispatcher(
      'p1',
      source,
      () => {},
      makePendingRegistry(),
      'webhook',
    )
    const dispatched: string[] = []
    const release: { current: (() => void) | null } = { current: null }
    const disposable = dispatcher.start(async (item: IssueItem) => {
      dispatched.push(item.id)
      if (item.id === 'a') {
        await new Promise<void>((resolve) => {
          release.current = resolve
        })
      }
    })
    await flush()
    const callsAfterBootScan = getItemsCalls() // boot scan always fires once

    emit([makeItem('a'), makeItem('b')])
    await flush()
    expect(dispatched).toEqual(['a']) // 'b' deferred: one evaluation in flight
    expect(getItemsCalls()).toBe(callsAfterBootScan) // deferring costs no source call

    release.current?.()
    await flush(1300)
    expect(dispatched.sort()).toEqual(['a', 'b'])
    expect(getItemsCalls()).toBe(callsAfterBootScan) // retried locally

    disposable.dispose()
  }, 3000)
})

describe('SourceDispatcher — cap por proyecto', () => {
  const originalRunCap = process.env.IA_FLOW_MAX_CONCURRENT_DISPATCHES

  afterEach(() => {
    if (originalRunCap === undefined) delete process.env.IA_FLOW_MAX_CONCURRENT_DISPATCHES
    else process.env.IA_FLOW_MAX_CONCURRENT_DISPATCHES = originalRunCap
  })

  test('el cap del proyecto gana sobre el default global de env', async () => {
    process.env.IA_FLOW_MAX_CONCURRENT_DISPATCHES = '10'
    const { source, emit } = makeSource([])
    const pending = makePendingRegistry()
    const dispatcher = new SourceDispatcher(
      'p1',
      source,
      () => {},
      pending,
      'webhook',
      undefined,
      undefined,
      {},
      {},
      () => 1,
    )
    const dispatched: string[] = []
    const disposable = dispatcher.start(async (item: IssueItem) => {
      dispatched.push(item.id)
      pending.add(item.id)
    })
    await flush()

    emit([makeItem('a'), makeItem('b')])
    await flush()
    expect(dispatched).toEqual(['a'])

    disposable.dispose()
  }, 3000)

  test('un cap de proyecto en 0 hereda el default global, no congela el proyecto', async () => {
    process.env.IA_FLOW_MAX_CONCURRENT_DISPATCHES = '5'
    const { source, emit } = makeSource([])
    const dispatcher = new SourceDispatcher(
      'p1',
      source,
      () => {},
      makePendingRegistry(),
      'webhook',
      undefined,
      undefined,
      {},
      {},
      () => 0,
    )
    const dispatched: string[] = []
    const disposable = dispatcher.start(async (item: IssueItem) => {
      dispatched.push(item.id)
    })
    await flush()

    emit([makeItem('a')])
    await flush()
    expect(dispatched).toEqual(['a'])

    disposable.dispose()
  }, 3000)

  test('se releé en cada chequeo: subir el cap en caliente libera el backlog', async () => {
    const { source, emit } = makeSource([])
    const pending = makePendingRegistry()
    let cap = 1
    const dispatcher = new SourceDispatcher(
      'p1',
      source,
      () => {},
      pending,
      'webhook',
      undefined,
      undefined,
      {},
      {},
      () => cap,
    )
    const dispatched: string[] = []
    const disposable = dispatcher.start(async (item: IssueItem) => {
      dispatched.push(item.id)
      pending.add(item.id)
    })
    await flush()

    emit([makeItem('a'), makeItem('b')])
    await flush()
    expect(dispatched).toEqual(['a'])

    // Sin reconstruir el manager ni volver a pegarle a la fuente: el backlog
    // ya tiene 'b' guardado y el retry lo replaya con el cap nuevo. La espera
    // es > CONCURRENCY_RETRY_FLOOR_MS (1s), el piso del backoff del retry.
    cap = 5
    await flush(1_200)
    expect(dispatched.sort()).toEqual(['a', 'b'])

    disposable.dispose()
  }, 5000)
})

describe('SourceDispatcher — backlog por `deferred`', () => {
  test('un dispatch que devuelve "deferred" vuelve al backlog y se replaya', async () => {
    // Falta de capacidad AGUAS ABAJO (cap del agente, todos los providers
    // saturados): el dispatcher de arriba tenía slots, así que sin esta
    // señal el item se soltaba y no volvía hasta el próximo batch.
    const { source, emit } = makeSource([])
    const dispatcher = new SourceDispatcher(
      'p1',
      source,
      () => {},
      makePendingRegistry(),
      'webhook',
    )
    const attempts: string[] = []
    let admit = false
    const disposable = dispatcher.start(async (item: IssueItem) => {
      attempts.push(item.id)
      if (!admit) return 'deferred'
      return 'dispatched'
    })
    await flush()

    emit([makeItem('a')])
    await flush()
    expect(attempts).toEqual(['a'])

    admit = true
    // > CONCURRENCY_RETRY_FLOOR_MS (1s): el replay es event-driven pero con
    // un piso de backoff para no tight-loopear.
    await flush(1_200)
    // Se reintentó solo, sin un batch nuevo ni una llamada más a la fuente.
    expect(attempts.length).toBeGreaterThan(1)
    expect(attempts.every((id) => id === 'a')).toBe(true)

    disposable.dispose()
  }, 5000)

  test('con providers async el backlog no se queda dormido', async () => {
    // Un provider async (tmux/iterm) devuelve apenas spawnea la sesión: el
    // dispatch RESUELVE mientras el agente sigue contando en runningAgents().
    // Si el cap se llenó con esas sesiones y no queda ningún dispatch en
    // vuelo, el `finally` de dispatchNow ya no vuelve a disparar — sin
    // re-armar el timer desde retryDeferred, el backlog dormía hasta el
    // próximo batch de la fuente.
    const { source, emit } = makeSource([])
    const pending = makePendingRegistry()
    const dispatcher = new SourceDispatcher(
      'p1',
      source,
      () => {},
      pending,
      'webhook',
      undefined,
      undefined,
      {},
      {},
      () => 1,
    )
    const dispatched: string[] = []
    const disposable = dispatcher.start(async (item: IssueItem) => {
      dispatched.push(item.id)
      pending.add(item.id) // la sesión async queda viva tras resolver
      return 'dispatched'
    })
    await flush()

    emit([makeItem('a'), makeItem('b')])
    await flush()
    expect(dispatched).toEqual(['a'])

    // Dejamos pasar el primer retry CON el slot todavía ocupado: encuentra
    // capacidad llena y corta. Ese es el momento en que el backlog quedaba
    // huérfano — el `finally` de dispatchNow ya corrió y no va a volver.
    await flush(1_300)
    expect(dispatched).toEqual(['a'])

    // Recién ahora termina la sesión async. Nadie está despachando nada, así
    // que el único camino de vuelta es el retry habiéndose re-armado solo.
    pending.removePendingTask('a')
    await flush(1_500)
    expect(dispatched.sort()).toEqual(['a', 'b'])

    disposable.dispose()
  }, 8000)

  test('un delivery con el dispatch de esa misma task aún en vuelo se difiere y se replaya solo', async () => {
    // La carrera del issue #82: el agente termina, escribe el status nuevo y
    // el `labeled` de GitHub vuelve ANTES de que el `finally` del run (que
    // incluye el cleanup del worktree) suelte el dispatch. Ese delivery era
    // el único que traía el status fresco — descartarlo dejaba el issue
    // colgado hasta un nudge manual.
    logged.length = 0
    const { source, emit } = makeSource([])
    const dispatcher = new SourceDispatcher(
      'p1',
      source,
      () => {},
      makePendingRegistry(),
      'webhook',
    )
    const attempts: string[] = []
    const release: { current: (() => void) | null } = { current: null }
    let hold = true
    const disposable = dispatcher.start(async (item: IssueItem) => {
      attempts.push(item.id)
      if (hold) {
        await new Promise<void>((resolve) => {
          release.current = resolve
        })
      }
      return 'dispatched'
    })
    await flush()

    emit([makeItem('a')])
    await flush()
    expect(attempts).toEqual(['a']) // en vuelo, sostenido en el provider

    // El delivery del fin de run llega con el dispatch todavía sin soltar:
    // no se despacha en paralelo (lo que el check original protegía)...
    emit([makeItem('a')])
    await flush()
    expect(attempts).toEqual(['a'])
    // ...y el descarte deja rastro, con el id y el motivo.
    expect(countLogged('Item already in flight — deferred until the current run releases')).toBe(1)
    expect(logged.some((l) => JSON.stringify(l.fields).includes('"itemId":"a"'))).toBe(true)

    // Otro batch mientras sigue en vuelo: el log es en flanco, ni una línea más.
    emit([makeItem('a')])
    await flush()
    expect(countLogged('Item already in flight — deferred until the current run releases')).toBe(1)

    // El run se suelta — el backlog replaya el item sin un onItems() nuevo.
    hold = false
    release.current?.()
    await flush(1_300)
    expect(attempts).toEqual(['a', 'a'])

    disposable.dispose()
  }, 5000)

  test('un delivery con la task pendiente (provider async, dispatch ya resuelto) también se replaya', async () => {
    // Variante sin ningún dispatch en vuelo: el provider async resolvió su
    // dispatch al spawnear la sesión, así que ningún `finally` va a disparar
    // el retry — tryDispatch tiene que armarlo solo al diferir.
    const { source, emit } = makeSource([])
    const pending = makePendingRegistry()
    pending.add('a')
    const dispatcher = new SourceDispatcher('p1', source, () => {}, pending, 'webhook')
    const attempts: string[] = []
    const disposable = dispatcher.start(async (item: IssueItem) => {
      attempts.push(item.id)
      return 'dispatched'
    })
    await flush()

    emit([makeItem('a')])
    await flush()
    expect(attempts).toEqual([]) // la sesión sigue viva: diferido, no descartado

    // La sesión termina sin que llegue ningún batch nuevo: el único camino de
    // vuelta es el retry que tryDispatch dejó armado (con su backoff).
    pending.removePendingTask('a')
    await flush(3_500)
    expect(attempts).toEqual(['a'])

    disposable.dispose()
  }, 8000)

  test('"skipped" NO vuelve al backlog — reintentar no cambiaría el resultado', async () => {
    const { source, emit } = makeSource([])
    const dispatcher = new SourceDispatcher(
      'p1',
      source,
      () => {},
      makePendingRegistry(),
      'webhook',
    )
    const attempts: string[] = []
    const disposable = dispatcher.start(async (item: IssueItem) => {
      attempts.push(item.id)
      return 'skipped'
    })
    await flush()

    emit([makeItem('a')])
    await flush(1_200)
    expect(attempts).toEqual(['a'])

    disposable.dispose()
  }, 3000)
})

describe('SourceDispatcher — mode: polling', () => {
  test('passes mode/projectId through to source.watch(), boot scan runs independent of the first tick', async () => {
    const captured: { opts: { mode: string; projectId: string } | null } = { opts: null }
    const source: ProjectSource = {
      kind: 'test',
      getStatuses: async () => [],
      getItems: async () => [],
      watch: (_onItems, opts) => {
        captured.opts = opts
        return { dispose: () => {} } as Disposable
      },
    }
    const dispatcher = new SourceDispatcher(
      'p1',
      source,
      () => {},
      makePendingRegistry(),
      'polling',
    )
    const disposable = dispatcher.start(async () => {})
    await flush()
    expect(captured.opts).not.toBeNull()
    expect(captured.opts?.mode).toBe('polling')
    expect(captured.opts?.projectId).toBe('p1')
    disposable.dispose()
  })
})
