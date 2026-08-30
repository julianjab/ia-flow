import RulesSection from '@/features/rules/RulesSection.vue'
import type { Pipeline, Rule } from '@ia-flow/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const rule = (over: Partial<Rule> = {}): Rule =>
  ({
    id: 'r1',
    on: ['issue.status_changed'],
    do: [{ action: 'agent', agentId: 'refiner' }],
    ...over,
  }) as Rule

const empty: Pipeline = {
  rules: [],
  running: [],
  waits: [],
  gaps: { unusedAgents: [], statusesWithoutRules: [] },
  vocabulary: { agentIds: [], statuses: [], repos: [], actionIds: [] },
}

let pipeline: Pipeline = empty
let rules: Rule[] = []

vi.mock('@/features/rules/api', () => ({
  fetchRules: vi.fn(async () => ({ rules, readOnly: false })),
  fetchActionKinds: vi.fn(async () => ['agent', 'http', 'emit']),
  fetchPipeline: vi.fn(async () => pipeline),
  createRule: vi.fn(),
  updateRule: vi.fn(),
  deleteRule: vi.fn(),
  reorderRules: vi.fn(),
  // Las acciones con nombre tienen su propio test: acá se stubea la sección
  // entera, pero el mock del módulo igual las necesita — reemplaza al módulo
  // completo, así que una función faltante rompe el import del hijo.
  fetchActions: vi.fn(async () => ({ actions: [], readOnly: false })),
  createAction: vi.fn(),
  updateAction: vi.fn(),
  deleteAction: vi.fn(),
}))
vi.mock('@/stores/toast', () => ({
  useToastStore: () => ({ success: vi.fn(), error: vi.fn() }),
}))

async function mountSection() {
  const w = mount(RulesSection, {
    props: { scope: { kind: 'global' as const } },
    global: { stubs: { RuleEditorModal: true, ConfirmDialog: true, NamedActionsSection: true } },
  })
  await flushPromises()
  return w
}

