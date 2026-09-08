import GitHubSourceForm from '@/features/projects/sources/GitHubSourceForm.vue'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

// Migró del prefijo `.ghsf-` al kit de campo con reemplazos de texto, y no
// tenía quien lo montara. Ver RepoConfigModal.test.ts para el porqué.

function mountForm(modelValue: Record<string, unknown> = {}) {
  return mount(GitHubSourceForm, {
    props: { modelValue },
    global: { stubs: { ComboBox: true, HintIcon: true } },
  })
}

describe('GitHubSourceForm', () => {
  it('monta y usa el kit, sin restos del prefijo viejo', () => {
    const w = mountForm()
    expect(w.findAll('.ff-row').length).toBeGreaterThan(0)
    expect(w.html()).not.toContain('ghsf-label')
    expect(w.html()).not.toContain('ghsf-input')
  })

  it('escribir la URL emite el config, sin perder lo que ya tenía', () => {
    // `anchorLabel` es un string suelto del config: sirve para probar que
    // tocar la URL no pisa el resto. (`workingMarker` es un objeto, no un
    // string — pasarlo mal revienta en `marker.field.trim()`.)
    const w = mountForm({ anchorLabel: 'ia-flow' })
    const input = w.findAll('input.ff-field')[0]
    input.setValue('https://github.com/orgs/acme/projects/3')
    const emitted = w.emitted('update:modelValue')?.at(-1)?.[0] as Record<string, unknown>
    expect(emitted.url).toBe('https://github.com/orgs/acme/projects/3')
    // Lo demás sobrevive: un form que pisa el resto del config al tocar un
    // campo borra configuración sin decirlo.
    expect(emitted.anchorLabel).toBe('ia-flow')
  })
})
