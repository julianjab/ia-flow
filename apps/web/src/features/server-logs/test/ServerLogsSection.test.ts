import type { ServerLogEntry, ServerLogLevel } from '@ia-flow/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

// The section only talks to its own `api.ts` on mount, plus `useRoute` for the
// deep-link hydration. Stub both so the pills render without a live backend.
const LEVELS: ServerLogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal']

// Repetido tal cual dentro del factory de abajo (no se puede referenciar un
// const de afuera: `vi.mock` se hoistea por encima de esta declaración,
// mismo motivo por el que LEVELS tampoco se reusa ahí).
const CLEAR_DEDUPE_CURL =
  "curl -X DELETE 'http://localhost:3001/api/webhooks/dedupe/abc:issues.unlabeled:3872' -H 'x-ia-flow-token: <IA_FLOW_WEBHOOK_SECRET>'"

vi.mock('../api', () => ({
  // Inline literal: `vi.mock` is hoisted above the LEVELS const above.
  fetchServerLogs: vi.fn().mockResolvedValue({
    entries: [
      ...(['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as ServerLogLevel[]).map(
        (level): ServerLogEntry => ({
          level,
          time: '2026-01-01T00:00:00.000Z',
          module: 'test',
          msg: `mensaje ${level}`,
        }),
      ),
      {
        level: 'info',
        time: '2026-01-01T00:00:01.000Z',
        module: 'daemon',
        msg: 'Rules NOT matched',
        extras: {
          clearDedupe:
            "curl -X DELETE 'http://localhost:3001/api/webhooks/dedupe/abc:issues.unlabeled:3872' -H 'x-ia-flow-token: <IA_FLOW_WEBHOOK_SECRET>'",
        },
      } satisfies ServerLogEntry,
    ],
    total: 7,
    levelCounts: { trace: 1, debug: 1, info: 2, warn: 1, error: 1, fatal: 1 },
  }),
  fetchServerLogModules: vi.fn().mockResolvedValue(['test', 'daemon']),
  fetchServerLogSources: vi.fn().mockResolvedValue([]),
}))
vi.mock('vue-router', () => ({
  useRoute: () => ({ query: {} }),
}))

import ServerLogsSection from '../ServerLogsSection.vue'

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

describe('ServerLogsSection — botón "Copiar curl (limpiar dedupe)"', () => {
  it('sólo aparece en la fila expandida cuando extras.clearDedupe está presente', async () => {
    const wrapper = mount(ServerLogsSection)
    await flushPromises()

    const rows = wrapper.findAll('.log-row')
    // La última fila es la que mockeamos con `extras.clearDedupe`.
    await rows[rows.length - 1]?.trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="server-logs-copy-clear-dedupe"]').exists()).toBe(true)

    // Una fila SIN `clearDedupe` (ej. la primera, `trace`) no lo muestra.
    await rows[rows.length - 1]?.trigger('click') // colapsa
    await rows[0]?.trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="server-logs-copy-clear-dedupe"]').exists()).toBe(false)
  })

  it('copia el curl exacto de extras.clearDedupe al portapapeles', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    // happy-dom expone `navigator.clipboard` como getter — hay que redefinir
    // la propiedad, `Object.assign` tira (ver ui/test/CopyButton.test.ts).
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

    const wrapper = mount(ServerLogsSection)
    await flushPromises()
    const rows = wrapper.findAll('.log-row')
    await rows[rows.length - 1]?.trigger('click')
    await flushPromises()

    await wrapper.find('[data-testid="server-logs-copy-clear-dedupe"]').trigger('click')

    expect(writeText).toHaveBeenCalledWith(CLEAR_DEDUPE_CURL)
  })
})
