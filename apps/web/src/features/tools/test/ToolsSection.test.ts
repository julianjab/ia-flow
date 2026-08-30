import ToolsSection from '@/features/tools/ToolsSection.vue'
import type { ConfigScope, EditableTool, NamedAction } from '@ia-flow/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const GLOBAL: ConfigScope = { kind: 'global' }
const PROJECT: ConfigScope = { kind: 'project', projectId: 'ia-flow' }

/** Una acción http que interpola un campo del payload: es contra esto que el
 *  editor de parámetros contrasta lo que la tool declara. */
const PING: NamedAction = {
  id: 'ping-demo',
  body: {
    action: 'http',
    url: 'https://ci/deploy/{{event.payload.branch}}',
    method: 'POST',
  },
}

let editable: EditableTool[] = []
let inherited: EditableTool[] = []
let builtIns: Array<{ name: string; description: string; overridden: boolean }> = []
let actions: NamedAction[] = []
const saved: EditableTool[] = []
const deleted: string[] = []

vi.mock('@/features/tools/api', () => ({
  fetchEditableTools: vi.fn(async () => ({ editable, inherited, builtIns, readOnly: false })),
  saveEditableTool: vi.fn(async (_scope: ConfigScope, t: EditableTool) => {
    saved.push(t)
    return t
  }),
  deleteEditableTool: vi.fn(async (_scope: ConfigScope, n: string) => {
    deleted.push(n)
    return { note: 'vuelve al reiniciar' }
  }),
  fetchActions: vi.fn(async () => actions),
}))
vi.mock('@/stores/toast', () => ({
  useToastStore: () => ({ success: vi.fn(), error: vi.fn() }),
}))

async function mountSection(scope: ConfigScope = GLOBAL) {
  const w = mount(ToolsSection, { props: { scope } })
  await flushPromises()
  return w
}

