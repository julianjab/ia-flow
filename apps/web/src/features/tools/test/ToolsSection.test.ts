import ToolsSection from '@/features/tools/ToolsSection.vue'
import type { EditableTool } from '@ia-flow/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let editable: EditableTool[] = []
let builtIns: Array<{ name: string; description: string; overridden: boolean }> = []
const saved: EditableTool[] = []
const deleted: string[] = []

vi.mock('@/features/tools/api', () => ({
  fetchEditableTools: vi.fn(async () => ({ editable, builtIns, readOnly: false })),
  saveEditableTool: vi.fn(async (t: EditableTool) => {
    saved.push(t)
    return t
  }),
  deleteEditableTool: vi.fn(async (n: string) => {
    deleted.push(n)
    return { note: 'vuelve al reiniciar' }
  }),
  fetchGlobalActionIds: vi.fn(async () => ['ping-demo']),
}))
vi.mock('@/stores/toast', () => ({
  useToastStore: () => ({ success: vi.fn(), error: vi.fn() }),
}))

async function mountSection() {
  const w = mount(ToolsSection)
  await flushPromises()
  return w
}

beforeEach(() => {
  editable = []
  builtIns = [{ name: 'bash_run', description: 'La original', overridden: false }]
  saved.length = 0
  deleted.length = 0
})

describe('ToolsSection', () => {
  // Las dos listas están separadas porque lo editable es distinto, y esa
  // diferencia ES la feature.
  it('separa las definidas de las built-in', async () => {
    editable = [{ kind: 'defined', name: 'deploy_staging', description: 'Deploya', actionId: 'a1' }]
    const w = await mountSection()

    expect(w.text()).toContain('Definidas')
    expect(w.text()).toContain('Built-in')
    expect(w.text()).toContain('deploy_staging')
    expect(w.text()).toContain('bash_run')
  })

  // Una tool definida muestra qué acción ejecuta: sin eso, "deploy_staging" no
  // dice qué va a pasar.
  it('la definida muestra la acción que referencia', async () => {
    editable = [{ kind: 'defined', name: 'x_tool', description: 'X', actionId: 'ping-demo' }]
    const w = await mountSection()
    expect(w.find('.ts-action').text()).toContain('ping-demo')
  })

  // De una built-in sólo se ajusta la descripción, y se guarda como `override`
  // — nunca como `defined`, que la taparía.
  it('editar una built-in guarda un override, no una definida', async () => {
    const w = await mountSection()
    await w.find('.ts-item .ts-icon').trigger('click')
    await w.find('.ts-item input').setValue('Ajustada')
    await w.findAll('.ts-item .ts-btn')[0].trigger('click')
    await flushPromises()

    expect(saved[0]).toEqual({ kind: 'override', name: 'bash_run', description: 'Ajustada' })
  })

  // Sin esto nadie sabe que el texto que lee no es el del código.
  it('marca las built-in con la descripción pisada', async () => {
    builtIns = [{ name: 'bash_run', description: 'Ajustada', overridden: true }]
    const w = await mountSection()
    expect(w.text()).toContain('ajustada')
  })

  it('sólo ofrece revertir sobre las que están ajustadas', async () => {
    const sinOverride = await mountSection()
    expect(sinOverride.findAll('.ts-item .ts-icon')).toHaveLength(1)

    builtIns = [{ name: 'bash_run', description: 'Ajustada', overridden: true }]
    const conOverride = await mountSection()
    expect(conOverride.findAll('.ts-item .ts-icon')).toHaveLength(2)
  })

  it('crear una definida manda nombre, descripción y acción', async () => {
    const w = await mountSection()
    await w.find('.ts-btn').trigger('click')
    await flushPromises()

    const inputs = w.findAll('.ts-form input')
    await inputs[0].setValue('deploy_staging')
    await inputs[1].setValue('Deploya a staging')
    await w.findAll('.ts-form-ops .ts-btn')[1].trigger('click')
    await flushPromises()

    expect(saved[0]).toEqual({
      kind: 'defined',
      name: 'deploy_staging',
      description: 'Deploya a staging',
      actionId: 'ping-demo',
    })
  })

  // Un alta sin acción crearía una tool que no ejecuta nada.
  it('sin acciones globales, lo dice en vez de dejar crear a ciegas', async () => {
    const api = await import('@/features/tools/api')
    vi.mocked(api.fetchGlobalActionIds).mockResolvedValueOnce([])

    const w = await mountSection()
    await w.find('.ts-btn').trigger('click')
    await flushPromises()

    expect(w.text()).toContain('creá una en Pipeline primero')
  })
})
