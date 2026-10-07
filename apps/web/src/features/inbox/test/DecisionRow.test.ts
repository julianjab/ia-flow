import type { InboxItem } from '@ia-flow/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { execution, item } from '@/features/inbox/test/fixtures'

const postTaskAction = vi.fn()
vi.mock('@/features/inbox/api', () => ({
  getInbox: vi.fn().mockResolvedValue({ generated_at: 'x', projects: [], items: [] }),
  getTasks: vi.fn().mockResolvedValue(null),
  getTaskDetail: vi.fn().mockResolvedValue({ item: {}, executions: [], events: [], trace: [] }),
  postTaskAction: (...a: unknown[]) => postTaskAction(...a),
}))
vi.mock('@/composables/useServerTarget', () => ({
  serverTarget: () => ({ base: 'https://runner.test', url: (p: string) => p }),
}))

import DecisionRow from '@/features/inbox/decisions/DecisionRow.vue'
import FirstDecision from '@/features/inbox/decisions/FirstDecision.vue'
import { buildQueue } from '@/features/inbox/queue/build'
import type { QueueRow } from '@/features/inbox/queue/entries'
import { useGithubSessionStore } from '@/stores/githubSession'

const NOW = Date.parse('2026-01-03T10:00:00.000Z')

const merge = (n: number, over: Partial<InboxItem> = {}) =>
  item({
    ref: `la-haus/lh-seller-v2-frontend#${n}`,
    title: `Merge ${n}`,
    pr: { number: n + 1000, url: 'https://github.com/x/pull/1' },
    ...over,
  })
const stale = item({
  ref: 'la-haus/subscriptions#20',
  kind: 'stale',
  title: 'Paginación',
  actions: ['relaunch'],
  execution: execution({ agent_id: 'implementer' }),
})
const doubt = item({
  ref: 'acme/api#30',
  kind: 'doubt',
  title: 'Teléfonos',
  actions: ['answer_and_unblock'],
  agent_said: '¿+57 o error?',
  execution: execution({ status: 'done', agent_id: 'refiner' }),
})
const lead = item({ ref: 'acme/api#1', kind: 'prd', actions: ['approve_prd'] })

/** Las filas de «Después» para estos items (el primero es «Lo primero»). */
function rows(items: InboxItem[]): QueueRow[] {
  return buildQueue({ items: [lead, ...items], now: NOW }).rest
}

function setup(login: string | null = 'ada') {
  const pinia = createPinia()
  setActivePinia(pinia)
  const session = useGithubSessionStore()
  session.github = login ? { token: 'gho_1', login } : null
  vi.spyOn(session, 'requestLogin')
  return { pinia, session }
}

const mountRow = (row: QueueRow, pinia: ReturnType<typeof createPinia>) =>
  mount(DecisionRow, { props: { row }, global: { plugins: [pinia] }, attachTo: document.body })

