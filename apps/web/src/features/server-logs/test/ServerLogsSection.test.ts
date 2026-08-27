import type { ServerLogEntry, ServerLogLevel } from '@ia-flow/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The section only talks to its own `api.ts` on mount, plus `useRoute` for the
// deep-link hydration. Stub both so the pills render without a live backend.
const LEVELS: ServerLogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal']

vi.mock('../api', () => ({
  // Inline literal: `vi.mock` is hoisted above the LEVELS const above.
  fetchServerLogs: vi.fn().mockResolvedValue({
    entries: (['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as ServerLogLevel[]).map(
      (level): ServerLogEntry => ({
        level,
        time: '2026-01-01T00:00:00.000Z',
        module: 'test',
        msg: `mensaje ${level}`,
      }),
    ),
    total: 6,
    levelCounts: { trace: 1, debug: 1, info: 1, warn: 1, error: 1, fatal: 1 },
  }),
  fetchServerLogModules: vi.fn().mockResolvedValue(['test']),
  fetchServerLogSources: vi.fn().mockResolvedValue([]),
}))
vi.mock('vue-router', () => ({
  useRoute: () => ({ query: {} }),
}))

// Captura el handler que el componente registra en el WS compartido. Sin
// esto el composable real abre un `new WebSocket()` contra happy-dom, y
// además no habría forma de empujarle un `log:entry` desde el test.
// `vi.hoisted` porque la factory de `vi.mock` corre antes que este módulo.
const live = vi.hoisted(() => ({ handlers: [] as Array<(msg: unknown) => void> }))
vi.mock('@/composables/useServerEvents', async () => {
  const { ref } = await import('vue')
  const connected = ref(true)
  return {
    useServerEvents: (handler: (msg: unknown) => void) => {
      live.handlers.push(handler)
      return { connected }
    },
  }
})

import ServerLogsSection from '../ServerLogsSection.vue'
import { fetchServerLogs } from '../api'

const fetchMock = vi.mocked(fetchServerLogs)
const PAGE = {
  entries: (['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as ServerLogLevel[]).map(
    (level): ServerLogEntry => ({
      level,
      time: '2026-01-01T00:00:00.000Z',
      module: 'test',
      msg: `mensaje ${level}`,
    }),
  ),
  total: 6,
  levelCounts: { trace: 1, debug: 1, info: 1, warn: 1, error: 1, fatal: 1 },
}

beforeEach(() => {
  live.handlers.length = 0
})

// Empuja un `log:entry` por todos los handlers vivos, como haría el WS.
function emitLogEntry(entry: Partial<ServerLogEntry> & { level: ServerLogLevel }) {
  const full = {
    time: '2026-01-01T00:00:01.000Z',
    module: 'test',
    msg: 'linea en vivo',
    ...entry,
  }
  for (const handler of live.handlers) handler({ type: 'log:entry', entry: full })
}

// Reads the inline style of every `.log-level` pill, keyed by its level text.
async function mountPills(): Promise<Record<string, CSSStyleDeclaration>> {
  const wrapper = mount(ServerLogsSection)
  await flushPromises()
  const pills: Record<string, CSSStyleDeclaration> = {}
  for (const pill of wrapper.findAll('.log-level')) {
    pills[pill.text()] = (pill.element as HTMLElement).style
  }
  return pills
}

describe('ServerLogsSection — colores del pill de nivel', () => {
  it('pinta el pill de debug con foreground oscuro sobre el fondo cyan', async () => {
    const pills = await mountPills()
    expect(pills.debug.background).toBe('var(--info)')
    expect(pills.debug.color).toBe('var(--panel)')
  })

  it('no usa el accent verde como foreground de ningún pill (contraste ilegible)', async () => {
    const pills = await mountPills()
    for (const level of LEVELS) {
      expect(pills[level].color).not.toBe('var(--accent)')
    }
  })

  it('deja el resto de los niveles con su par bg/fg original', async () => {
    const pills = await mountPills()
    const expected: Record<string, { bg: string; fg: string }> = {
      trace: { bg: 'var(--fg-dim)', fg: 'var(--panel)' },
      info: { bg: 'var(--accent)', fg: 'var(--panel)' },
      warn: { bg: 'var(--warn)', fg: 'var(--panel)' },
      error: { bg: 'var(--danger)', fg: 'var(--panel)' },
      fatal: { bg: 'var(--danger)', fg: 'var(--panel)' },
    }
    for (const [level, { bg, fg }] of Object.entries(expected)) {
      expect(pills[level].background).toBe(bg)
      expect(pills[level].color).toBe(fg)
    }
  })
})

describe('ServerLogsSection — live tail', () => {
  it('mergea una entrada que matchea los filtros y sube los contadores', async () => {
    const wrapper = mount(ServerLogsSection)
    await flushPromises()
    expect(wrapper.findAll('.log-card')).toHaveLength(6)
    expect(wrapper.get('[data-testid="server-logs-summary-info"]').text()).toContain('1')

    emitLogEntry({ level: 'info', msg: 'algo pasó en vivo' })
    await flushPromises()

    expect(wrapper.findAll('.log-card')).toHaveLength(7)
    expect(wrapper.text()).toContain('algo pasó en vivo')
    expect(wrapper.get('[data-testid="server-logs-summary-info"]').text()).toContain('2')
    // `total` es post-filtro de nivel, igual que en el server.
    expect(wrapper.text()).toContain('7 entradas')
  })

  it('inserta arriba con el orden descendente por defecto', async () => {
    const wrapper = mount(ServerLogsSection)
    await flushPromises()

    emitLogEntry({ level: 'info', msg: 'la más nueva' })
    await flushPromises()

    expect(wrapper.findAll('.log-card')[0].text()).toContain('la más nueva')
  })

  it('descarta una entrada de otro módulo cuando hay filtro de módulo activo', async () => {
    const wrapper = mount(ServerLogsSection)
    await flushPromises()
    await wrapper.get('[data-testid="server-logs-filter-module-chip-test"]').trigger('click')
    await flushPromises()

    emitLogEntry({ level: 'info', module: 'otro-modulo', msg: 'no debería entrar' })
    await flushPromises()

    expect(wrapper.findAll('.log-card')).toHaveLength(6)
    expect(wrapper.text()).not.toContain('no debería entrar')
    expect(wrapper.get('[data-testid="server-logs-summary-info"]').text()).toContain('1')
  })

  it('descarta una entrada cuyo msg no contiene el search aplicado', async () => {
    const wrapper = mount(ServerLogsSection)
    await flushPromises()
    await wrapper.get('[data-testid="server-logs-filter-search"]').setValue('token-unico')
    // El search entra por debounce de 300ms; forzarlo con timers falsos no
    // agrega nada: el filtro se evalúa contra `searchApplied`, así que basta
    // esperar a que el debounce lo publique.
    await new Promise((resolve) => setTimeout(resolve, 350))
    await flushPromises()

    emitLogEntry({ level: 'info', msg: 'sin la aguja adentro' })
    await flushPromises()

    expect(wrapper.text()).not.toContain('sin la aguja adentro')
  })

  it('descarta una entrada de otro source cuando hay filtro de source activo', async () => {
    const wrapper = mount(ServerLogsSection)
    await flushPromises()
    // El chip de source aparece recién cuando el live tail descubre uno.
    emitLogEntry({ level: 'info', msg: 'del container A', extras: { source: 'contenedor-a' } })
    await flushPromises()
    await wrapper
      .get('[data-testid="server-logs-filter-source-chip-contenedor-a"]')
      .trigger('click')
    await flushPromises()

    emitLogEntry({ level: 'info', msg: 'del daemon local' })
    await flushPromises()

    expect(wrapper.text()).not.toContain('del daemon local')
  })

  it('con filtro de nivel no inserta la fila pero igual cuenta el nivel, como el server', async () => {
    const wrapper = mount(ServerLogsSection)
    await flushPromises()
    await wrapper.get('[data-testid="server-logs-summary-error"]').trigger('click')
    await flushPromises()

    emitLogEntry({ level: 'warn', msg: 'un warn con filtro de error puesto' })
    await flushPromises()

    expect(wrapper.text()).not.toContain('un warn con filtro de error puesto')
    // `levelCounts` describe el universo IGNORANDO el filtro de nivel — es
    // lo que devolvería el próximo GET /api/server-logs.
    expect(wrapper.get('[data-testid="server-logs-summary-warn"]').text()).toContain('2')
  })

  it('con el toggle apagado no entra nada por WS', async () => {
    const wrapper = mount(ServerLogsSection)
    await flushPromises()
    await wrapper.get('[data-testid="server-logs-live-toggle"]').trigger('click')
    await flushPromises()

    emitLogEntry({ level: 'info', msg: 'live apagado' })
    await flushPromises()

    expect(wrapper.findAll('.log-card')).toHaveLength(6)
    expect(wrapper.text()).not.toContain('live apagado')
  })

  it('ignora un payload que no valida contra ServerLogEntrySchema', async () => {
    const wrapper = mount(ServerLogsSection)
    await flushPromises()

    for (const handler of live.handlers) {
      handler({ type: 'log:entry', entry: { level: 'no-es-un-nivel', msg: 'basura' } })
      handler({ type: 'log:entry', entry: null })
      handler({ type: 'otro:evento', entry: { level: 'info', time: 'x', msg: 'ignorame' } })
    }
    await flushPromises()

    expect(wrapper.findAll('.log-card')).toHaveLength(6)
  })

  it('con un orden no cronológico cuenta las nuevas en vez de romper el orden', async () => {
    const wrapper = mount(ServerLogsSection)
    await flushPromises()
    await wrapper.get('[data-testid="server-logs-sort-level"]').trigger('click')
    await flushPromises()

    emitLogEntry({ level: 'info', msg: 'no puede insertarse acá' })
    await flushPromises()

    expect(wrapper.findAll('.log-card')).toHaveLength(6)
    expect(wrapper.text()).not.toContain('no puede insertarse acá')
    const banner = wrapper.get('[data-testid="server-logs-live-pending"]')
    expect(banner.text()).toContain('1 entrada nueva')
    expect(wrapper.find('[data-testid="server-logs-live-catchup"]').exists()).toBe(true)
  })

  it('con orden ascendente cuenta las nuevas: el tope que mira el usuario deja de ser el de arriba', async () => {
    const wrapper = mount(ServerLogsSection)
    await flushPromises()
    // El primer click sobre la columna activa invierte la dirección.
    await wrapper.get('[data-testid="server-logs-sort-time"]').trigger('click')
    await flushPromises()

    emitLogEntry({ level: 'info', msg: 'nueva en ascendente' })
    await flushPromises()

    expect(wrapper.text()).not.toContain('nueva en ascendente')
    expect(wrapper.get('[data-testid="server-logs-live-pending"]').text()).toContain(
      '1 entrada nueva',
    )
  })

  it('no mergea mientras hay un fetch en vuelo — su respuesta pisaría el merge', async () => {
    let settle: ((page: typeof PAGE) => void) | undefined
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve
        }),
    )
    const wrapper = mount(ServerLogsSection)
    await flushPromises()

    emitLogEntry({ level: 'info', msg: 'llegó durante el fetch' })
    settle?.(PAGE)
    await flushPromises()

    // Sin esto la fila entraría dos veces (la del WS + la del response) y el
    // `total` del server pisaría el incremento local.
    expect(wrapper.findAll('.log-card')).toHaveLength(6)
    expect(wrapper.text()).not.toContain('llegó durante el fetch')
    expect(wrapper.get('[data-testid="server-logs-live-pending"]').text()).toContain(
      '1 entrada nueva',
    )
  })

  it('recorta el buffer para que una sesión larga no crezca sin techo', async () => {
    const wrapper = mount(ServerLogsSection)
    await flushPromises()

    for (let i = 0; i < 520; i++) {
      emitLogEntry({ level: 'info', msg: `linea ${i}` })
    }
    await flushPromises()

    // LIVE_BUFFER_MAX = 500 en el componente.
    expect(wrapper.findAll('.log-card')).toHaveLength(500)
    // Se recorta por el extremo viejo: la última que entró sigue arriba.
    expect(wrapper.findAll('.log-card')[0].text()).toContain('linea 519')
  })
})
