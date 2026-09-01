import AgentActionForm from '@/features/rules/actionForms/AgentActionForm.vue'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

// El editor de "Redirigir salidas" tiene un requisito que no se ve en el
// schema: una fila a medio escribir tiene que poder existir en la UI sin
// llegar nunca a la config. Las dos cosas fallaron cuando las filas se
// derivaban de `entry.exits`, así que las dos están cubiertas.

type Entry = Record<string, unknown> & { action: string }

function mountForm(entry: Partial<Entry> = {}) {
  return mount(AgentActionForm, {
    props: { entry: { action: 'agent', agentId: 'implementer', ...entry } as Entry },
  })
}

const rows = (w: ReturnType<typeof mountForm>) => w.findAll('.aaf-exit')
const lastPatch = (w: ReturnType<typeof mountForm>) =>
  (w.emitted('patch')?.at(-1)?.[0] ?? {}) as Record<string, unknown>

describe('AgentActionForm — redirigir salidas', () => {
  it('siembra una fila por salida ya guardada', () => {
    const w = mountForm({ exits: { success: 'QA Interna' } })
    expect(rows(w)).toHaveLength(1)
    const inputs = rows(w)[0].findAll('input')
    expect((inputs[0].element as HTMLInputElement).value).toBe('success')
    expect((inputs[1].element as HTMLInputElement).value).toBe('QA Interna')
  })

  it('lee la forma larga por su `set`', () => {
    const w = mountForm({ exits: { 'back-to-build': { set: 'Implementación' } } })
    const inputs = rows(w)[0].findAll('input')
    expect((inputs[1].element as HTMLInputElement).value).toBe('Implementación')
  })

  // El botón no hacía nada: la fila nueva nace vacía, y con las filas
  // derivadas del patch se descartaba antes de renderizarse — así que no había
  // forma de crear la PRIMERA redirección.
  it('"+ salida" agrega una fila editable', async () => {
    const w = mountForm()
    expect(rows(w)).toHaveLength(0)
    await w.find('.aaf-exit__add').trigger('click')
    expect(rows(w)).toHaveLength(1)
  })

  it('una fila a medio escribir se ve, pero no se guarda', async () => {
    const w = mountForm()
    await w.find('.aaf-exit__add').trigger('click')
    await rows(w)[0].findAll('input')[0].setValue('success')
    expect(rows(w)).toHaveLength(1)
    expect(lastPatch(w).exits).toBeUndefined()
  })

  // `resolveEffectiveExits` acepta cualquier clave que el agente declare, así
  // que un destino vacío pisaría el destino real con un status vacío.
  it('nunca guarda un destino vacío', async () => {
    const w = mountForm({ exits: { success: 'QA' } })
    await rows(w)[0].findAll('input')[1].setValue('')
    expect(lastPatch(w).exits).toBeUndefined()
  })

  it('guarda la fila cuando queda completa', async () => {
    const w = mountForm()
    await w.find('.aaf-exit__add').trigger('click')
    await rows(w)[0].findAll('input')[0].setValue('success')
    await rows(w)[0].findAll('input')[1].setValue('QA Interna')
    expect(lastPatch(w).exits).toEqual({ success: 'QA Interna' })
  })

  it('borrar la última fila deja `exits` en undefined, no en {}', async () => {
    const w = mountForm({ exits: { success: 'QA' } })
    await w.find('.aaf-exit__del').trigger('click')
    expect(rows(w)).toHaveLength(0)
    expect(lastPatch(w).exits).toBeUndefined()
  })
})

describe('AgentActionForm — brief', () => {
  it('un brief vacío se manda como undefined', async () => {
    const w = mountForm({ brief: 'algo' })
    await w.find('textarea').setValue('')
    expect(lastPatch(w).brief).toBeUndefined()
  })
})