describe('RulesSection — lo que corre encima', () => {
  beforeEach(() => {
    rules = [rule()]
    pipeline = { ...empty }
  })

  // La decisión que ordena la pantalla: el run se dibuja SOBRE la regla que lo
  // lanzó. "Qué pasa" y "por qué pasa" es una sola pregunta.
  it('cuelga el run de la regla que lo lanzó', async () => {
    pipeline = {
      ...empty,
      running: [
        {
          taskId: 't1',
          issueNumber: 482,
          agentId: 'refiner',
          ruleId: 'r1',
          status: 'x',
          isSubAgent: false,
        },
      ],
    }

    const w = await mountSection()
    expect(w.find('.rs-run').text()).toContain('refiner · #482')
    expect(w.find('.rs-running').text()).toContain('1 corriendo')
  })

  // Colgarlo de una regla equivocada es peor que no mostrarlo acá.
  it('un run sin regla no se cuelga de ninguna', async () => {
    pipeline = {
      ...empty,
      running: [{ taskId: 't1', agentId: 'suelto', status: 'x', isSubAgent: false }],
    }

    const w = await mountSection()
    expect(w.find('.rs-run').exists()).toBe(false)
    expect(w.find('.rs-running').text()).toContain('1 corriendo')
  })

  it('distingue una pausa de una espera por el glifo', async () => {
    pipeline = {
      ...empty,
      waits: [
        {
          id: 'w1',
          taskId: 't1',
          agentId: 'a',
          on: ['task.message'],
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          isPause: true,
        },
        {
          id: 'w2',
          taskId: 't2',
          agentId: 'b',
          on: ['ci.finished'],
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          isPause: false,
        },
      ],
    }

    const w = await mountSection()
    const texts = w.findAll('.rs-wait').map((e) => e.text())
    expect(texts[0]).toContain('⏸')
    expect(texts[1]).toContain('○')
  })

  it('avisa de los agentes que ninguna regla usa', async () => {
    pipeline = { ...empty, gaps: { unusedAgents: ['releaser'], statusesWithoutRules: [] } }

    const w = await mountSection()
    expect(w.find('.rs-gap').text()).toContain('releaser')
    expect(w.find('.rs-gap').text()).toContain('nunca van a correr')
  })

  it('avisa de los statuses sin ninguna regla', async () => {
    pipeline = { ...empty, gaps: { unusedAgents: [], statusesWithoutRules: ['Bloqueado'] } }

    const w = await mountSection()
    expect(w.find('.rs-gap').text()).toContain('Bloqueado')
  })

  // Perder el overlay no puede impedir editar una regla: el CRUD es la función
  // primaria de la pantalla y no depende del pipeline.
  it('si el pipeline falla, el listado sigue andando', async () => {
    const api = await import('@/features/rules/api')
    vi.mocked(api.fetchPipeline).mockRejectedValueOnce(new Error('502'))

    const w = await mountSection()
    expect(w.findAll('.rs-item')).toHaveLength(1)
    expect(w.find('.rs-running').exists()).toBe(false)
  })

  // El orden es parte de lo que la regla ES, así que se cambia arrastrando la
  // fila misma: sin las flechas ↑↓ que había que apretar N veces para mover una
  // regla al final de la lista.
  describe('orden y borrado', () => {
    it('arrastrar una fila sobre otra reordena y lo persiste', async () => {
      rules = [rule({ id: 'a' }), rule({ id: 'b' })]
      const api = await import('@/features/rules/api')

      const w = await mountSection()
      const items = w.findAll('.rs-item')
      await items[1].trigger('dragstart', { dataTransfer: { setData: vi.fn() } })
      await items[0].trigger('dragover')
      await items[0].trigger('drop')

      expect(vi.mocked(api.reorderRules)).toHaveBeenCalledWith({ kind: 'global' }, ['b', 'a'])
      expect(w.findAll('.rs-id').map((e) => e.text())).toEqual(['b', 'a'])
    })

    it('soltar sobre la misma fila no llama al server', async () => {
      rules = [rule({ id: 'a' }), rule({ id: 'b' })]
      const api = await import('@/features/rules/api')

      const w = await mountSection()
      vi.mocked(api.reorderRules).mockClear()
      const items = w.findAll('.rs-item')
      await items[0].trigger('dragstart', { dataTransfer: { setData: vi.fn() } })
      await items[0].trigger('drop')

      expect(vi.mocked(api.reorderRules)).not.toHaveBeenCalled()
    })

    it('no se arrastra en un ámbito de sólo lectura', async () => {
      const api = await import('@/features/rules/api')
      vi.mocked(api.fetchRules).mockResolvedValueOnce({
        rules: [rule(), rule({ id: 'r2' })],
        readOnly: true,
      })

      const w = await mountSection()
      expect(w.find('.rs-item').attributes('draggable')).toBe('false')
      expect(w.find('.rs-drag').exists()).toBe(false)
    })

    // Sólo lectura es sólo lectura: sin camino al detalle no hay Guardar,
    // Eliminar ni orden que el server vaya a rechazar con un toast.
    it('un ámbito de sólo lectura no ofrece ningún camino a editar', async () => {
      const api = await import('@/features/rules/api')
      vi.mocked(api.fetchRules).mockResolvedValueOnce({ rules: [rule()], readOnly: true })

      const w = await mountSection()
      expect(w.findAll('button').map((b) => b.text())).not.toContain('Editar')
      expect(w.find('.editable-card--clickable').exists()).toBe(false)
    })

    // Borrar vive en el detalle: en la fila el ✕ quedaba a un pixel del gesto
    // de arrastrar, y es la única operación del listado que no se deshace.
    it('la fila no ofrece borrar', async () => {
      const w = await mountSection()
      expect(w.find('[aria-label="Eliminar"]').exists()).toBe(false)
    })
  })
})