describe('DecisionRow', () => {
  beforeEach(() => {
    postTaskAction.mockReset()
    vi.spyOn(window, 'confirm').mockImplementation(() => {
      throw new Error('window.confirm no se usa')
    })
  })

  it('mergear pide confirmación EN LÍNEA: dice qué se firma y con quién, y reemplaza al botón', async () => {
    postTaskAction.mockResolvedValue({ ok: true, message: 'mergeado' })
    const { pinia } = setup()
    const w = mountRow(rows([merge(7)])[0] as QueueRow, pinia)

    const button = w.get('.dr__head [data-action="merge"]')
    expect(button.text()).toBe('Mergear…')
    await button.trigger('click')

    const confirm = w.get('[data-test="inline-confirm"]')
    expect(confirm.attributes('role')).toBe('group')
    expect(confirm.text()).toContain('PR #1007 de seller#7')
    expect(confirm.text()).toContain('tu usuario de GitHub (@ada)')
    expect(w.find('.dr__head [data-action="merge"]').exists()).toBe(false)
    expect(postTaskAction).not.toHaveBeenCalled()

    await confirm.get('[data-test="confirm"]').trigger('click')
    await flushPromises()
    expect(confirm.get('[data-test="confirm"]').text()).toBe('Mergear ahora')
    expect(postTaskAction).toHaveBeenCalledWith(
      'la-haus/lh-seller-v2-frontend#7',
      { action: 'merge' },
      'gho_1',
    )
    expect(window.confirm).not.toHaveBeenCalled()
  })

  it('Cancelar vuelve al botón sin mandar nada', async () => {
    const { pinia } = setup()
    const w = mountRow(rows([merge(7)])[0] as QueueRow, pinia)
    await w.get('[data-action="merge"]').trigger('click')
    await w.findAll('[data-test="inline-confirm"] .btn')[0]?.trigger('click')
    expect(w.find('[data-test="inline-confirm"]').exists()).toBe(false)
    expect(w.find('.dr__head [data-action="merge"]').exists()).toBe(true)
    expect(postTaskAction).not.toHaveBeenCalled()
  })

  it('relanzar no confirma; su error queda pegado al botón con qué pasó y qué hacer', async () => {
    postTaskAction.mockRejectedValue(new Error('Network Error'))
    const { pinia } = setup()
    const w = mountRow(rows([stale])[0] as QueueRow, pinia)

    await w.get('[data-action="relaunch"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-test="inline-confirm"]').exists()).toBe(false)
    const alert = w.get('[role="alert"]')
    expect(alert.text()).toContain('✕ No se pudo relanzar: el runner no respondió (Network Error).')
    expect(alert.text()).toContain('→ Revisá la conexión y reintentá.')
    // Pegado: va justo después de la cabecera con el botón, no al final de la card.
    expect(alert.element.previousElementSibling?.classList.contains('dr__head')).toBe(true)

    postTaskAction.mockResolvedValue({ ok: true, message: 'relanzado' })
    await alert.get('button').trigger('click')
    await flushPromises()
    expect(postTaskAction).toHaveBeenCalledTimes(2)
    expect(w.find('[role="alert"]').exists()).toBe(false)
  })

  it('un rechazo del runner (ok: false) también se ve pegado al botón', async () => {
    postTaskAction.mockResolvedValue({ ok: false, message: 'el PR no es mergeable' })
    const { pinia } = setup()
    const w = mountRow(rows([merge(7)])[0] as QueueRow, pinia)
    await w.get('[data-action="merge"]').trigger('click')
    await w.get('[data-test="confirm"]').trigger('click')
    await flushPromises()
    expect(w.get('[role="alert"]').text()).toContain('el PR no es mergeable')
  })

  it('sin sesión de GitHub pide el login y no manda nada', async () => {
    const { pinia, session } = setup(null)
    const w = mountRow(rows([stale])[0] as QueueRow, pinia)
    await w.get('[data-action="relaunch"]').trigger('click')
    await flushPromises()
    expect(session.requestLogin).toHaveBeenCalled()
    expect(postTaskAction).not.toHaveBeenCalled()
  })

  it('responder sin texto abre el detalle con el textarea; con texto, lo manda sin confirmar', async () => {
    postTaskAction.mockResolvedValue({ ok: true, message: 'listo' })
    const { pinia } = setup()
    const w = mountRow(rows([doubt])[0] as QueueRow, pinia)

    await w.get('[data-action="answer_and_unblock"]').trigger('click')
    await flushPromises()
    expect(postTaskAction).not.toHaveBeenCalled()
    const textarea = w.get('textarea')
    expect(w.get(`label[for="${textarea.attributes('id')}"]`).text()).toBe(
      'Tu respuesta · se publica como comentario',
    )
    // ✦ y --ai sólo marcan quién lo dijo; el texto del modelo va aparte, en --fg-mute.
    expect(w.get('.dd__ai').text()).toContain('✦')
    expect(w.get('.dd__said').text()).toBe('¿+57 o error?')

    await textarea.setValue('Se asumen +57')
    await w.get('[data-action="answer_and_unblock"]').trigger('click')
    await flushPromises()
    expect(postTaskAction).toHaveBeenCalledWith(
      'acme/api#30',
      { action: 'answer_and_unblock', comment: 'Se asumen +57' },
      'gho_1',
    )
  })

  it('un grupo lista sus hijas con su link y su botón, y el botón del grupo confirma y corre en serie', async () => {
    postTaskAction.mockResolvedValue({ ok: true, message: 'ok' })
    const { pinia } = setup()
    const [group] = rows([merge(7), merge(8)])
    expect(group?.kind).toBe('group')
    const w = mountRow(group as QueueRow, pinia)

    expect(w.get('.dr__verb').text()).toContain('Mergear 2 PRs')
    await w.get('[data-test="toggle"]').trigger('click')
    const kids = w.findAll('.dc')
    expect(kids.map((k) => k.get('a.ref').text())).toEqual(['seller#7 ↗', 'seller#8 ↗'])
    expect(kids.every((k) => k.find('[data-action="merge"] button, button').exists())).toBe(true)

    await w.get('.dr__head [data-action="merge"]').trigger('click')
    expect(w.get('[data-test="inline-confirm"]').text()).toContain('seller#7 y seller#8')
    await w.get('.dr > [data-test="inline-confirm"] [data-test="confirm"]').trigger('click')
    await flushPromises()
    expect(postTaskAction.mock.calls.map((c) => c[0])).toEqual([
      'la-haus/lh-seller-v2-frontend#7',
      'la-haus/lh-seller-v2-frontend#8',
    ])
  })

  it('si el grupo corta en una hija, se abre y el error queda junto a esa hija', async () => {
    postTaskAction
      .mockResolvedValueOnce({ ok: true, message: 'ok' })
      .mockRejectedValueOnce(new Error('Network Error'))
    const { pinia } = setup()
    const w = mountRow(rows([merge(7), merge(8)])[0] as QueueRow, pinia)
    await w.get('.dr__head [data-action="merge"]').trigger('click')
    await w.get('[data-test="confirm"]').trigger('click')
    await flushPromises()

    const kids = w.findAll('.dc')
    expect(kids).toHaveLength(2)
    expect(kids[0]?.find('[role="alert"]').exists()).toBe(false)
    expect(kids[1]?.get('[role="alert"]').text()).toContain('Network Error')
  })

  it('una secundaria que exige texto está deshabilitada hasta que se escribe', async () => {
    postTaskAction.mockResolvedValue({ ok: true, message: 'listo' })
    const { pinia } = setup()
    const both = { ...doubt, actions: ['relaunch', 'answer_and_unblock'], primary: 'relaunch' }
    const w = mountRow(rows([both as InboxItem])[0] as QueueRow, pinia)
    await w.get('[data-test="toggle"]').trigger('click')
    await flushPromises()

    const secondary = () => w.get('.dd__more [data-action="answer_and_unblock"] button')
    expect(secondary().attributes('disabled')).toBeDefined()
    await w.get('textarea').setValue('Se asumen +57')
    expect(secondary().attributes('disabled')).toBeUndefined()
    await secondary().trigger('click')
    await flushPromises()
    expect(postTaskAction).toHaveBeenCalledWith(
      'acme/api#30',
      { action: 'answer_and_unblock', comment: 'Se asumen +57' },
      'gho_1',
    )
  })

  it('un grupo no repite su cuenta en la línea de razones (ya la dicen el verbo y el botón)', () => {
    const { pinia } = setup()
    const w = mountRow(rows([merge(7), merge(8)])[0] as QueueRow, pinia)
    expect(w.get('.dr__verb').text()).toContain('2')
    expect(w.get('.dr__why').text()).not.toContain('2')
  })

  it('con la confirmación abierta no quedan la antigüedad, el toggle ni el botón: sólo la confirmación', async () => {
    const { pinia } = setup()
    const w = mountRow(rows([merge(7)])[0] as QueueRow, pinia)
    expect(w.find('[data-test="toggle"]').exists()).toBe(true)
    await w.get('.dr__head [data-action="merge"]').trigger('click')
    expect(w.find('[data-test="inline-confirm"]').exists()).toBe(true)
    expect(w.find('[data-test="toggle"]').exists()).toBe(false)
    expect(w.find('.dr__head [data-action="merge"]').exists()).toBe(false)
    expect(w.find('.dr__head time.age').exists()).toBe(false)
    await w.findAll('[data-test="inline-confirm"] .btn')[0]?.trigger('click')
    expect(w.find('[data-test="toggle"]').exists()).toBe(true)
  })

  it('cada hija de un grupo lleva su antigüedad', async () => {
    const { pinia } = setup()
    const w = mountRow(rows([merge(7), merge(8)])[0] as QueueRow, pinia)
    await w.get('[data-test="toggle"]').trigger('click')
    expect(w.findAll('.dc time.age').map((t) => t.text())).toEqual(['2 d', '2 d'])
  })

  it('el toggle apunta a un elemento que existe aunque la fila esté cerrada', () => {
    const { pinia } = setup()
    const w = mountRow(rows([stale])[0] as QueueRow, pinia)
    const toggle = w.get('[data-test="toggle"]')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    const id = toggle.attributes('aria-controls') ?? ''
    expect(document.getElementById(id)).not.toBeNull()
    w.unmount()
  })

  it('ocupado, el botón dice «· ejecutando» sin «…» (la elipsis es de las que confirman)', async () => {
    let resolve: (v: unknown) => void = () => {}
    postTaskAction.mockReturnValue(new Promise((r) => (resolve = r)))
    const { pinia } = setup()
    const w = mountRow(rows([stale])[0] as QueueRow, pinia)
    await w.get('.dr__head [data-action="relaunch"]').trigger('click')
    await flushPromises()
    expect(w.get('.dr__head [data-action="relaunch"]').text()).toBe('· ejecutando')
    resolve({ ok: true, message: 'ok' })
    await flushPromises()
    w.unmount()
  })
})

