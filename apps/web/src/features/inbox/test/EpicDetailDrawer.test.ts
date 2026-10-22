import type { EpicDetail } from '@ia-flow/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ReasonChips from '@/features/inbox/decisions/ReasonChips.vue'
import EpicDetailDrawer from '@/features/inbox/EpicDetailDrawer.vue'
import { useInboxStore } from '@/features/inbox/store'

const getEpic = vi.fn()
const getTaskDetail = vi.fn(() => new Promise(() => {}))
vi.mock('@/features/inbox/api', () => ({
  getEpic: (...a: unknown[]) => getEpic(...a),
  getTaskDetail: (...a: unknown[]) => getTaskDetail(...a),
}))

const issue = (repo: string, n: number) => `https://github.com/la-haus/${repo}/issues/${n}`

const EPIC: EpicDetail = {
  epic: {
    ref: 'la-haus/subscriptions#2012',
    title: 'Épica: embudo y lead management',
    url: issue('subscriptions', 2012),
    done: 1,
    total: 3,
  },
  children: [
    {
      ref: 'la-haus/subscriptions#2013',
      title: 'Tarea editada',
      url: issue('subscriptions', 2013),
      state: 'closed',
    },
    {
      ref: 'la-haus/subscriptions#2014',
      title: 'Tarea eliminada',
      url: issue('subscriptions', 2014),
      state: 'open',
      status: 'Build',
      blocked_by: ['la-haus/subscriptions#2013'],
      pr: { number: 40, url: 'https://github.com/la-haus/subscriptions/pull/40' },
    },
    {
      ref: 'la-haus/lh-seller-v2-frontend#77',
      title: 'La vista',
      url: issue('lh-seller-v2-frontend', 77),
      state: 'open',
    },
  ],
}

let pinia: ReturnType<typeof createPinia>
beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  getEpic.mockReset()
})
afterEach(() => {
  document.body.innerHTML = ''
})

const mountDrawer = () =>
  mount(EpicDetailDrawer, { global: { plugins: [pinia] }, attachTo: document.body })

async function openEpic() {
  mountDrawer()
  const store = useInboxStore()
  store.openEpic(EPIC.epic.ref)
  await flushPromises()
  return store
}

describe('el chip de la épica', () => {
  it('es un botón con el número de la épica que la abre; las demás razones no se tocan', async () => {
    getEpic.mockResolvedValue(EPIC)
    const w = mount(ReasonChips, {
      props: {
        reasons: [
          { text: 'destraba 1' },
          {
            text: 'épica #2012 Embudo 1/3',
            full: 'épica la-haus/subscriptions#2012 Embudo 1/3',
            epic: EPIC.epic.ref,
          },
        ],
      },
      global: { plugins: [pinia] },
    })
    expect(w.findAll('button')).toHaveLength(1)
    const chip = w.get('[data-test="epic-chip"]')
    expect(chip.text()).toContain('#2012')
    await chip.trigger('click')
    expect(useInboxStore().epicRef).toBe(EPIC.epic.ref)
    expect(getEpic).toHaveBeenCalledWith(EPIC.epic.ref)
  })
})

describe('EpicDetailDrawer', () => {
  it('muestra la épica y todos sus sub-issues, con columna, PR y bloqueos', async () => {
    getEpic.mockResolvedValue(EPIC)
    await openEpic()
    const drawer = document.querySelector('[data-test="epic-drawer"]') as HTMLElement
    expect(drawer.textContent).toContain('Épica: embudo y lead management')
    expect(drawer.textContent).toContain('1/3 cerrados')
    const rows = [...drawer.querySelectorAll('[data-test="epic-child"]')] as HTMLElement[]
    expect(rows).toHaveLength(3)
    expect(rows[0]?.textContent).toContain('cerrado')
    expect(rows[1]?.textContent).toContain('Build')
    expect(rows[1]?.textContent).toContain('PR #40')
    expect(rows[1]?.textContent).toContain('espera subs#2013')
    expect(rows[2]?.textContent).toContain('fuera del board')
    // Fuera del board (o cerrado): el issue en GitHub.
    expect(rows[2]?.querySelector('a')?.getAttribute('href')).toBe(EPIC.children[2]?.url)
  })

  it('un hijo del board abre su detalle y cierra la épica', async () => {
    getEpic.mockResolvedValue(EPIC)
    const store = await openEpic()
    const rows = document.querySelectorAll('[data-test="epic-child"]')
    const child = rows[1]?.querySelector('button')
    expect(child).toBeTruthy()
    child?.click()
    expect(store.epicRef).toBeNull()
    expect(store.openRef).toBe('la-haus/subscriptions#2014')
    expect(store.expanded).toBe(true)
  })

  it('si el runner falla, lo dice', async () => {
    getEpic.mockRejectedValue(new Error('Este runner no lee épicas'))
    await openEpic()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('no lee épicas')
  })
})
