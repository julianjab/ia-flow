import type { ServerLogEntry, ServerLogLevel } from '@ia-flow/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

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
