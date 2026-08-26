import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import GitHubSourceForm from '../sources/GitHubSourceForm.vue'

// El catálogo que publica la fuente (`GET /source/fields`) — el mismo que
// alimentan el editor de outcomes y el de condiciones `when`.
const FIELDS = [
  { name: 'Status', dataType: 'SINGLE_SELECT', options: ['build', 'review'] },
  { name: 'Working', dataType: 'SINGLE_SELECT', options: ['Yes'] },
  { name: 'Labels', dataType: 'MULTI_SELECT', options: ['bug'] },
]

function mountForm(config: Record<string, unknown> = {}, sourceFields = FIELDS) {
  return mount(GitHubSourceForm, { props: { modelValue: config, sourceFields } })
}

const lastEmit = (w: ReturnType<typeof mountForm>) =>
  (w.emitted('update:modelValue')?.at(-1)?.[0] ?? {}) as Record<string, any>

describe('GitHubSourceForm — marca de agente trabajando', () => {
  it('ofrece los campos del board en vez de pedirlos escritos a mano', () => {
    const select = mountForm().get('[data-testid="working-marker-field"]')

    expect(select.element.tagName).toBe('SELECT')
    expect(select.findAll('option').map((o) => o.text())).toContain('Working')
  })

  // `applyTransition` ya escribe Status en cada outcome: las dos escrituras se
  // pisarían, y el server rechaza la combinación al guardar.
  it('no ofrece Status como campo de la marca', () => {
    const options = mountForm()
      .get('[data-testid="working-marker-field"]')
      .findAll('option')
      .map((o) => o.text())

    expect(options).not.toContain('Status')
  })

  it('sin catálogo cae a input libre — un proyecto nuevo todavía no tiene', () => {
    const field = mountForm({}, []).get('[data-testid="working-marker-field"]')

    expect(field.element.tagName).toBe('INPUT')
  })

  it('elegir campo limpia los valores: son opciones de otra columna', async () => {
    const wrapper = mountForm({ workingMarker: { field: 'Working', on: 'Yes', off: '' } })

    await wrapper.get('[data-testid="working-marker-field"]').setValue('Labels')

    expect(lastEmit(wrapper).workingMarker).toEqual({ field: 'Labels', on: '', off: '' })
  })

  it('ofrece las opciones del campo elegido como valor', () => {
    const selects = mountForm({
      workingMarker: { field: 'Working', on: 'Yes', off: '' },
    }).findAll('select')

    // campo + ocupado + libre
    expect(selects.length).toBe(3)
    expect(selects[1].findAll('option').map((o) => o.text())).toContain('Yes')
  })

  // Sobre Labels la marca es UNA label (puesta = ocupado, sacada = libre), así
  // que hay un solo control y los tokens con signo los deriva el form: pedirlos
  // a mano invita al `off` vacío, que dejaría la marca puesta para siempre.
  it('sobre Labels pide una sola label y deriva los dos tokens', async () => {
    const wrapper = mountForm({ workingMarker: { field: 'Labels', on: '', off: '' } })

    await wrapper.get('[data-testid="working-marker-label"] input').setValue('ia-flow:working')

    expect(lastEmit(wrapper).workingMarker).toEqual({
      field: 'Labels',
      on: '+ia-flow:working',
      off: '-ia-flow:working',
    })
  })

  // La label de la marca normalmente NO existe todavía en el board: la crea el
  // propio agente al aplicarla. Un <select> cerrado la haría inelegible.
  it('deja escribir una label que el board todavía no tiene', () => {
    const control = mountForm({
      workingMarker: { field: 'Labels', on: '', off: '' },
    }).get('[data-testid="working-marker-label"] input')

    expect(control.element.tagName).toBe('INPUT')
  })

  it('rehidrata la label sin el signo', () => {
    const input = mountForm({
      workingMarker: { field: 'Labels', on: '+ia-flow:working', off: '-ia-flow:working' },
    }).get('[data-testid="working-marker-label"] input')

    expect((input.element as HTMLInputElement).value).toBe('ia-flow:working')
  })

  it('destildar la marca la apaga explícitamente (null), no la deja implícita', async () => {
    const wrapper = mountForm()

    await wrapper.get('[data-testid="working-marker-toggle"]').setValue(false)

    expect(lastEmit(wrapper).workingMarker).toBeNull()
  })
})

// El catálogo de `Labels` son las labels EN USO en el board: vacío no es "no
// coincide ninguna", es "no hay ninguna contra qué comparar". El motivo tiene
// que leerse distinto aunque en los dos casos se pueda escribir igual.
describe('GitHubSourceForm — labels vacías', () => {
  const openLabelMenu = async (fields: typeof FIELDS) => {
    const wrapper = mountForm({ workingMarker: { field: 'Labels', on: '', off: '' } }, fields)
    await wrapper.get('[data-testid="working-marker-label"] input').trigger('focus')
    return wrapper
  }

  it('un board sin labels lo dice, en vez de "ninguna coincide"', async () => {
    const wrapper = await openLabelMenu([{ name: 'Labels', dataType: 'MULTI_SELECT', options: [] }])

    expect(wrapper.text()).toContain('El board todavía no usa ninguna label')
  })

  it('con labels en el board, el vacío sí es "ninguna coincide"', async () => {
    const wrapper = await openLabelMenu(FIELDS)
    await wrapper.get('[data-testid="working-marker-label"] input').setValue('zzz-no-existe')

    expect(wrapper.text()).toContain('Ninguna label del board coincide')
  })
})