describe('FirstDecision', () => {
  it('lleva el único primario (alto --tap-h-lg), el link corto, hasta 3 razones y el porqué', () => {
    const { pinia } = setup()
    const first = buildQueue({
      items: [
        merge(7, {
          chips: [
            { text: 'a un merge de Done', tone: 'hot' },
            { text: 'destraba #4284', tone: 'hot' },
            { text: 'uno' },
            { text: 'dos' },
          ],
          context: 'El reviewer aprobó sin pedir cambios.',
        }),
      ],
      now: NOW,
    }).first
    const w = mount(FirstDecision, {
      props: { entry: first as NonNullable<typeof first>, total: 3 },
      global: { plugins: [pinia] },
    })
    expect(w.text()).toContain('Lo primero · 1 de 3')
    expect(w.get('.btn--primary').text()).toBe('Mergear…')
    expect(w.get('a.ref').text()).toBe('seller#7 ↗')
    expect(w.findAll('.why')).toHaveLength(3)
    expect(w.text()).toContain('El reviewer aprobó sin pedir cambios.')
    expect(w.get('time').classes()).toContain('age--old')
  })

  it('en el teléfono el porqué se pliega tras «Por qué ▾»; pedir el texto lo abre', async () => {
    const { pinia } = setup()
    const first = buildQueue({ items: [doubt], now: NOW }).first
    const w = mount(FirstDecision, {
      props: { entry: first as NonNullable<typeof first>, total: 1 },
      global: { plugins: [pinia] },
    })
    const why = w.get('[data-test="first-why"]')
    expect(why.attributes('aria-expanded')).toBe('false')
    expect(why.attributes('aria-controls')).toBe('first-detail')
    expect(w.get('#first-detail').classes()).not.toContain('fd__detail--open')

    // Responder sin texto: abre el porqué para que se vea el textarea.
    await w.get('.btn--primary').trigger('click')
    await flushPromises()
    expect(why.attributes('aria-expanded')).toBe('true')
    expect(w.get('#first-detail').classes()).toContain('fd__detail--open')
  })

  it('su confirmación ocupa el lugar del primario y lo hereda', async () => {
    const { pinia } = setup()
    const first = buildQueue({ items: [merge(7)], now: NOW }).first
    const w = mount(FirstDecision, {
      props: { entry: first as NonNullable<typeof first>, total: 1 },
      global: { plugins: [pinia] },
    })
    await w.get('.btn--primary').trigger('click')
    expect(w.findAll('.btn--primary').map((b) => b.text())).toEqual(['Mergear ahora'])
  })
})