beforeEach(() => {
  editable = []
  inherited = []
  builtIns = [{ name: 'bash_run', description: 'La original', overridden: false }]
  actions = [PING]
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
    // Se edita clickeando la descripción: el lápiz se fue con el InlineEdit.
    await w.find('.ie-collapsed').trigger('click')
    await w.find('textarea').setValue('Ajustada')
    await w.find('.ie-btn--ok').trigger('click')
    await flushPromises()

    expect(saved[0]).toEqual({ kind: 'override', name: 'bash_run', description: 'Ajustada' })
  })

  // La descripción es un párrafo —prompt del modelo, no una etiqueta— así que
  // el editor tiene que ser un textarea: en un input de una línea sólo se puede
  // editar por el extremo que se ve.
  it('el editor de la descripción es un textarea', async () => {
    const w = await mountSection()
    await w.find('.ie-collapsed').trigger('click')

    expect(w.find('textarea').exists()).toBe(true)
    expect(w.find('.ts-item input').exists()).toBe(false)
  })

  // Sin esto nadie sabe que el texto que lee no es el del código.
  it('marca las built-in con la descripción pisada', async () => {
    builtIns = [{ name: 'bash_run', description: 'Ajustada', overridden: true }]
    const w = await mountSection()
    expect(w.text()).toContain('ajustada')
  })

  // Revertir sólo tiene sentido sobre una descripción pisada: ofrecerlo siempre
  // sugiere que hay algo que deshacer cuando no lo hay.
  it('sólo ofrece revertir sobre las que están ajustadas', async () => {
    const sinOverride = await mountSection()
    expect(sinOverride.findAll('.ts-item .editable-card__actions button')).toHaveLength(0)

    builtIns = [{ name: 'bash_run', description: 'Ajustada', overridden: true }]
    const conOverride = await mountSection()
    expect(conOverride.findAll('.ts-item .editable-card__actions button')).toHaveLength(1)
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
    actions = []
    const w = await mountSection()
    await w.find('.ts-btn').trigger('click')
    await flushPromises()

    expect(w.text()).toContain('creá una en Acciones primero')
  })

  // El nombre de una tool es global —la lista es la misma en todos lados— pero
  // la acción que ejecuta puede ser de un proyecto: el server resuelve por id
  // sin filtrar ámbito. Ofrecer sólo las globales dejaba una acción de proyecto
  // inalcanzable desde el formulario.
  it('desde un proyecto pide sus acciones, no sólo las globales', async () => {
    const api = await import('@/features/tools/api')
    const w = await mountSection(PROJECT)

    expect(api.fetchActions).toHaveBeenCalledWith(PROJECT)
    // Y lo dice, para que nadie crea que la lista de tools está acotada.
    expect(w.text()).toContain('nombre de una tool es único en todo el daemon')
  })

  it('desde General no manda proyecto y no aclara nada', async () => {
    const api = await import('@/features/tools/api')
    const w = await mountSection(GLOBAL)

    expect(api.fetchActions).toHaveBeenCalledWith(GLOBAL)
    expect(w.text()).not.toContain('nombre de una tool es único en todo el daemon')
  })
  // ── Parámetros ───────────────────────────────────────────────────────────
  //
  // El input del modelo viaja como `event.payload` y la acción lo lee con
  // `{{event.payload.<campo>}}`: los parámetros de la tool y los placeholders
  // de su acción son los dos extremos de un mismo cable.

  it('crear con parámetros manda el inputSchema, no un JSON a mano', async () => {
    const w = await mountSection()
    await w.find('.ts-btn').trigger('click')
    await flushPromises()

    const inputs = w.findAll('.ts-form input')
    await inputs[0].setValue('deploy_staging')
    await inputs[1].setValue('Deploya a staging')
    // El campo que la acción lee, ofrecido de un click.
    await w.find('.ts-form .tp-add').trigger('click')
    await w.findAll('.ts-form-ops .ts-btn')[1].trigger('click')
    await flushPromises()

    expect(saved[0]).toEqual({
      kind: 'defined',
      name: 'deploy_staging',
      description: 'Deploya a staging',
      actionId: 'ping-demo',
      inputSchema: { type: 'object', properties: { branch: { type: 'string' } } },
    })
  })

  it('los parámetros de una tool ya creada se editan y se guardan', async () => {
    editable = [
      {
        kind: 'defined',
        name: 'deploy_staging',
        description: 'Deploya',
        actionId: 'ping-demo',
        inputSchema: { type: 'object', properties: { branch: { type: 'string' } } },
      },
    ]
    const w = await mountSection()
    await w.find('.ts-toggle').trigger('click')
    await flushPromises()

    await w.find('.tp-row input[type="checkbox"]').setValue(true)
    await w.findAll('.ts-item .ts-form-ops .ts-btn')[1].trigger('click')
    await flushPromises()

    expect((saved[0] as { inputSchema?: unknown }).inputSchema).toEqual({
      type: 'object',
      properties: { branch: { type: 'string' } },
      required: ['branch'],
    })
  })

  // Un `inputSchema` escrito por API puede decir cosas que la lista no expresa.
  // Ofrecer el editor igual lo destruiría al guardar, en silencio.
  it('un schema que el editor no representa se avisa en vez de editarse', async () => {
    editable = [
      {
        kind: 'defined',
        name: 'raro',
        description: 'X',
        actionId: 'ping-demo',
        inputSchema: { type: 'object', properties: { tags: { type: 'array' } } },
      },
    ]
    const w = await mountSection()
    await w.find('.ts-toggle').trigger('click')
    await flushPromises()

    expect(w.text()).toContain('formas que este editor no representa')
    expect(w.find('.tp-row').exists()).toBe(false)
  })

  // El guardado se frena en la sección y no sólo se marca en el editor: un
  // `properties: { '': ... }` guardado rompe el próximo run que use la tool.
  it('no guarda parámetros inválidos', async () => {
    const w = await mountSection()
    await w.find('.ts-btn').trigger('click')
    await flushPromises()

    const inputs = w.findAll('.ts-form input')
    await inputs[0].setValue('deploy_staging')
    await inputs[1].setValue('Deploya')
    // Un parámetro agregado a mano y dejado sin nombre.
    await w.find('.ts-form .tp .btn').trigger('click')
    await w.findAll('.ts-form-ops .ts-btn')[1].trigger('click')
    await flushPromises()

    expect(saved).toHaveLength(0)
  })
})
